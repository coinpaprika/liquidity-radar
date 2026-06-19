// LiquidityRadar live feed: Cloudflare Worker + Durable Object.
//
// Worker: edge-cached public status page + /health; a cron trigger bootstraps
// the Durable Object after deploy and keeps it alive with no visitors.
// RadarDO: holds the multiplexed SSE subscription, confirms drains persist,
// gates them (dedup, per-subject cooldown, hourly cap, 429 pauses), sends to
// your webhook, renders the status page.
//
// This is a rug feed: it posts DRAINS only, and only after a drain has held
// for DRAIN_CONFIRM_SECONDS. A drop that refills within the window (a data
// blip, an orderbook DEX momentarily reading near-zero, a JIT cycle) is
// suppressed, so the feed never cries wolf on a healthy pool. Set POST_ADDS=1
// to also post liquidity adds.
//
// Sending is fail-closed: without WEBHOOK_URL nothing leaves the worker;
// catches just accumulate on the status page.

import {
  DATA_CREDIT,
  createRadar,
  formatAlert,
  validateRadarConfig,
  type Alert,
  type Radar,
  type RadarConfig,
  type ReserveEvent,
} from "../../core/src/index.js";
import { isLive, postAlert, type SinkEnv } from "./webhook.js";
import { LANDING_HTML } from "./page.js";
import bundledWatchlist from "../../watchlist.json";

export interface Env extends SinkEnv {
  RADAR: DurableObjectNamespace;
  WATCHLIST?: string; // JSON RadarConfig (same shape as watchlist.json)
  POST_COOLDOWN_MINUTES?: string; // per-subject cooldown (default 30)
  POSTS_PER_HOUR?: string; // global cap (default 6)
  POST_SUFFIX?: string; // appended to every alert; "" disables the default credit
  DRAIN_CONFIRM_SECONDS?: string; // a drain must persist this long before sending (default 90)
  POST_ADDS?: string; // "1" to also post liquidity adds (default off: this is a rug feed)
}

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const ALARM_INTERVAL_MS = 30_000;
// after the confirm window, a drain counts as real if the reserve is still
// below this fraction of its pre-drain level (else it refilled = transient)
const PERSIST_FRACTION = 0.5;

function envInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const FALLBACK_WATCHLIST = bundledWatchlist as unknown as RadarConfig;

interface RecentEntry {
  alert: Alert;
  posted: boolean;
  reason?: string; // why a catch was not sent (suppressed, duplicate, cooldown, cap, pause)
}

interface Stats {
  drains: number; // drains that resolved (sent + suppressed + gate-skipped)
  sent: number; // drains that passed the gate and were sent
  suppressed: number; // drains that refilled within the window (transient)
  sinceMs: number;
}

interface Pending {
  alert: Alert;
  prevReserveUsd: number;
  atMs: number;
}

const RECENT_CAP = 150;
const SERIES_CAP = 120; // rolling reserve points kept per pool for the live chart

