// LiquidityRadar live feed: Cloudflare Worker + Durable Object.
//
// Two tiers:
//  1. REST scanner = candidate DISCOVERY (cheap, thousands of pools): every
//     SCAN_INTERVAL the DO pages through small + recently-created pools on each
//     chain via /networks/{chain}/pools/filter and ranks them by 24h VOLUME
//     (turnover). It does NOT try to measure liquidity growth: liquidity_usd is a
//     coarse aggregate that barely moves minute-to-minute (calibrated live), so a
//     "rising" signal can't be read from it. Volume is live and trustworthy, and
//     high-turnover young pools are the rug-prone set worth watching.
//  2. Reserve stream = the real signal (precious, ~74 pools on the free tier).
//     Drains AND rises are both computed here, from real quote-valued reserves at
//     block level. Stream slots are filled by PIN-THE-MOVERS + ROTATE-TO-DISCOVER:
//     any pool currently moving (rising / draining / mid-confirmation) is pinned so
//     it is never dropped mid-lifecycle; the rest of the slots rotate through the
//     volume-ranked candidates so 74 slots sweep far more than 74 pools over time.
//
// Rug feed: posts DRAINS only, and only after a drain has held for
// DRAIN_CONFIRM_SECONDS (a drop that refills is suppressed). POST_ADDS=1 to
// also post adds. Sending is fail-closed: without WEBHOOK_URL nothing leaves.

