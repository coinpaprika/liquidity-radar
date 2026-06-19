// LiquidityRadar live feed: Cloudflare Worker + Durable Object.
//
// Worker: edge-cached landing page (/) + live JSON (/api/live) + /health; a
// cron bootstraps the DO and keeps it alive. RadarDO: holds the multiplexed
// SSE subscription, rebuilds its watchlist hourly from the most active pools,
// confirms drains persist before posting, gates them, and tracks the
// "fast risers drain" hypothesis.
//
// Rug feed: posts DRAINS only, and only after a drain has held for
// DRAIN_CONFIRM_SECONDS (a drop that refills is suppressed). POST_ADDS=1 to
// also post adds. Sending is fail-closed: without WEBHOOK_URL nothing leaves.

import {
  DATA_CREDIT,
  createRadar,
  formatAlert,
  validateRadarConfig,
  type Alert,
  type Radar,
  type RadarConfig,
  type ReserveEvent,
  type WatchEntry,
} from "../../core/src/index.js";
import { isLive, postAlert, type SinkEnv } from "./webhook.js";
import { LANDING_HTML } from "./page.js";
import bundledWatchlist from "../../watchlist.json";

export interface Env extends SinkEnv {
  RADAR: DurableObjectNamespace;
  WATCHLIST?: string; // JSON RadarConfig override; if unset, the dynamic top-pools list is used
  POST_COOLDOWN_MINUTES?: string;
  POSTS_PER_HOUR?: string;
  POST_SUFFIX?: string;
  DRAIN_CONFIRM_SECONDS?: string; // a drain must persist this long before sending (default 90)
  POST_ADDS?: string; // "1" to also post liquidity adds (default off)
  POOLS_PER_CHAIN?: string; // dynamic watchlist size per chain (default 40; see the per-IP stream cap)
}

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const ALARM_INTERVAL_MS = 30_000;
const PERSIST_FRACTION = 0.5; // a confirmed drain is still down to <= this fraction of pre-drain
const SERIES_CAP = 120; // rolling reserve points kept per pool for the live chart
const REFRESH_MS = 60 * 60 * 1000; // rebuild the watchlist hourly
// Pools per chain in the dynamic list. The free keyless stream caps concurrent
// connections per IP at 3 (probed live 2026-06-19: exactly 3 of N POSTs return
// 200, the rest 429 "stream limit exceeded"), and the radar packs 25 subs per
// connection. So 3 connections = ~75 pools is the free ceiling. 37/chain (74
// total) sits exactly at 3 connections with a 1-pool margin; 76+ tips into a
// 4th connection and 429s. Raise POOLS_PER_CHAIN only with an enterprise key
// (higher stream limit) or when the load is sharded across IPs.
const DEFAULT_PER_CHAIN = 37;
const DYNAMIC_CHAINS = ["solana", "ethereum"];
const RUG_MIN_RISE = 0.5; // liquidity up >= 50% over the window
const RUG_MAX_TVL = 750_000; // small pool; blue-chips don't rug
const HYP_CAP = 800; // tracked subjects per hypothesis bucket
const STABLES = new Set([
  "USDC", "USDT", "USDG", "PYUSD", "USDS", "DAI", "USDE", "USDM", "FDUSD",
  "TUSD", "USD₮0", "USDT0", "USD₮", "BUSD", "FRAX", "GUSD", "LUSD", "USDD", "USDC.E",
]);

function envInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const FALLBACK_WATCHLIST = bundledWatchlist as unknown as RadarConfig;

interface RecentEntry {
  alert: Alert;
  posted: boolean;
  reason?: string;
}
interface Stats {
  drains: number;
  sent: number;
  suppressed: number;
  sinceMs: number;
}
interface Pending {
  alert: Alert;
  prevReserveUsd: number;
  atMs: number;
}
interface Gate {
  posted: Record<string, number>;
  lastBySubject: Record<string, number>;
  recentPosts: number[];
  pausedUntilMs: number;
  lastPostAtMs?: number;
  lastPostError?: string;
}
// hypothesis buckets, keyed by subject (pool id), naturally deduped
type HypMark = { label: string; chain: string; t: number; pct: number };