interface Gate {
  posted: Record<string, number>;
  lastBySubject: Record<string, number>;
  recentPosts: number[];
  pausedUntilMs: number;
  lastPostAtMs?: number;
  lastPostError?: string;
}

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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (!["/", "/api/live", "/status"].includes(url.pathname)) {
      return new Response("not found", { status: 404 });
    }

    // edge-cache so many viewers polling /api/live hit cache, not the single DO
    const cache = caches.default;
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await env.RADAR.get(env.RADAR.idFromName("singleton")).fetch(req);
    if (res.ok) ctx.waitUntil(cache.put(req, res.clone()));
    return res;
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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
  private configSource = "(not loaded yet)";
  private thresholds = "";
  private issues: string[] = [];
  private lastReserve = new Map<string, number>(); // subject -> current reserve USD
  private pending = new Map<string, Pending>(); // subject -> drain awaiting confirmation
  private series = new Map<string, { t: number; r: number }[]>(); // rolling reserves for the live chart
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

    // /status — operator debug view
    if (this.issues.length === 0) {
      this.issues = (await this.state.storage.get<string[]>("issues")) ?? [];
    }
    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    const gate = (await this.state.storage.get<Gate>("gate")) ?? emptyGate();
    const stats = (await this.state.storage.get<Stats>("stats")) ?? null;
    return new Response(this.renderStatus(recent, gate, stats), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" },
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    await this.ensureRunning();
    await this.resolvePending();
  }

  private async ensureRunning(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
    if (this.running) return;
    this.running = true;

    const config = this.loadConfig();
    const confirmS = envInt(this.env.DRAIN_CONFIRM_SECONDS, 90);
    this.thresholds =
      `alerts on drains ≥$${(config.minUsd ?? 25000).toLocaleString("en-US")} and ≥${((config.pctThreshold ?? 0.1) * 100).toFixed(0)}% of reserve, ` +
      `confirmed over ${confirmS}s`;

    // epoch resets the readout when detection behavior changes (thresholds or
    // the confirm window), so the page never mixes old-logic and new-logic data
    const epoch = (await this.state.storage.get<string>("epoch")) ?? "";
    if (epoch !== this.thresholds) {
      await this.state.storage.put("epoch", this.thresholds);
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
        this.note(
          `subscription stopped (${entries.map((e) => e.label ?? e.address).join(", ")}): ${err.message}`,
        ),
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

  private loadConfig(): RadarConfig {
    if (!this.env.WATCHLIST) {
      this.configSource = `bundled watchlist.json (${FALLBACK_WATCHLIST.watch.length} pools)`;
      return FALLBACK_WATCHLIST;
    }
    try {
      const parsed = JSON.parse(this.env.WATCHLIST);
      const errors = validateRadarConfig(parsed);
      if (errors.length > 0) throw new Error(errors.join("; "));
      this.configSource = `WATCHLIST var (${parsed.watch.length} entries)`;
      return parsed as RadarConfig;
    } catch (err) {
      this.note(`WATCHLIST invalid, using bundled watchlist: ${String(err)}`);
      this.configSource = "bundled watchlist.json (WATCHLIST var INVALID, fix it!)";
      return FALLBACK_WATCHLIST;
    }
  }

  // Route alerts: drains queue for confirmation; adds are ignored unless POST_ADDS.
  private async handleAlert(alert: Alert): Promise<void> {
    this.lastEventMs = Date.now();
    this.lastReserve.set(alert.subject, alert.reserveUsd);
    if (alert.kind === "add") {
      if (this.env.POST_ADDS === "1") await this.commit(alert);
      return;
    }
    // first drain per subject wins until it resolves; later blocks of the same
    // unfolding drain don't pile up
    if (!this.pending.has(alert.subject)) {
      this.pending.set(alert.subject, {
        alert,
        prevReserveUsd: alert.prevReserveUsd,
        atMs: Date.now(),
      });
    }
  }

  // After the confirm window, send the drain only if it actually held.
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

  // Gate + send a confirmed alert, then record it.
  private async commit(alert: Alert): Promise<void> {
    const now = Date.now();
    const gate = (await this.state.storage.get<Gate>("gate")) ?? emptyGate();
    for (const [k, ts] of Object.entries(gate.posted)) {
      if (now - ts > DEDUP_TTL_MS) delete gate.posted[k];
    }
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
      const suffix =
        this.env.POST_SUFFIX !== undefined ? this.env.POST_SUFFIX : `\n\n${DATA_CREDIT}`;
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

  // Live dashboard state: rank pools by liquidity growth over the rolling
  // window, pick the hero (fastest riser) with its full series, and list recent
  // confirmed drains. Computed on demand from in-memory series + stored recent.
  private async buildLive(): Promise<unknown> {
    const now = Date.now();
    const movers: {
      label: string;
      chain: string;
      changePct: number;
      reserveUsd: number;
      series: { t: number; r: number }[];
    }[] = [];
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
    // "Rug watch": the quick-scam profile among the risers. Steep rise on a
    // small, non-blue-chip pool. High-risk, not a guarantee; the live data
    // measures how many actually drain (the hypothesis test).
    const RUG_MIN_RISE = 0.5; // liquidity up >=50% over the window
    const RUG_MAX_TVL = 750_000; // small pool; blue-chips don't rug
    const rugWatch = risers
      .filter((m) => m.changePct >= RUG_MIN_RISE && m.reserveUsd <= RUG_MAX_TVL)
      .slice(0, 8)
      .map((m) => ({ label: m.label, chain: m.chain, changePct: m.changePct, reserveUsd: m.reserveUsd }));
    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    const draining = recent
      .filter((r) => r.alert.kind === "drain" && r.reason !== "suppressed: refilled")
      .slice(0, 8)
      .map((r) => ({
        label: r.alert.label ?? r.alert.subject,
        chain: r.alert.chain,
        deltaUsd: r.alert.deltaUsd,
        pct: r.alert.pct,
        block: r.alert.block,
        t: r.alert.timestamp,
      }));
    const stats = (await this.state.storage.get<Stats>("stats")) ?? emptyStats(now);
    return {
      now,
      watching: this.meta.size,
      hero: hero
        ? { label: hero.label, chain: hero.chain, changePct: hero.changePct, series: hero.series.map((p) => ({ t: p.t, r: Math.round(p.r) })) }
        : null,
      rising: risers.slice(0, 8).map((m) => ({ label: m.label, chain: m.chain, changePct: m.changePct, reserveUsd: m.reserveUsd })),
      rugWatch,
      draining,
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
    const mode = live
      ? "live, sending drains to webhook"
      : "watch-only (no WEBHOOK_URL, catches stay on this page)";
    const lastEvent =
      this.lastEventMs > 0 ? `${Math.round((now - this.lastEventMs) / 1000)}s ago` : "none yet";
    const lastPost = gate.lastPostAtMs ? new Date(gate.lastPostAtMs).toISOString() : "never";
    const sentLabel = live ? "sent" : "would have sent";
    const totals = stats
      ? `${stats.drains} confirmed drains · ${stats.sent} ${sentLabel} · ${stats.suppressed} suppressed as transient, since ${new Date(stats.sinceMs).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "no drains yet";
    const paused =
      now < gate.pausedUntilMs
        ? `<p><strong>⏸ sending paused until ${escapeHtml(new Date(gate.pausedUntilMs).toISOString())} (webhook rate limit)</strong></p>`
        : "";
    const postError = gate.lastPostError
      ? `<p>last send error: <code>${escapeHtml(gate.lastPostError)}</code></p>`
      : "";
    const issues =
      this.issues.length > 0
        ? `<h2>Recent issues</h2><ul>${this.issues.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("")}</ul>`
        : "";
    const rows = recent
      .map((r) => {
        const a = r.alert;
        const drain = a.kind === "drain";
        const icon = a.scope === "pool" ? (drain ? "🚨" : "🟢") : drain ? "📉" : "📈";
        const amount = `${a.deltaUsd < 0 ? "-" : "+"}$${Math.abs(Math.round(a.deltaUsd)).toLocaleString("en-US")}`;
        const pctText = isFinite(a.pct) ? `${(a.pct * 100).toFixed(1)}%` : "new pool";
        const when = new Date(a.timestamp * 1000).toISOString().slice(5, 16).replace("T", " ");
        const ageH = (now / 1000 - a.timestamp) / 3600;
        const age = ageH < 1 ? `${Math.max(0, Math.round(ageH * 60))}m ago` : `${ageH.toFixed(1)}h ago`;
        const tag = r.posted ? sentLabel : `skipped: ${r.reason}`;
        return `<li><code>${escapeHtml(when)} UTC · ${escapeHtml(age)}</code><br>${icon} ${escapeHtml(a.label ?? a.subject)} on ${escapeHtml(a.chain)} · ${escapeHtml(amount)} (${escapeHtml(pctText)}) · block ${escapeHtml(a.block)} · <em>${escapeHtml(tag)}</em></li>`;
      })
      .join("\n");
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>LiquidityRadar</title>
<body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px">
<h1>LiquidityRadar (live)</h1>
<p>Real-time DEX liquidity-drain alerts on the free DexPaprika reserve stream. Drains are confirmed (a drop that refills is suppressed) before they post.</p>
<p>mode: <strong>${escapeHtml(mode)}</strong> · watchlist: ${escapeHtml(this.configSource)}<br>
${escapeHtml(this.thresholds)}<br>
last reserve event: ${escapeHtml(lastEvent)} · last sent: ${escapeHtml(lastPost)}<br>
<strong>${escapeHtml(totals)}</strong></p>
${paused}${postError}
<h2>Recent drains</h2>
<ul style="list-style:none;padding:0">${rows ? rows.replace(/<li>/g, '<li style="margin:10px 0">') : "<li>nothing caught yet (confirmed drains are rare by design)</li>"}</ul>
${issues}
<hr style="margin-top:32px;border:none;border-top:1px solid #ddd">
<p style="color:#666">Powered by <a href="https://dexpaprika.com">DexPaprika</a>: free real-time DEX data, no API key needed ·
<a href="https://docs.dexpaprika.com">streaming docs</a> ·
<a href="https://github.com/coinpaprika/liquidity-radar">fork this radar</a></p>
</body>`;
  }
}
