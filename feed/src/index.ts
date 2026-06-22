// LiquidityRadar live feed: Cloudflare Worker + Durable Object.
//
// Two tiers:
//  1. REST scanner (cheap, thousands of pools): every SCAN_INTERVAL the DO pages
//     through the small + recently-created pools on each chain via
//     /networks/{chain}/pools/filter, stores liquidity_usd snapshots in memory,
//     and ranks the fastest-rising. liquidity_usd is a ~20-30s aggregate (probed),
//     so the scan runs on a 60s cadence and growth is measured over minutes.
//  2. Reserve stream (precious, ~74 pools): the top fastest-rising pools are put
//     on the multiplexed reserve stream for block-level drain confirmation. So a
//     pool the scanner flags as rising is the same pool the stream catches when it
//     drains: flag the rise, confirm the cliff, one story.
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
  WATCHLIST?: string; // JSON RadarConfig override; if unset, the scanner picks the stream targets
  POST_COOLDOWN_MINUTES?: string;
  POSTS_PER_HOUR?: string;
  POST_SUFFIX?: string;
  DRAIN_CONFIRM_SECONDS?: string; // a drain must persist this long before sending (default 90)
  POST_ADDS?: string; // "1" to also post liquidity adds (default off)
  POOLS_PER_CHAIN?: string; // cold-start volume watchlist size per chain (default 37)
  SCAN_PAGES?: string; // pools/filter pages scanned per chain each cycle (default 6 = 600 pools/chain)
  SCAN_INTERVAL_SECONDS?: string; // liquidity scan cadence (default 60; liquidity_usd refreshes ~20-30s)
}

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const ALARM_INTERVAL_MS = 30_000;
const PERSIST_FRACTION = 0.5; // a confirmed drain is still down to <= this fraction of pre-drain
const SERIES_CAP = 120; // rolling reserve points kept per streamed pool for the live chart
const REFRESH_MS = 60 * 60 * 1000; // rebuild the cold-start volume watchlist hourly
// Pools per chain in the cold-start volume watchlist (used until the scanner has
// growth data). The free keyless stream allows 3 connections per IP (probed
// live), 25 subs each, so ~75 pools is the free ceiling; 37/chain (74 total)
// packs into exactly 3 connections. Raise only with an enterprise key.
const DEFAULT_PER_CHAIN = 37;
const STREAM_TARGETS = 74; // pools handed to the reserve stream (free-tier ceiling)
const DYNAMIC_CHAINS = ["solana", "ethereum"];

// --- liquidity scanner -------------------------------------------------------
// The scanner (REST) and the live stream share one Cloudflare egress IP, and
// DexPaprika throttles per IP. The scanner is the SECONDARY tier, so keep it
// gentle: a REST storm here starves the stream (the actual product). Scan every
// 2 min (liquidity_usd is a ~20-30s aggregate, so growth over 2 min is fine),
// fewer pages, wider spacing.
const DEFAULT_SCAN_PAGES = 4; // 100 pools/page; newest-created first
const DEFAULT_SCAN_INTERVAL_S = 120;
const PAGE_SPACING_MS = 900; // pace pages: REST is a burst limiter (~30 req/20s), Retry-After 20
const MAX_429_RETRIES = 2; // consecutive 429s on a page before giving up (don't freeze the alarm)
const MAX_BACKOFF_S = 30; // cap an over-large Retry-After
const SCAN_LIQ_MIN = 10_000; // skip dust
const SCAN_LIQ_MAX = 2_000_000; // skip blue-chips: they don't rug
const SCAN_TXNS_MIN = 50; // must be active
const SCAN_AGE_DAYS = 7; // recently created = rug-prone
const LIQ_PTS_CAP = 8; // ~8 min of history per pool at 60s cadence
const LIQ_POOLS_CAP = 3000; // tracked pools (memory bound)
const RISE_THRESHOLD = 0.03; // >=3% growth over the window counts as "rising" (sub-1% is noise)
const RUG_MAX_TVL = 750_000; // high-risk subset: small pool + steep rise
const STREAM_REFRESH_MS = 5 * 60 * 1000; // re-point the stream at fresh risers at most this often
const STREAM_CHURN_FRACTION = 0.25; // ...and only if the target set changed by more than this
const HYP_CAP = 800; // tracked subjects per hypothesis bucket
// DEXs whose reported reserves are accounting artifacts, not tradeable liquidity,
// so they fake huge "drains" that refill: Manifest (orderbook) and Meteora DAAM
// (dynamic vaults route reserves to lending, so total_reserve_usd swings, and it
// disagrees with REST liquidity_usd by 10-50x). Excluded from scanner + stream.
const SKIP_DEX = /manifest|daam/i;
const STABLES = new Set([
  "USDC", "USDT", "USDG", "PYUSD", "USDS", "DAI", "USDE", "USDM", "FDUSD",
  "TUSD", "USD₮0", "USDT0", "USD₮", "BUSD", "FRAX", "GUSD", "LUSD", "USDD", "USDC.E",
]);

function envInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
// one scanned pool's liquidity history (in memory; rebuilds after eviction)
interface LiqTrack {
  label: string;
  chain: string;
  pts: { t: number; liq: number }[];
}
// a ranked riser surfaced to the page / chosen for the stream
interface Riser {
  id: string;
  label: string;
  chain: string;
  growthPct: number;
  liqUsd: number;
}

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
  private lastRefreshMs = 0; // last cold-start volume rebuild
  private lastScanMs = 0; // last liquidity scan
  private lastStreamPickMs = 0; // last time the stream targets were re-evaluated
  private lastStreamWarnMs = 0; // throttle for the silence watchdog note
  private lastErrNoteMs = 0; // separate throttle for stream-error notes
  private streamStarts = 0; // radar.start() invocations (detects restart churn)
  private streamErrCount = 0; // transient stream errors observed
  private lastStreamErr = ""; // most recent stream error (shown on /status always)
  private scanning = false;
  private configSource = "(not loaded yet)";
  private thresholds = "";
  private issues: string[] = [];
  private lastReserve = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private series = new Map<string, { t: number; r: number }[]>();
  private meta = new Map<string, { label: string; chain: string }>();
  private liq = new Map<string, LiqTrack>(); // scanned pools' liquidity history

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
    // Keep the live stream alive FIRST: it is the product, and the scanner's
    // REST calls can back off for many seconds, which must never delay the
    // stream from (re)starting.
    await this.ensureRunning();
    await this.resolvePending();
    this.watchdogStream();
    const scanMs = envInt(this.env.SCAN_INTERVAL_SECONDS, DEFAULT_SCAN_INTERVAL_S) * 1000;
    if (Date.now() - this.lastScanMs > scanMs) {
      await this.scanLiquidity();
      await this.maybeRepointStream();
      await this.ensureRunning(); // if the re-point stopped the radar, restart it now (no 30s gap)
    }
    await this.updateHypothesis();
  }

  // Surface the failure mode the user hit: scanner fine, stream silent. If the
  // radar is up but no reserve events are arriving, the egress IP is almost
  // certainly being rate-limited (scanner + stream share it).
  private watchdogStream(): void {
    if (!this.running) return;
    const now = Date.now();
    const silentMs = this.lastEventMs ? now - this.lastEventMs : Infinity;
    if (silentMs > 120_000 && now - this.lastStreamWarnMs > 120_000) {
      this.lastStreamWarnMs = now;
      const since = this.lastEventMs ? `${Math.round(silentMs / 1000)}s` : "since start";
      this.note(`stream silent ${since} while running (likely egress-IP rate limit; scanner + stream share one IP)`);
    }
  }

  private async ensureRunning(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
    if (this.running) return;
    this.running = true;

    let radar: Radar;
    try {
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

      radar = createRadar(config, {
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
        onError: (err, entries) => {
          this.streamErrCount++;
          this.lastStreamErr = `${String(err).slice(0, 150)} (${entries.length}p)`;
          const now = Date.now();
          if (now - this.lastErrNoteMs > 60_000) {
            this.lastErrNoteMs = now;
            this.note(`stream error: ${this.lastStreamErr}`);
          }
        },
      });
    } catch (err) {
      // setup failed (e.g. activeConfig fetch/storage threw); reset so the next
      // alarm retries instead of wedging running=true with no radar.
      this.running = false;
      this.note(`ensureRunning setup failed: ${String(err)}`);
      return;
    }

    this.radar = radar;
    this.streamStarts++;
    const thisRadar = radar;
    radar
      .start()
      .catch((err) => this.note(`radar crashed: ${String(err)}`))
      .finally(() => {
        // only the CURRENT radar's teardown may reset state; a re-point swaps in
        // a new radar, and the old one's late teardown must not clear its flags.
        if (this.radar === thisRadar) {
          this.radar = undefined;
          this.running = false;
        }
      });
  }

  // Stream targets, in priority order:
  //   WATCHLIST var override -> scanner's top risers -> cold-start volume list -> bundled.
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
    const stream = await this.state.storage.get<WatchEntry[]>("streamWatchlist");
    if (stream && stream.length) {
      this.configSource = `scanner: top ${stream.length} fastest-rising pools`;
      return { minUsd: FALLBACK_WATCHLIST.minUsd, pctThreshold: FALLBACK_WATCHLIST.pctThreshold, watch: stream };
    }
    // cold start: stream the most active pools until the scanner has growth data
    let dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    if (!dyn || !dyn.length) {
      await this.refreshWatchlist();
      dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    }
    if (dyn && dyn.length) {
      this.configSource = `cold start: ${dyn.length} most-active pools (scanner warming up)`;
      return { minUsd: FALLBACK_WATCHLIST.minUsd, pctThreshold: FALLBACK_WATCHLIST.pctThreshold, watch: dyn };
    }
    this.configSource = `bundled watchlist.json (${FALLBACK_WATCHLIST.watch.length} pools)`;
    return FALLBACK_WATCHLIST;
  }

  private isStablePair(syms: string[]): boolean {
    return syms.length === 2 && syms.every((s) => STABLES.has(String(s).toUpperCase()));
  }
  private poolLabel(p: any): { syms: string[]; dex: string; label: string } {
    const dex = String(p.dex_name ?? p.dex_id ?? "?");
    const syms = (p.tokens ?? []).map((t: any) => t.symbol ?? "?").slice(0, 2);
    return { syms, dex, label: `${syms.join("/")} (${dex})` };
  }

  // --- tier 1: liquidity scanner --------------------------------------------
  // Page through each chain's small + recently-created pools and record their
  // liquidity_usd. Paced sequentially (REST is a burst limiter); Retry-After is
  // honored with a backoff. Builds the in-memory history growth ranking reads.
  private async scanLiquidity(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const now = Date.now();
    const pages = envInt(this.env.SCAN_PAGES, DEFAULT_SCAN_PAGES);
    const createdAfter = Math.floor((now - SCAN_AGE_DAYS * 86400_000) / 1000);
    const seenIds = new Set<string>(); // dedupe a pool that lands on two pages this scan
    let seen = 0;
    try {
      for (const chain of DYNAMIC_CHAINS) {
        let retries = 0;
        for (let page = 1; page <= pages; page++) {
          const url =
            `https://api.dexpaprika.com/networks/${chain}/pools/filter` +
            `?liquidity_usd_min=${SCAN_LIQ_MIN}&liquidity_usd_max=${SCAN_LIQ_MAX}` +
            `&txns_24h_min=${SCAN_TXNS_MIN}&created_after=${createdAfter}` +
            `&sort_by=created_at&sort_dir=desc&limit=100&page=${page}`;
          let results: any[] = [];
          try {
            const r = await fetch(url, { headers: { accept: "application/json" } });
            if (r.status === 429) {
              if (retries >= MAX_429_RETRIES) {
                this.note(`scan ${chain} still 429 after ${retries} retries; skipping rest of chain`);
                break;
              }
              retries++;
              const wait = Math.min(envInt(r.headers.get("retry-after") ?? undefined, 20), MAX_BACKOFF_S);
              this.note(`scan ${chain} p${page} rate-limited, backing off ${wait}s`);
              await sleep(wait * 1000);
              page--; // retry this page
              continue;
            }
            retries = 0; // any non-429 response clears the streak
            if (!r.ok) break; // page past the end / transient: stop this chain
            results = ((await r.json()) as { results?: any[] })?.results ?? [];
          } catch (e) {
            this.note(`scan ${chain} p${page}: ${String(e)}`);
            break;
          }
          if (!results.length) break;
          for (const p of results) {
            const id = String(p.id ?? "");
            const liq = Number(p.liquidity_usd);
            if (!id || !Number.isFinite(liq) || liq <= 0) continue;
            if (seenIds.has(id)) continue; // already sampled this scan: one point per pool per scan
            seenIds.add(id);
            const { syms, dex, label } = this.poolLabel(p);
            if (SKIP_DEX.test(dex)) continue;
            if (this.isStablePair(syms)) continue;
            const track = this.liq.get(id) ?? { label, chain, pts: [] };
            track.label = label;
            track.pts.push({ t: now, liq });
            if (track.pts.length > LIQ_PTS_CAP) track.pts.shift();
            this.liq.set(id, track);
            seen++;
          }
          await sleep(PAGE_SPACING_MS);
        }
      }
    } finally {
      this.capLiq();
      this.lastScanMs = Date.now();
      this.scanning = false;
    }
    // persist the derived lists so /api/live survives a DO eviction
    const risers = this.rankRisers();
    await this.state.storage.put("scan_rising", risers.slice(0, 20));
    await this.state.storage.put(
      "scan_rugwatch",
      risers.filter((r) => r.liqUsd <= RUG_MAX_TVL).slice(0, 12),
    );
    if (seen) this.note(`scan ok: ${seen} pool samples, ${this.liq.size} tracked`);
  }

  private capLiq(): void {
    if (this.liq.size <= LIQ_POOLS_CAP) return;
    const byAge = [...this.liq.entries()].sort(
      (a, b) => (a[1].pts.at(-1)?.t ?? 0) - (b[1].pts.at(-1)?.t ?? 0),
    );
    for (const [id] of byAge.slice(0, this.liq.size - LIQ_POOLS_CAP)) this.liq.delete(id);
  }

  // Growth over the stored window (first -> last point), thresholded and ranked.
  private rankRisers(): Riser[] {
    const out: Riser[] = [];
    for (const [id, t] of this.liq) {
      if (t.pts.length < 2) continue;
      const first = t.pts[0].liq;
      const last = t.pts[t.pts.length - 1].liq;
      if (first <= 0) continue;
      const growthPct = (last - first) / first;
      if (growthPct >= RISE_THRESHOLD) out.push({ id, label: t.label, chain: t.chain, growthPct, liqUsd: last });
    }
    return out.sort((a, b) => b.growthPct - a.growthPct);
  }

  // Re-point the reserve stream at the freshest risers, rate-limited and only on
  // a material change, so we don't thrash the subscription (which would drop
  // in-flight drain confirmation).
  private async maybeRepointStream(): Promise<void> {
    if (this.env.WATCHLIST) return; // explicit override wins
    const now = Date.now();
    if (now - this.lastStreamPickMs < STREAM_REFRESH_MS) return;
    const risers = this.rankRisers();
    if (risers.length < 20) return; // not enough growth signal yet; stay on cold-start list
    const targets: WatchEntry[] = risers
      .slice(0, STREAM_TARGETS)
      .map((r) => ({ method: "pool_reserves", chain: r.chain, address: r.id, label: r.label }));
    const prev = (await this.state.storage.get<WatchEntry[]>("streamWatchlist")) ?? [];
    const prevSet = new Set(prev.map((w) => w.address));
    const overlap = targets.filter((t) => prevSet.has(t.address)).length;
    const churn = prev.length ? 1 - overlap / Math.max(targets.length, prev.length) : 1;
    this.lastStreamPickMs = now;
    if (churn < STREAM_CHURN_FRACTION && prev.length) return; // close enough, leave it
    await this.state.storage.put("streamWatchlist", targets);
    if (this.running) {
      this.radar?.stop(); // resubscribe with the fresh risers on the next ensureRunning
      this.running = false;
    }
    this.note(`stream re-pointed at top ${targets.length} risers (churn ${(churn * 100).toFixed(0)}%)`);
  }

  // Cold-start watchlist: most active pools by volume, until the scanner ranks risers.
  private async refreshWatchlist(): Promise<boolean> {
    const perChain = envInt(this.env.POOLS_PER_CHAIN, DEFAULT_PER_CHAIN);
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
          const { syms, dex, label } = this.poolLabel(p);
          if (SKIP_DEX.test(dex)) continue;
          if (this.isStablePair(syms)) continue;
          out.push({ method: "pool_reserves", chain, address: p.id, label });
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

  // Record pools the scanner flags as steep risers (the hypothesis: do these drain?).
  private async updateHypothesis(): Promise<void> {
    const flagged = this.rankRisers().filter((r) => r.liqUsd <= RUG_MAX_TVL);
    if (!flagged.length) return;
    const rw = (await this.state.storage.get<Record<string, HypMark>>("hyp_rw")) ?? {};
    let changed = false;
    for (const f of flagged) {
      if (!rw[f.id]) {
        rw[f.id] = { label: f.label, chain: f.chain, t: Date.now(), pct: f.growthPct };
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
    // rising / rug-watch come from the scanner (thousands of pools)
    let risers = this.rankRisers();
    if (!risers.length) risers = (await this.state.storage.get<Riser[]>("scan_rising")) ?? [];
    const rising = risers.slice(0, 12).map((r) => ({ label: r.label, chain: r.chain, changePct: r.growthPct, reserveUsd: r.liqUsd }));
    let rugList = risers.filter((r) => r.liqUsd <= RUG_MAX_TVL);
    if (!rugList.length) rugList = (await this.state.storage.get<Riser[]>("scan_rugwatch")) ?? [];
    const rugWatch = rugList.slice(0, 8).map((r) => ({ label: r.label, chain: r.chain, changePct: r.growthPct, reserveUsd: r.liqUsd }));

    // hero chart: the fastest-rising pool we're actually streaming (real-time series)
    let hero: { label: string; chain: string; changePct: number; series: { t: number; r: number }[] } | null = null;
    for (const r of risers) {
      const pts = this.series.get(r.id);
      if (pts && pts.length >= 2) {
        hero = { label: r.label, chain: r.chain, changePct: r.growthPct, series: pts.map((p) => ({ t: p.t, r: Math.round(p.r) })) };
        break;
      }
    }
    if (!hero) {
      // fall back to the liveliest streamed series so the chart is never blank
      let best: { subject: string; pts: { t: number; r: number }[]; chg: number } | null = null;
      for (const [subject, pts] of this.series) {
        if (pts.length < 2 || pts[0].r <= 0) continue;
        const chg = (pts[pts.length - 1].r - pts[0].r) / pts[0].r;
        if (!best || chg > best.chg) best = { subject, pts, chg };
      }
      if (best) {
        const m = this.meta.get(best.subject) ?? { label: best.subject, chain: "?" };
        hero = { label: m.label, chain: m.chain, changePct: best.chg, series: best.pts.map((p) => ({ t: p.t, r: Math.round(p.r) })) };
      }
    }

    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    const draining = recent
      .filter((r) => r.alert.kind === "drain" && r.reason !== "suppressed: refilled")
      .slice(0, 8)
      .map((r) => ({ id: r.alert.subject, label: r.alert.label ?? r.alert.subject, chain: r.alert.chain, deltaUsd: r.alert.deltaUsd, pct: r.alert.pct, block: r.alert.block, t: r.alert.timestamp }));

    // every streamed pool's recent reserve series, for the multi-line live chart
    const streams: { id: string; label: string; chain: string; changePct: number; pts: { t: number; r: number }[] }[] = [];
    for (const [subject, pts] of this.series) {
      if (pts.length < 2) continue;
      const m = this.meta.get(subject) ?? { label: subject, chain: "?" };
      const tail = pts.slice(-60);
      const base = tail[0].r;
      const changePct = base > 0 ? (tail[tail.length - 1].r - base) / base : 0;
      streams.push({ id: subject, label: m.label, chain: m.chain, changePct, pts: tail.map((p) => ({ t: p.t, r: Math.round(p.r) })) });
    }
    streams.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

    const stats = (await this.state.storage.get<Stats>("stats")) ?? emptyStats(now);
    return {
      now,
      watching: this.meta.size, // pools on the live reserve stream that have emitted
      scanning: this.liq.size, // pools the REST scanner is tracking for liquidity growth
      hero,
      series: streams.slice(0, 18), // overlaid live lines
      rising,
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
    const lastScan = this.lastScanMs > 0 ? `${Math.round((now - this.lastScanMs) / 1000)}s ago` : "not yet";
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
<p>mode: <strong>${escapeHtml(mode)}</strong> · stream: ${escapeHtml(this.configSource)}<br>
stream health: ${this.streamStarts} starts · ${this.streamErrCount} errors${this.lastStreamErr ? ` · last err: <code>${escapeHtml(this.lastStreamErr)}</code>` : ""}<br>
scanner: ${this.liq.size} pools tracked · last scan ${escapeHtml(lastScan)}<br>
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