const RECENT_CAP = 150;
const emptyGate = (): Gate => ({ posted: {}, lastBySubject: {}, recentPosts: [], pausedUntilMs: 0 });
const emptyStats = (now: number): Stats => ({ drains: 0, sent: 0, suppressed: 0, sinceMs: now });

function escapeHtml(v: unknown): string {
  return String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
function subjectReserve(e: ReserveEvent): { subject: string; reserve: number } {
  return e.type === "pool_reserves"
    ? { subject: e.pool_id, reserve: e.total_reserve_usd }
    : { subject: e.token_id, reserve: e.reserve_usd };
}
function capObject<T>(obj: Record<string, T & { t: number }>, cap: number): Record<string, T & { t: number }> {
  const keys = Object.keys(obj);
  if (keys.length <= cap) return obj;
  keys.sort((a, b) => obj[a].t - obj[b].t);
  for (const k of keys.slice(0, keys.length - cap)) delete obj[k];
  return obj;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (!["/", "/api/live", "/status"].includes(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    const cache = caches.default;
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await env.RADAR.get(env.RADAR.idFromName("singleton")).fetch(req);
    if (res.ok) ctx.waitUntil(cache.put(req, res.clone()));
    return res;
  },

  async scheduled(_e: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      env.RADAR.get(env.RADAR.idFromName("singleton")).fetch("https://radar.internal/__start"),
    );
  },
};

export class RadarDO {
  private state: DurableObjectState;
  private env: Env;
  private radar?: Radar;
  private running = false;
  private lastEventMs = 0;
  private lastRefreshMs = 0;
  private configSource = "(not loaded yet)";
  private thresholds = "";
  private issues: string[] = [];
  private lastReserve = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private series = new Map<string, { t: number; r: number }[]>();
  private meta = new Map<string, { label: string; chain: string }>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    await this.ensureRunning();
    const url = new URL(req.url);
    if (url.pathname === "/__start") return new Response("started", { status: 200 });
    if (url.pathname === "/api/live") {
      return new Response(JSON.stringify(await this.buildLive()), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=1" },
      });
    }
    if (url.pathname === "/") {
      return new Response(LANDING_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=10" },
      });
    }
    if (this.issues.length === 0) this.issues = (await this.state.storage.get<string[]>("issues")) ?? [];
    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    const gate = (await this.state.storage.get<Gate>("gate")) ?? emptyGate();
    const stats = (await this.state.storage.get<Stats>("stats")) ?? null;
    return new Response(this.renderStatus(recent, gate, stats), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" },
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    if (Date.now() - this.lastRefreshMs > REFRESH_MS) {
      const changed = await this.refreshWatchlist();
      if (changed && this.running) {
        this.radar?.stop(); // resubscribe with the fresh list on the next ensureRunning
        this.running = false;
      }
    }
    await this.ensureRunning();
    await this.updateHypothesis();
    await this.resolvePending();
  }

  private async ensureRunning(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
    if (this.running) return;
    this.running = true;

    const config = await this.activeConfig();
    const confirmS = envInt(this.env.DRAIN_CONFIRM_SECONDS, 90);
    this.thresholds =
      `alerts on drains ≥$${(config.minUsd ?? 25000).toLocaleString("en-US")} and ≥${((config.pctThreshold ?? 0.1) * 100).toFixed(0)}% of reserve, confirmed over ${confirmS}s`;

    const epoch = `${this.thresholds} | ${config.watch.length}p`;
    const prevEpoch = (await this.state.storage.get<string>("epoch")) ?? "";
    if (prevEpoch !== epoch) {
      await this.state.storage.put("epoch", epoch);
      await this.state.storage.delete("recent");
      await this.state.storage.delete("stats");
    }

    const radar = createRadar(config, {
      onAlert: (alert) => this.handleAlert(alert),
      onEvent: (event, entry) => {
        this.lastEventMs = Date.now();
        const { subject, reserve } = subjectReserve(event);
        if (!subject || !Number.isFinite(reserve)) return;
        this.lastReserve.set(subject, reserve);
        const arr = this.series.get(subject) ?? [];
        arr.push({ t: Math.floor(Date.now() / 1000), r: reserve });
        if (arr.length > SERIES_CAP) arr.shift();
        this.series.set(subject, arr);
        this.meta.set(subject, { label: entry.label ?? subject, chain: event.chain });
      },
      onFatal: (err, entries) =>
        this.note(`subscription stopped (${entries.map((e) => e.label ?? e.address).join(", ")}): ${err.message}`),
      onWarning: (msg) => this.note(msg),
    });
    this.radar = radar;
    radar
      .start()
      .catch((err) => this.note(`radar crashed: ${String(err)}`))
      .finally(() => {
        radar.stop();
        if (this.radar === radar) this.radar = undefined;
        this.running = false;
      });
  }

  // Watchlist priority: WATCHLIST var override -> dynamic top-pools -> bundled.
  private async activeConfig(): Promise<RadarConfig> {
    if (this.env.WATCHLIST) {
      try {
        const parsed = JSON.parse(this.env.WATCHLIST);
        const errs = validateRadarConfig(parsed);
        if (errs.length) throw new Error(errs.join("; "));
        this.configSource = `WATCHLIST var (${parsed.watch.length} entries)`;
        return parsed as RadarConfig;
      } catch (err) {
        this.note(`WATCHLIST invalid, falling back: ${String(err)}`);
      }
    }
    let dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    if (!dyn || !dyn.length) {
      await this.refreshWatchlist();
      dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    }
    if (dyn && dyn.length) {
      this.configSource = `dynamic top pools (${dyn.length}, refreshed hourly)`;
      return { minUsd: FALLBACK_WATCHLIST.minUsd, pctThreshold: FALLBACK_WATCHLIST.pctThreshold, watch: dyn };
    }
    this.configSource = `bundled watchlist.json (${FALLBACK_WATCHLIST.watch.length} pools)`;
    return FALLBACK_WATCHLIST;
  }

  // Rebuild from the most active pools per chain, dropping stablecoin pairs and
  // orderbook DEXs (whose reserves blip). Returns true if the set changed.
  private async refreshWatchlist(): Promise<boolean> {
    const perChain = envInt(this.env.POOLS_PER_CHAIN, DEFAULT_PER_CHAIN);
    const isStablePair = (syms: string[]) =>
      syms.length === 2 && syms.every((s) => STABLES.has(String(s).toUpperCase()));
    const out: WatchEntry[] = [];
    for (const chain of DYNAMIC_CHAINS) {
      let kept = 0;
      for (const page of [0, 1]) {
        if (kept >= perChain) break;
        let pools: any[] = [];
        try {
          const r = await fetch(
            `https://api.dexpaprika.com/networks/${chain}/pools?page=${page}&limit=100&order_by=volume_usd&sort=desc`,
            { headers: { accept: "application/json" } },
          );
          if (!r.ok) continue;
          pools = ((await r.json()) as { pools?: any[] })?.pools ?? [];
        } catch (e) {
          this.note(`watchlist refresh ${chain} p${page}: ${String(e)}`);
          continue;
        }
        for (const p of pools) {
          if (kept >= perChain) break;
          const dex = String(p.dex_name ?? p.dex_id ?? "?");
          if (/manifest/i.test(dex)) continue;
          const syms = (p.tokens ?? []).map((t: any) => t.symbol ?? "?").slice(0, 2);
          if (isStablePair(syms)) continue;
          out.push({ method: "pool_reserves", chain, address: p.id, label: `${syms.join("/")} (${dex})` });
          kept++;
        }
      }
    }
    if (out.length < 20) {
      this.note(`watchlist refresh got only ${out.length} pools; keeping previous`);
      return false;
    }
    const prev = (await this.state.storage.get<WatchEntry[]>("dynamicWatchlist")) ?? [];
    const changed = prev.map((w) => w.address).join() !== out.map((w) => w.address).join();
    await this.state.storage.put("dynamicWatchlist", out);
    this.lastRefreshMs = Date.now();
    return changed;
  }

  private async handleAlert(alert: Alert): Promise<void> {
    this.lastEventMs = Date.now();
    this.lastReserve.set(alert.subject, alert.reserveUsd);
    if (alert.kind === "add") {
      if (this.env.POST_ADDS === "1") await this.commit(alert);
      return;
    }
    if (!this.pending.has(alert.subject)) {
      this.pending.set(alert.subject, { alert, prevReserveUsd: alert.prevReserveUsd, atMs: Date.now() });
    }
  }

  private async resolvePending(): Promise<void> {
    const now = Date.now();
    const confirmMs = envInt(this.env.DRAIN_CONFIRM_SECONDS, 90) * 1000;
    for (const [subject, p] of [...this.pending]) {
      if (now - p.atMs < confirmMs) continue;
      this.pending.delete(subject);
      const cur = this.lastReserve.get(subject);
      const stillDrained = cur === undefined ? true : cur <= p.prevReserveUsd * PERSIST_FRACTION;
      if (stillDrained) {
        await this.commit(p.alert);
      } else {
        await this.record(p.alert, false, "suppressed: refilled");
        await this.bumpStats({ drains: 1, suppressed: 1 });
      }
    }
  }

  private async commit(alert: Alert): Promise<void> {
    const now = Date.now();
    const gate = (await this.state.storage.get<Gate>("gate")) ?? emptyGate();
    for (const [k, ts] of Object.entries(gate.posted)) if (now - ts > DEDUP_TTL_MS) delete gate.posted[k];
    gate.recentPosts = gate.recentPosts.filter((t) => now - t < 60 * 60 * 1000);

    const cooldownMs = envInt(this.env.POST_COOLDOWN_MINUTES, 30) * 60 * 1000;
    const capPerHour = envInt(this.env.POSTS_PER_HOUR, 6);
    const key = `${alert.subject}:${alert.block}:${alert.kind}`;
    let reason: string | undefined;
    if (gate.posted[key]) reason = "duplicate";
    else if (now < gate.pausedUntilMs) reason = "rate-limited by webhook";
    else if (now - (gate.lastBySubject[alert.subject] ?? 0) < cooldownMs) reason = "subject cooldown";
    else if (gate.recentPosts.length >= capPerHour) reason = "hourly cap";

    if (!reason) {
      gate.posted[key] = now;
      gate.lastBySubject[alert.subject] = now;
      gate.recentPosts.push(now);
      await this.state.storage.put("gate", gate);
      const suffix = this.env.POST_SUFFIX !== undefined ? this.env.POST_SUFFIX : `\n\n${DATA_CREDIT}`;
      const result = await postAlert(formatAlert(alert) + suffix, alert, this.env);
      if (result.ok) {
        gate.lastPostAtMs = now;
        delete gate.lastPostError;
      } else {
        gate.lastPostError = result.error;
        if (result.rateLimitedUntilMs) gate.pausedUntilMs = result.rateLimitedUntilMs;
        this.note(`webhook send failed: ${result.error ?? "unknown"}`);
      }
      await this.state.storage.put("gate", gate);
    }
    await this.record(alert, !reason, reason);
    await this.bumpStats({ drains: 1, sent: reason ? 0 : 1 });
    if (alert.kind === "drain") {
      const dr = (await this.state.storage.get<Record<string, HypMark>>("hyp_dr")) ?? {};
      dr[alert.subject] = { label: alert.label ?? alert.subject, chain: alert.chain, t: now, pct: alert.pct };
      await this.state.storage.put("hyp_dr", capObject(dr, HYP_CAP));
    }
  }

  private async record(alert: Alert, posted: boolean, reason?: string): Promise<void> {
    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    recent.unshift({ alert, posted, reason });
    await this.state.storage.put("recent", recent.slice(0, RECENT_CAP));
  }

  private async bumpStats(d: { drains?: number; sent?: number; suppressed?: number }): Promise<void> {
    const s = (await this.state.storage.get<Stats>("stats")) ?? emptyStats(Date.now());
    s.drains += d.drains ?? 0;
    s.sent += d.sent ?? 0;
    s.suppressed += d.suppressed ?? 0;
    await this.state.storage.put("stats", s);
  }

  // Pools currently matching the quick-scam profile (steep rise + small TVL).
  private currentRugWatch(): { subject: string; label: string; chain: string; changePct: number; reserveUsd: number }[] {
    const out: { subject: string; label: string; chain: string; changePct: number; reserveUsd: number }[] = [];
    for (const [subject, pts] of this.series) {
      if (pts.length < 2) continue;
      const first = pts[0].r;
      const last = pts[pts.length - 1].r;
      if (first <= 0) continue;
      const changePct = (last - first) / first;
      if (changePct >= RUG_MIN_RISE && last <= RUG_MAX_TVL) {
        const m = this.meta.get(subject) ?? { label: subject, chain: "?" };
        out.push({ subject, label: m.label, chain: m.chain, changePct, reserveUsd: last });
      }
    }
    return out.sort((a, b) => b.changePct - a.changePct);
  }

  // Record pools that enter the rug-watch profile (the hypothesis: do these drain?).
  private async updateHypothesis(): Promise<void> {
    const flagged = this.currentRugWatch();
    if (!flagged.length) return;
    const rw = (await this.state.storage.get<Record<string, HypMark>>("hyp_rw")) ?? {};
    let changed = false;
    for (const f of flagged) {
      if (!rw[f.subject]) {
        rw[f.subject] = { label: f.label, chain: f.chain, t: Date.now(), pct: f.changePct };
        changed = true;
      }
    }
    if (changed) await this.state.storage.put("hyp_rw", capObject(rw, HYP_CAP));
  }

  private async buildHypothesis(): Promise<{ flagged: number; flaggedDrained: number; rate: number; totalDrains: number }> {
    const rw = (await this.state.storage.get<Record<string, HypMark>>("hyp_rw")) ?? {};
    const dr = (await this.state.storage.get<Record<string, HypMark>>("hyp_dr")) ?? {};
    const flaggedKeys = Object.keys(rw);
    const drainedKeys = new Set(Object.keys(dr));
    const flaggedDrained = flaggedKeys.filter((k) => drainedKeys.has(k)).length;
    return {
      flagged: flaggedKeys.length,
      flaggedDrained,
      rate: flaggedKeys.length ? flaggedDrained / flaggedKeys.length : 0,
      totalDrains: drainedKeys.size,
    };
  }

  private async buildLive(): Promise<unknown> {
    const now = Date.now();
    const movers: { label: string; chain: string; changePct: number; reserveUsd: number; series: { t: number; r: number }[] }[] = [];
    for (const [subject, pts] of this.series) {
      if (pts.length < 2) continue;
      const first = pts[0].r;
      const last = pts[pts.length - 1].r;
      if (first <= 0) continue;
      const m = this.meta.get(subject) ?? { label: subject, chain: "?" };
      movers.push({ label: m.label, chain: m.chain, changePct: (last - first) / first, reserveUsd: last, series: pts });
    }
    movers.sort((a, b) => b.changePct - a.changePct);
    const risers = movers.filter((m) => m.changePct > 0.0005);
    const hero = risers[0] ?? movers[0] ?? null;
    const rugWatch = this.currentRugWatch()
      .slice(0, 8)
      .map((m) => ({ label: m.label, chain: m.chain, changePct: m.changePct, reserveUsd: m.reserveUsd }));
    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    const draining = recent
      .filter((r) => r.alert.kind === "drain" && r.reason !== "suppressed: refilled")
      .slice(0, 8)
      .map((r) => ({ label: r.alert.label ?? r.alert.subject, chain: r.alert.chain, deltaUsd: r.alert.deltaUsd, pct: r.alert.pct, block: r.alert.block, t: r.alert.timestamp }));
    const stats = (await this.state.storage.get<Stats>("stats")) ?? emptyStats(now);
    return {
      now,
      watching: this.meta.size,
      hero: hero ? { label: hero.label, chain: hero.chain, changePct: hero.changePct, series: hero.series.map((p) => ({ t: p.t, r: Math.round(p.r) })) } : null,
      rising: risers.slice(0, 8).map((m) => ({ label: m.label, chain: m.chain, changePct: m.changePct, reserveUsd: m.reserveUsd })),
      rugWatch,
      draining,
      hypothesis: await this.buildHypothesis(),
      stats: { drains: stats.drains, sent: stats.sent, suppressed: stats.suppressed },
    };
  }

  private note(msg: string): void {
    console.error(msg);
    this.issues = [`${new Date().toISOString()} ${msg}`, ...this.issues].slice(0, 10);
    void this.state.storage.put("issues", this.issues);
  }

  private renderStatus(recent: RecentEntry[], gate: Gate, stats: Stats | null): string {
    const now = Date.now();
    const live = isLive(this.env);
    const mode = live ? "live, sending drains to webhook" : "watch-only (no WEBHOOK_URL)";
    const lastEvent = this.lastEventMs > 0 ? `${Math.round((now - this.lastEventMs) / 1000)}s ago` : "none yet";
    const lastPost = gate.lastPostAtMs ? new Date(gate.lastPostAtMs).toISOString() : "never";
    const sentLabel = live ? "sent" : "would have sent";
    const totals = stats
      ? `${stats.drains} confirmed drains · ${stats.sent} ${sentLabel} · ${stats.suppressed} suppressed, since ${new Date(stats.sinceMs).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "no drains yet";
    const paused = now < gate.pausedUntilMs
      ? `<p><strong>⏸ sending paused until ${escapeHtml(new Date(gate.pausedUntilMs).toISOString())}</strong></p>` : "";
    const postError = gate.lastPostError ? `<p>last send error: <code>${escapeHtml(gate.lastPostError)}</code></p>` : "";
    const issues = this.issues.length
      ? `<h2>Recent issues</h2><ul>${this.issues.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("")}</ul>` : "";
    const rows = recent
      .map((r) => {
        const a = r.alert;
        const drain = a.kind === "drain";
        const icon = a.scope === "pool" ? (drain ? "🚨" : "🟢") : drain ? "📉" : "📈";
        const amount = `${a.deltaUsd < 0 ? "-" : "+"}$${Math.abs(Math.round(a.deltaUsd)).toLocaleString("en-US")}`;
        const pctText = isFinite(a.pct) ? `${(a.pct * 100).toFixed(1)}%` : "new pool";
        const when = new Date(a.timestamp * 1000).toISOString().slice(5, 16).replace("T", " ");
        const tag = r.posted ? sentLabel : `skipped: ${r.reason}`;
        return `<li style="margin:10px 0"><code>${escapeHtml(when)} UTC</code><br>${icon} ${escapeHtml(a.label ?? a.subject)} on ${escapeHtml(a.chain)} · ${escapeHtml(amount)} (${escapeHtml(pctText)}) · block ${escapeHtml(a.block)} · <em>${escapeHtml(tag)}</em></li>`;
      })
      .join("\n");
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>LiquidityRadar status</title>
<body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px">
<h1>LiquidityRadar status</h1>
<p>mode: <strong>${escapeHtml(mode)}</strong> · watchlist: ${escapeHtml(this.configSource)}<br>
${escapeHtml(this.thresholds)}<br>last reserve event: ${escapeHtml(lastEvent)} · last sent: ${escapeHtml(lastPost)}<br>
<strong>${escapeHtml(totals)}</strong></p>
${paused}${postError}
<h2>Recent drains</h2>
<ul style="list-style:none;padding:0">${rows || "<li>nothing caught yet</li>"}</ul>
${issues}
<p style="color:#666;margin-top:24px"><a href="/">← live dashboard</a> · <a href="https://github.com/coinpaprika/liquidity-radar">source</a></p>
</body>`;
  }
}