import {
  DATA_CREDIT,
  createRadar,
  formatAlert,
  poolReserveUsd,
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
  DEXPAPRIKA_API_KEY?: string; // optional Pro/Enterprise key: lifts the stream cap 3->7 connections
  STREAM_MAX_AGE_SECONDS?: string; // proactively recycle the subscription this often (default 600)
  STREAM_KEYLESS?: string; // "1": don't send the key on the STREAM (scanner still keyed). For Cloudflare
  // Workers, where the keyed SSE delivers pings but no data (WAF on keyed stream from worker IPs).
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
const STREAM_TARGETS = 74; // pools handed to the reserve stream on the FREE tier (3 connections)
// With a Pro/Enterprise key the per-IP stream cap is 7 connections (probed live),
// so ~175 pools. These are the keyed defaults; POOLS_PER_CHAIN overrides.
const STREAM_TARGETS_KEYED = 175;
const KEYED_PER_CHAIN = 87; // cold-start size per chain when keyed (~174 total)
const DYNAMIC_CHAINS = ["solana", "ethereum"];

// --- liquidity scanner -------------------------------------------------------
// The scanner (REST) and the live stream share one Cloudflare egress IP, and
// DexPaprika throttles per IP. The scanner is the SECONDARY tier, so keep it
// gentle: a REST storm here starves the stream (the actual product). Scan every
// 2 min (liquidity_usd is a ~20-30s aggregate, so growth over 2 min is fine),
// fewer pages, wider spacing.
const DEFAULT_SCAN_PAGES = 4; // 100 pools/page; newest-created first (free tier, paced)
const DEFAULT_SCAN_INTERVAL_S = 120;
const PAGE_SPACING_MS = 900; // pace pages: free REST is a burst limiter (~30 req/20s), Retry-After 20
// With a key the REST burst limit is gone (probed: 40/40 concurrent OK on api-pro),
// so scan far deeper and barely pace.
const KEYED_SCAN_PAGES = 12; // ~1200 pools/chain tracked for growth
const KEYED_PAGE_SPACING_MS = 150;
const MAX_429_RETRIES = 2; // consecutive 429s on a page before giving up (don't freeze the alarm)
const MAX_BACKOFF_S = 30; // cap an over-large Retry-After
const SCAN_LIQ_MIN = 10_000; // skip dust
const SCAN_LIQ_MAX = 2_000_000; // skip blue-chips: they don't rug
const SCAN_TXNS_MIN = 50; // must be active
const SCAN_AGE_DAYS = 7; // recently created = rug-prone
const CAND_CAP = 3000; // discovered candidate pools held in memory (bound)
const RUG_MAX_TVL = 750_000; // high-risk subset: small pool (rug-watch + hypothesis)
const STREAM_REFRESH_MS = 5 * 60 * 1000; // rotate/re-point the stream at most this often
// "Rising" is read from the live stream's real quote-valued reserves, not REST.
// A pool counts as rising when its reserve climbs >= this over the look-back.
const STREAM_RISE_WINDOW_S = 600; // 10 min of streamed history defines the trend
const STREAM_RISE_THRESHOLD = 0.05; // >=5% real reserve growth over the window = rising
// A pool moving (up or down) by at least this in the window is PINNED to the
// stream so rotation never drops it mid-move; drains awaiting confirmation pin too.
const PIN_MOVE_THRESHOLD = 0.05;
const HYP_CAP = 800; // tracked subjects per hypothesis bucket
const SILENCE_RESTART_MS = 150_000; // restart the subscription if it delivers NOTHING this long
// Bump to wipe persisted state on deploy (drains/stats/hypothesis/watchlists).
// 2026-06-23: "rising" now comes from the live stream, not REST liquidity_usd;
// the old scan_rising/scan_rugwatch snapshots and hypothesis are invalid.
const SCHEMA_VERSION = "2026-06-23-stream-rise";
const DEFAULT_STREAM_MAX_AGE_S = 600; // proactively recycle connections this often (catches a
// single wedged chunk that the global silence timer misses, and preempts wedges before they happen)
// DEXs whose reported reserves are accounting artifacts, not tradeable liquidity,
// so they fake huge "drains" that refill: Manifest (orderbook) and Meteora DAAM
// (dynamic vaults route reserves to lending, so total_reserve_usd swings, and it
// disagrees with REST liquidity_usd by 10-50x). Excluded from scanner + stream.
const SKIP_DEX = /manifest|daam/i;
// Recognized stablecoins (symbols, compared uppercased). A pair of two of these
// is not a rug candidate and is dropped from the watchlist: its quote leg swings
// hard on normal swaps/rebalances (worse when the pool is thin), which a
// single-leg valuation would misread as a drain.
const STABLES = new Set([
  "USDC", "USDT", "USDG", "PYUSD", "USDS", "DAI", "USDE", "USDM", "FDUSD",
  "TUSD", "USD₮0", "USDT0", "USD₮", "BUSD", "FRAX", "GUSD", "LUSD", "USDD", "USDC.E",
  "MUSD", "GHO", "CRVUSD", "USDP", "SUSDE", "SUSDS", "USD0", "USR", "DOLA", "MIM", "USDX", "USDL",
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
// a discovered candidate pool (latest snapshot; the scanner overwrites each cycle).
// volUsd (24h turnover) is the ranking key; liqUsd is kept for context only.
interface Candidate {
  label: string;
  chain: string;
  liqUsd: number;
  volUsd: number;
  t: number;
}
// a riser surfaced to the page (computed from the live stream's real reserves)
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
  // pools are valued by their quote leg (real money), not the inflated total
  return e.type === "pool_reserves"
    ? { subject: e.pool_id, reserve: poolReserveUsd(e) }
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
  private lastRawMsgMs = 0; // last SSE message incl. ping (connection-liveness, vs lastEventMs)
  private lastRefreshMs = 0; // last cold-start volume rebuild
  private lastScanMs = 0; // last liquidity scan
  private lastStreamPickMs = 0; // last time the stream targets were re-evaluated
  private streamStartedMs = 0; // when the current radar started (for silence detection)
  private lastErrNoteMs = 0; // separate throttle for stream-error notes
  private streamStarts = 0; // radar.start() invocations (detects restart churn / self-heals)
  private streamErrCount = 0; // transient stream errors observed
  private lastStreamErr = ""; // most recent stream error (shown on /status always)
  private purged = false; // one-time stale-state purge guard
  private scanning = false;
  private configSource = "(not loaded yet)";
  private thresholds = "";
  private issues: string[] = [];
  private lastReserve = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private series = new Map<string, { t: number; r: number }[]>();
  private meta = new Map<string, { label: string; chain: string }>();
  private candidates = new Map<string, Candidate>(); // discovered pools (rotation universe)
  private rotateCursor = 0; // advances each repoint so rotation sweeps the universe
  private activeAddrs = new Set<string>(); // addresses the current radar is subscribed to

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
    // stream from (re)starting. The watchdog runs before ensureRunning so a
    // wedged subscription is torn down and immediately resubscribed.
    this.watchdogStream();
    await this.ensureRunning();
    await this.resolvePending();
    // Trim streamed state down to what we're actually subscribed to (+ pending),
    // every tick. This is the ONLY prune that runs during cold start, where
    // maybeRepointStream bails before it can prune, so without it series/meta grow
    // unbounded as new pools emit.
    this.pruneStreamState(this.activeAddrs);
    const scanMs = envInt(this.env.SCAN_INTERVAL_SECONDS, DEFAULT_SCAN_INTERVAL_S) * 1000;
    if (Date.now() - this.lastScanMs > scanMs) {
      await this.scanCandidates();
      await this.maybeRepointStream();
      await this.ensureRunning(); // if the re-point stopped the radar, restart it now (no 30s gap)
    }
    await this.updateHypothesis();
  }

  // Self-heal the failure mode the user hit: scanner fine, stream silent. A
  // wedged subscription (connected, no error, no events) won't recover on its
  // own, so after SILENCE_RESTART_MS we tear it down; the next ensureRunning
  // resubscribes. streamStarts climbing while watching stays 0 means restarts
  // don't help and the stream must move off this host.
  private watchdogStream(): void {
    if (!this.running) return;
    const now = Date.now();
    // Proactive recycle: re-establish all connections periodically. The reactive
    // check below only sees a TOTAL wedge (global silence); a single wedged chunk
    // among healthy ones keeps lastEventMs fresh and would rot undetected, so we
    // recycle the whole subscription on a timer regardless of health.
    const maxAgeMs = envInt(this.env.STREAM_MAX_AGE_SECONDS, DEFAULT_STREAM_MAX_AGE_S) * 1000;
    if (this.streamStartedMs && now - this.streamStartedMs > maxAgeMs) {
      this.note(`stream recycle (connections ${Math.round((now - this.streamStartedMs) / 1000)}s old)`);
      this.radar?.stop();
      this.radar = undefined; // own the teardown so the old radar's finally() is a no-op
      this.running = false; // next ensureRunning resubscribes
      return;
    }
    // Reactive: nothing at all for SILENCE_RESTART_MS means a total wedge.
    const ref = this.lastEventMs || this.streamStartedMs;
    if (!ref) return;
    const silentMs = now - ref;
    if (silentMs > SILENCE_RESTART_MS) {
      const since = this.lastEventMs ? `${Math.round(silentMs / 1000)}s` : "since start";
      this.note(`stream silent ${since}; restarting the subscription`);
      this.radar?.stop();
      this.radar = undefined; // own the teardown so the old radar's finally() is a no-op
      this.running = false; // next ensureRunning resubscribes
    }
  }

  // Wipe persisted state once when the schema/valuation changes, so stale
  // figures (pre-quote-valuation drains, DAAM-polluted hypothesis, old
  // watchlist) don't linger after a deploy.
  private async purgeIfStale(): Promise<void> {
    if (this.purged) return;
    this.purged = true;
    const v = await this.state.storage.get<string>("schema");
    if (v !== SCHEMA_VERSION) {
      await this.state.storage.delete([
        "recent", "stats", "hyp_rw", "hyp_dr", "streamWatchlist", "dynamicWatchlist",
        "scan_rising", "scan_rugwatch", "rising_snapshot",
      ]);
      await this.state.storage.put("schema", SCHEMA_VERSION);
      this.note(`purged stale state (schema ${v ?? "none"} -> ${SCHEMA_VERSION})`);
    }
  }

  private async ensureRunning(): Promise<void> {
    await this.purgeIfStale();
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
    if (this.running) return;
    this.running = true;

    let radar: Radar;
    try {
      const config = await this.activeConfig();
      this.activeAddrs = new Set(config.watch.map((w) => w.address));
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
        onBeat: () => {
          this.lastRawMsgMs = Date.now();
        },
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

    // Re-assert running: a stopped radar's finally() (below) can fire during the
    // await above and flip running=false. Without this, we'd return with a live
    // radar but running=false, and the next alarm would start a duplicate.
    this.running = true;
    this.radar = radar;
    this.streamStarts++;
    this.streamStartedMs = Date.now();
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

  // Optional Pro/Enterprise key (trimmed). Sent as the bare Authorization header
  // on the stream; lifts the per-IP cap from 3 to 7 connections.
  private apiKey(): string | undefined {
    const k = this.env.DEXPAPRIKA_API_KEY?.trim();
    return k ? k : undefined;
  }
  // The key used FOR THE STREAM specifically. STREAM_KEYLESS forces the free
  // stream (the scanner keeps the full key) because keyed SSE from a Cloudflare
  // Worker IP currently delivers pings but no data.
  private streamKey(): string | undefined {
    return this.env.STREAM_KEYLESS === "1" ? undefined : this.apiKey();
  }
  private streamTargets(): number {
    return this.streamKey() ? STREAM_TARGETS_KEYED : STREAM_TARGETS;
  }

  // Stream targets, in priority order:
  //   WATCHLIST var override -> scanner's top risers -> cold-start volume list -> bundled.
  // The API key (if any) is attached to every variant so the radar authenticates.
  private async activeConfig(): Promise<RadarConfig> {
    const apiKey = this.streamKey();
    if (this.env.WATCHLIST) {
      try {
        const parsed = JSON.parse(this.env.WATCHLIST);
        const errs = validateRadarConfig(parsed);
        if (errs.length) throw new Error(errs.join("; "));
        this.configSource = `WATCHLIST var (${parsed.watch.length} entries)`;
        return { ...(parsed as RadarConfig), apiKey };
      } catch (err) {
        this.note(`WATCHLIST invalid, falling back: ${String(err)}`);
      }
    }
    const stream = await this.state.storage.get<WatchEntry[]>("streamWatchlist");
    if (stream && stream.length) {
      this.configSource = `${stream.length} pools (pinned movers + rotating candidates)`;
      return { minUsd: FALLBACK_WATCHLIST.minUsd, pctThreshold: FALLBACK_WATCHLIST.pctThreshold, watch: stream, apiKey };
    }
    // cold start: stream the most active pools until the scanner has growth data
    let dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    if (!dyn || !dyn.length) {
      await this.refreshWatchlist();
      dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    }
    if (dyn && dyn.length) {
      this.configSource = `cold start: ${dyn.length} most-active pools (scanner warming up)`;
      return { minUsd: FALLBACK_WATCHLIST.minUsd, pctThreshold: FALLBACK_WATCHLIST.pctThreshold, watch: dyn, apiKey };
    }
    this.configSource = `bundled watchlist.json (${FALLBACK_WATCHLIST.watch.length} pools)`;
    return { ...FALLBACK_WATCHLIST, apiKey };
  }

  private isStablePair(syms: string[]): boolean {
    return syms.length === 2 && syms.every((s) => STABLES.has(String(s).toUpperCase()));
  }
  private poolLabel(p: any): { syms: string[]; dex: string; label: string } {
    const dex = String(p.dex_name ?? p.dex_id ?? "?");
    const syms = (p.tokens ?? []).map((t: any) => t.symbol ?? "?").slice(0, 2);
    return { syms, dex, label: `${syms.join("/")} (${dex})` };
  }

  // --- tier 1: candidate discovery ------------------------------------------
  // Page through each chain's small + recently-created pools and record the
  // latest snapshot (24h volume = the ranking key). Paced sequentially (REST is a
  // burst limiter); Retry-After is honored with a backoff. This builds the
  // rotation universe the stream draws from; it does NOT measure growth (that
  // comes from the live stream, since REST liquidity_usd barely moves per minute).
  private async scanCandidates(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const now = Date.now();
    const key = this.apiKey();
    const pages = envInt(this.env.SCAN_PAGES, key ? KEYED_SCAN_PAGES : DEFAULT_SCAN_PAGES);
    const spacing = key ? KEYED_PAGE_SPACING_MS : PAGE_SPACING_MS;
    const createdAfter = Math.floor((now - SCAN_AGE_DAYS * 86400_000) / 1000);
    const seenIds = new Set<string>(); // dedupe a pool that lands on two pages this scan
    // Keyed: scan the pro REST host; if its WAF ever 403s this (worker) IP, fall
    // back to the free host mid-scan so discovery never breaks.
    let base = key ? "https://api-pro.dexpaprika.com" : "https://api.dexpaprika.com";
    let headers: Record<string, string> = key
      ? { accept: "application/json", authorization: key }
      : { accept: "application/json" };
    let usingPro = !!key;
    let seen = 0;
    try {
      for (const chain of DYNAMIC_CHAINS) {
        let retries = 0;
        for (let page = 1; page <= pages; page++) {
          const url =
            `${base}/networks/${chain}/pools/filter` +
            `?liquidity_usd_min=${SCAN_LIQ_MIN}&liquidity_usd_max=${SCAN_LIQ_MAX}` +
            `&txns_24h_min=${SCAN_TXNS_MIN}&created_after=${createdAfter}` +
            `&sort_by=created_at&sort_dir=desc&limit=100&page=${page}`;
          let results: any[] = [];
          try {
            const r = await fetch(url, { headers });
            if (usingPro && (r.status === 401 || r.status === 403)) {
              this.note(`api-pro REST blocked from this host (${r.status}); falling back to free api`);
              base = "https://api.dexpaprika.com";
              headers = { accept: "application/json" };
              usingPro = false;
              page--; // retry this page on the free host
              continue;
            }
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
            const vol = Number(p.volume_usd_24h);
            if (!id || !Number.isFinite(liq) || liq <= 0) continue;
            if (seenIds.has(id)) continue; // count each pool once per scan
            seenIds.add(id);
            const { syms, dex, label } = this.poolLabel(p);
            if (SKIP_DEX.test(dex)) continue;
            if (this.isStablePair(syms)) continue;
            this.candidates.set(id, {
              label,
              chain,
              liqUsd: liq,
              volUsd: Number.isFinite(vol) ? vol : 0,
              t: now,
            });
            seen++;
          }
          await sleep(spacing);
        }
      }
    } finally {
      this.capCandidates();
      this.lastScanMs = Date.now();
      this.scanning = false;
    }
    if (seen) this.note(`scan ok: ${seen} candidates this cycle, ${this.candidates.size} in universe`);
  }

  private capCandidates(): void {
    if (this.candidates.size <= CAND_CAP) return;
    const byAge = [...this.candidates.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [id] of byAge.slice(0, this.candidates.size - CAND_CAP)) this.candidates.delete(id);
  }

  // The real "rising" signal: read from the live stream's quote-valued reserves,
  // not REST. growthPct is the change over STREAM_RISE_WINDOW_S; liqUsd is the
  // current real reserve. Same trustworthy data path that catches drains.
  private streamChange(subject: string, windowS: number): number | null {
    const pts = this.series.get(subject);
    if (!pts || pts.length < 3) return null;
    const now = Math.floor(Date.now() / 1000);
    const recent = pts.filter((p) => now - p.t <= windowS);
    if (recent.length < 3) return null;
    const first = recent[0].r;
    const last = recent[recent.length - 1].r;
    if (first <= 0) return null;
    return (last - first) / first;
  }

  private streamRisers(): Riser[] {
    const out: Riser[] = [];
    for (const subject of this.series.keys()) {
      const chg = this.streamChange(subject, STREAM_RISE_WINDOW_S);
      if (chg === null || chg < STREAM_RISE_THRESHOLD) continue;
      const m = this.meta.get(subject) ?? { label: subject, chain: "?" };
      out.push({ id: subject, label: m.label, chain: m.chain, growthPct: chg, liqUsd: this.lastReserve.get(subject) ?? 0 });
    }
    return out.sort((a, b) => b.growthPct - a.growthPct);
  }

  // Pools that must stay on the stream through rotation: anything moving (up or
  // down) past PIN_MOVE_THRESHOLD in the window, plus drains mid-confirmation.
  private pinnedIds(): Set<string> {
    const ids = new Set<string>();
    for (const subject of this.pending.keys()) ids.add(subject);
    for (const subject of this.series.keys()) {
      const chg = this.streamChange(subject, STREAM_RISE_WINDOW_S);
      if (chg !== null && Math.abs(chg) >= PIN_MOVE_THRESHOLD) ids.add(subject);
    }
    return ids;
  }

  // Build a WatchEntry for a pool id from whatever we know (stream meta first,
  // then the candidate snapshot). Null if we can't resolve its chain.
  private entryFor(id: string): WatchEntry | null {
    const m = this.meta.get(id);
    const c = this.candidates.get(id);
    const chain = m?.chain && m.chain !== "?" ? m.chain : c?.chain;
    if (!chain) return null;
    return { method: "pool_reserves", chain, address: id, label: m?.label ?? c?.label ?? id };
  }

  // Drop streamed state for pools no longer watched (and not mid-confirmation),
  // so streamRisers only reflects the current set and memory stays bounded.
  // Compared case-insensitively: series is keyed by the stream's echoed pool_id,
  // `keep` by the address we subscribed with, and the two can differ in case for
  // EVM pools. A case-sensitive miss would prune a still-subscribed pool every
  // tick and churn its history. Solana base58 keys stay matched (both lowered).
  private pruneStreamState(keep: Set<string>): void {
    const lkeep = new Set<string>();
    for (const a of keep) lkeep.add(a.toLowerCase());
    for (const k of [...this.series.keys()]) {
      if (lkeep.has(k.toLowerCase()) || this.pending.has(k)) continue;
      this.series.delete(k);
      this.meta.delete(k);
      this.lastReserve.delete(k);
    }
  }

  // Re-point the reserve stream: PIN the movers, ROTATE the rest. Rate-limited so
  // we don't thrash the subscription (a resubscribe drops in-flight non-pinned
  // series). Pinned pools (moving / mid-confirmation) always survive; the leftover
  // slots advance through the volume-ranked candidate universe so the fixed 74
  // slots sweep far more than 74 pools over time.
  private async maybeRepointStream(): Promise<void> {
    if (this.env.WATCHLIST) return; // explicit override wins
    const now = Date.now();
    if (now - this.lastStreamPickMs < STREAM_REFRESH_MS) return;
    const cap = this.streamTargets();
    // Candidate universe, ranked by 24h turnover (live, trustworthy field).
    const ranked = [...this.candidates.entries()]
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => b.volUsd - a.volUsd);
    if (ranked.length < cap) return; // not enough discovered yet; stay on cold-start list

    const prev = (await this.state.storage.get<WatchEntry[]>("streamWatchlist")) ?? [];
    const prevById = new Map(prev.map((w) => [w.address, w] as const));

    // 1. PINS: keep every pool currently mid-move so we see its whole lifecycle.
    const targets: WatchEntry[] = [];
    const taken = new Set<string>();
    for (const id of this.pinnedIds()) {
      if (targets.length >= cap) break;
      const w = prevById.get(id) ?? this.entryFor(id);
      if (w && !taken.has(w.address)) {
        targets.push(w);
        taken.add(w.address);
      }
    }
    const pinned = targets.length;

    // 2. ROTATION: fill the rest from the candidate list starting at a cursor that
    //    advances each refresh, so over several refreshes we cover the universe.
    let filled = 0;
    if (ranked.length) {
      let scanned = 0;
      for (let i = 0; i < ranked.length && targets.length < cap; i++) {
        scanned = i + 1;
        const c = ranked[(this.rotateCursor + i) % ranked.length];
        if (taken.has(c.id)) continue;
        taken.add(c.id);
        targets.push({ method: "pool_reserves", chain: c.chain, address: c.id, label: c.label });
        filled++;
      }
      // advance past everything examined (incl. pinned/taken pools skipped here),
      // so the next refresh starts on fresh candidates instead of re-scanning them
      this.rotateCursor = (this.rotateCursor + Math.max(scanned, 1)) % ranked.length;
    }

    this.lastStreamPickMs = now;
    // Nothing changed (all pins, no rotation room): skip a pointless resubscribe.
    const sameSet = prev.length === targets.length && targets.every((t) => prevById.has(t.address));
    if (sameSet) return;
    await this.state.storage.put("streamWatchlist", targets);
    this.pruneStreamState(new Set(targets.map((t) => t.address)));
    if (this.running) {
      this.radar?.stop(); // resubscribe with the new target set on the next ensureRunning
      this.radar = undefined; // own the teardown so the old radar's finally() is a no-op
      this.running = false;
    }
    this.note(`stream re-pointed: ${pinned} pinned + ${filled} rotated (cursor ${this.rotateCursor}/${ranked.length})`);
  }

  // Cold-start watchlist: most active pools by volume, used until the scanner has
  // discovered enough candidates to fill the rotate-and-pin stream selection.
  private async refreshWatchlist(): Promise<boolean> {
    const perChain = envInt(this.env.POOLS_PER_CHAIN, this.streamKey() ? KEYED_PER_CHAIN : DEFAULT_PER_CHAIN);
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

  // Record pools the live stream shows rising (the hypothesis: do these drain?).
  // Also snapshot the current risers so /api/live isn't blank right after a DO
  // eviction wipes the in-memory series.
  private async updateHypothesis(): Promise<void> {
    const risers = this.streamRisers();
    await this.state.storage.put("rising_snapshot", risers.slice(0, 20));
    const flagged = risers.filter((r) => r.liqUsd > 0 && r.liqUsd <= RUG_MAX_TVL);
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
    // rising / rug-watch come from the LIVE STREAM's real quote-valued reserves;
    // the snapshot is a fallback only for the moments right after a DO eviction.
    let risers = this.streamRisers();
    if (!risers.length) risers = (await this.state.storage.get<Riser[]>("rising_snapshot")) ?? [];
    const rising = risers.slice(0, 12).map((r) => ({ id: r.id, label: r.label, chain: r.chain, changePct: r.growthPct, reserveUsd: r.liqUsd }));
    const rugWatch = risers
      .filter((r) => r.liqUsd > 0 && r.liqUsd <= RUG_MAX_TVL)
      .slice(0, 8)
      .map((r) => ({ id: r.id, label: r.label, chain: r.chain, changePct: r.growthPct, reserveUsd: r.liqUsd }));

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
      scanning: this.candidates.size, // pools the REST scanner has discovered as rotation candidates
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
    const keyMode = this.apiKey()
      ? `Pro key: scanner keyed${this.streamKey() ? ", stream keyed (cap 7)" : ", stream KEYLESS (cap 3; keyed SSE blocked from worker IPs)"}`
      : "free tier (stream cap 3 connections)";
    const lastEvent = this.lastEventMs > 0 ? `${Math.round((now - this.lastEventMs) / 1000)}s ago` : "none yet";
    const lastRaw = this.lastRawMsgMs > 0 ? `${Math.round((now - this.lastRawMsgMs) / 1000)}s ago` : "none yet";
    const lastScan = this.lastScanMs > 0 ? `${Math.round((now - this.lastScanMs) / 1000)}s ago` : "not yet";
    const lastPost = gate.lastPostAtMs ? new Date(gate.lastPostAtMs).toISOString() : "never";
    const sentLabel = live ? "sent" : "would have sent";
    const totals = stats
      ? `${stats.drains} confirmed drains · ${stats.sent} ${sentLabel} · ${stats.suppressed} suppressed, since ${new Date(stats.sinceMs).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "no drains yet";
    const paused = now < gate.pausedUntilMs
      ? `<p><strong>sending paused until ${escapeHtml(new Date(gate.pausedUntilMs).toISOString())}</strong></p>` : "";
    const postError = gate.lastPostError ? `<p>last send error: <code>${escapeHtml(gate.lastPostError)}</code></p>` : "";
    const issues = this.issues.length
      ? `<h2>Recent issues</h2><ul>${this.issues.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("")}</ul>` : "";
    const rows = recent
      .map((r) => {
        const a = r.alert;
        const drain = a.kind === "drain";
        const icon = drain
          ? `<span style="color:#ff4d6d">&#9660;</span>` // down triangle
          : `<span style="color:#00c853">&#9650;</span>`; // up triangle
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
<p>mode: <strong>${escapeHtml(mode)}</strong> · ${escapeHtml(keyMode)}<br>
stream: ${escapeHtml(this.configSource)}<br>
stream health: ${this.streamStarts} starts · ${this.streamErrCount} errors${this.lastStreamErr ? ` · last err: <code>${escapeHtml(this.lastStreamErr)}</code>` : ""}<br>
scanner: ${this.candidates.size} candidates discovered · last scan ${escapeHtml(lastScan)}<br>
${escapeHtml(this.thresholds)}<br>last raw msg incl ping: ${escapeHtml(lastRaw)} · last reserve event: ${escapeHtml(lastEvent)} · last sent: ${escapeHtml(lastPost)}<br>
<strong>${escapeHtml(totals)}</strong></p>
${paused}${postError}
<h2>Recent drains</h2>
<ul style="list-style:none;padding:0">${rows || "<li>nothing caught yet</li>"}</ul>
${issues}
<p style="color:#666;margin-top:24px"><a href="/">← live dashboard</a> · <a href="https://github.com/coinpaprika/liquidity-radar">source</a></p>
</body>`;
  }
}
