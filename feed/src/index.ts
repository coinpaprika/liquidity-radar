// LiquidityRadar live feed: Cloudflare Worker + Durable Object.
//
// Two tiers:
//  1. REST scanner = candidate DISCOVERY (cheap, thousands of pools): every
//     SCAN_INTERVAL the DO cursor-pages through small + recently-created pools on
//     each chain via /networks/{chain}/pools/search and ranks them by a rug-risk
//     score (age x churn x thin-float x wash). It does NOT try to measure liquidity
//     growth: liquidity_usd is a coarse aggregate that barely moves minute-to-minute
//     (calibrated live), so a "rising" signal can't be read from it. Young,
//     high-turnover pools are the rug-prone set worth a scarce stream slot.
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
  rugScore,
  QUOTE_TOKENS,
  validateRadarConfig,
  type Alert,
  type Radar,
  type RadarConfig,
  type ReserveEvent,
  type WatchEntry,
} from "../../core/src/index.js";
import { isLive, postAlert, type SinkEnv } from "./webhook.js";
import { LANDING_HTML } from "./page.js";
import { RADAR_HTML } from "./radar.js";
import bundledWatchlist from "../../watchlist.json";

export interface Env extends SinkEnv {
  RADAR: DurableObjectNamespace;
  WATCHLIST?: string; // JSON RadarConfig override; if unset, the scanner picks the stream targets
  POST_COOLDOWN_MINUTES?: string;
  POSTS_PER_HOUR?: string;
  POST_SUFFIX?: string;
  MIN_DRAIN_USD?: string; // min absolute USD move to flag (overrides watchlist.json minUsd; small pools need a low floor)
  DRAIN_PCT?: string; // min fraction of reserve to flag, e.g. 0.2 (overrides watchlist.json pctThreshold)
  RUG_COMPLETENESS?: string; // fraction pulled (with token liquidity gone) to label a confirmed drain a "rug" (default 0.8)
  MIGRATION_MIN_USD?: string; // token liquidity left elsewhere to label a drain a "migration" not a rug (default 5000)
  DRAIN_CONFIRM_SECONDS?: string; // a drain must persist this long before sending (default 90)
  POST_ADDS?: string; // "1" to also post liquidity adds (default off)
  POOLS_PER_CHAIN?: string; // cold-start volume watchlist size per chain (default 37)
  SCAN_PAGES?: string; // pools/search pages (cursor hops) scanned per chain each cycle (100 pools/page)
  SCAN_INTERVAL_SECONDS?: string; // liquidity scan cadence (default 60; liquidity_usd refreshes ~20-30s)
  ENRICH_POOLS?: string; // key-gated: top-N candidates to deep-probe via getPoolDetails (default 24, 0 = off)
  DEXPAPRIKA_API_KEY?: string; // optional Pro/Enterprise key: lifts the stream cap 3->7 connections
  STREAM_MAX_AGE_SECONDS?: string; // proactively recycle the subscription this often (default 600)
  STREAM_KEYLESS?: string; // "1": don't send the key on the STREAM (scanner still keyed). For Cloudflare
  // Workers, where the keyed SSE delivers pings but no data (WAF on keyed stream from worker IPs).
}

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const ALARM_INTERVAL_MS = 30_000;
const PERSIST_FRACTION = 0.5; // confirmed if, after the hold, the reserve is still down by >= this fraction of the DRAIN (i.e. it didn't refill); works for small and large drains alike
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
const MAX_429_RETRIES = 1; // consecutive 429s on a page before giving up (bounds alarm wall-clock; recover next cycle)
const MAX_BACKOFF_S = 20; // cap an over-large Retry-After (Retry-After is ~20s; don't sleep longer)
const SCAN_LIQ_MIN = 3_000; // discover small pools too: PumpSwap rugs happen at low liquidity (skip only true dust)
const SCAN_LIQ_MAX = 2_000_000; // skip blue-chips: they don't rug
const SCAN_TXNS_MIN = 50; // must be active
const SCAN_AGE_DAYS = 7; // recently created = rug-prone
const CAND_CAP = 3000; // discovered candidate pools held in memory (bound)
const RUG_MAX_TVL = 750_000; // high-risk subset: small pool (rug-watch + hypothesis)
const STREAM_REFRESH_MS = 5 * 60 * 1000; // rotate/re-point the stream at most this often
// Candidate enrichment (key-gated booster, runs on the scan cadence): deep-probe
// the top rug-scored candidates via getPoolDetails to add short-window sell-skew
// (sharpens selection) and a per-swap-fresh quote reserve (promotes movers to the
// stream). Free tier ranks on the pools/search score alone; no detail calls.
const ENRICH_TOP_N = 24; // top candidates to deep-probe each scan cycle
const ENRICH_CONCURRENCY = 2; // bounded: 2 REST + up to 3 keyless stream conns + 1 spare <= Workers ~6 ceiling
const ENRICH_FETCH_TIMEOUT_MS = 5_000; // per getPoolDetails call: a hung origin must never pin a worker
const ENRICH_DEADLINE_MS = 20_000; // hard cap on the whole enrich pass, so it can't dominate the alarm
const PROMOTE_MOVE_PCT = 0.15; // quote-reserve move between probes that promotes a pool to the stream
const PROMOTE_TTL_MS = 4 * 60 * 1000; // a REST-promoted pin lasts this long (until the stream takes over)
// Brand-new pools: /pools/search reports liquidity_usd=0 until the index backfills
// TVL (~a week), but volume/txns are live from block one. A liquidity-filtered scan
// therefore CAN'T see the freshest pools, which is exactly where rugs happen. So we
// pull the newest high-volume pools and deep-probe the top few via getPoolDetails to
// read their REAL liquidity before admitting them. Bounded so it can't storm REST.
const FRESH_ENRICH_KEYED = 40; // top-volume fresh pools to probe per chain (keyed: no burst limit)
const FRESH_ENRICH_FREE = 6; // free tier: tiny (REST is a burst limiter shared with the stream)
const FRESH_DEADLINE_MS = 15_000; // hard cap on the fresh-pool enrichment pass
// Intent classification of a CONFIRMED drain (defaults; env-overridable). We can't
// know intent for sure, so this is a labelled inference from observable signals.
const RUG_COMPLETENESS = 0.8; // pulled >= this fraction of the pool, token liquidity gone => "rug"
const MIGRATION_MIN_USD = 5_000; // token liquidity elsewhere >= this (and >= pulled) => "migration"
const CLASSIFY_TIMEOUT_MS = 5_000; // per token-liquidity lookup at confirm time
const CLASSIFY_MAX_PER_CYCLE = 8; // bound the confirm-time lookups so a burst can't stall the alarm (rest commit as "unknown")
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
function envFloat(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const FALLBACK_WATCHLIST = bundledWatchlist as unknown as RadarConfig;

// How a confirmed drain reads, inferred from observable signals (never certain):
//   rug       = pool gutted AND the token has little/no liquidity left anywhere
//   migration = liquidity still lives in another pool for this token (it moved)
//   exit      = a partial pull, not gutted, no clear migration
//   unknown   = couldn't fetch the token's liquidity to judge
type DrainIntent = "rug" | "migration" | "exit" | "unknown";

interface RecentEntry {
  alert: Alert;
  posted: boolean;
  reason?: string;
  intent?: DrainIntent;
}
interface Stats {
  drains: number;
  sent: number;
  suppressed: number;
  rugs: number; // confirmed drains classified as a likely rug
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
// score (rug-risk prior) is the ranking key; the raw fields feed it.
interface Candidate {
  label: string;
  chain: string;
  liqUsd: number;
  volUsd: number;
  ageHours: number;
  txns: number;
  fdv: number; // risky (non-quote) token FDV; 0 = unknown
  score: number; // composite rug-risk prior (rugScore)
  // enrichment, set only when the candidate is deep-probed via getPoolDetails:
  reserveUsd?: number; // quote-valued reserve (per-swap fresh), for mover promotion
  priceTime?: number; // last-swap epoch seconds (freshness guard for promotion)
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
const emptyStats = (now: number): Stats => ({ drains: 0, sent: 0, suppressed: 0, rugs: 0, sinceMs: now });

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
    if (!["/", "/radar", "/api/live", "/status"].includes(url.pathname)) {
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
  private meta = new Map<string, { label: string; chain: string; token?: string }>();
  private candidates = new Map<string, Candidate>(); // discovered pools (rotation universe)
  private rotateCursor = 0; // advances each repoint so rotation sweeps the universe
  private activeAddrs = new Set<string>(); // addresses the current radar is subscribed to
  private promoted = new Map<string, { chain: string; label: string; t: number }>(); // REST-detected movers pinned to the stream
  private lastEnrich = ""; // last enrichment summary, for /status

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
    if (url.pathname === "/radar") {
      return new Response(RADAR_HTML, {
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
      await this.enrichTopCandidates(); // key-gated: sharpen top scores + promote REST-detected movers
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
          // remember the non-quote (risky) token mint so a confirmed drain can
          // check whether the token's liquidity vanished (rug) or moved (migration)
          let token: string | undefined;
          if (event.type === "pool_reserves") {
            for (const leg of event.tokens) {
              const id = leg.token_id;
              if (!(QUOTE_TOKENS.has(id) || QUOTE_TOKENS.has(id.toLowerCase()))) { token = id; break; }
            }
          }
          this.meta.set(subject, { label: entry.label ?? subject, chain: event.chain, token });
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
  // Drain thresholds for the dynamic stream config. Small PumpSwap pools rug for
  // a few thousand USD, well below watchlist.json's blue-chip-oriented default, so
  // these are env-overridable (tune live, no redeploy) and default LOW.
  private drainThresholds(): { minUsd: number; pctThreshold: number } {
    return {
      minUsd: envInt(this.env.MIN_DRAIN_USD, FALLBACK_WATCHLIST.minUsd ?? 25_000),
      pctThreshold: envFloat(this.env.DRAIN_PCT, FALLBACK_WATCHLIST.pctThreshold ?? 0.1),
    };
  }

  private async activeConfig(): Promise<RadarConfig> {
    const apiKey = this.streamKey();
    const { minUsd, pctThreshold } = this.drainThresholds();
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
      return { minUsd, pctThreshold, watch: stream, apiKey };
    }
    // cold start: stream the most active pools until the scanner has growth data
    let dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    if (!dyn || !dyn.length) {
      await this.refreshWatchlist();
      dyn = await this.state.storage.get<WatchEntry[]>("dynamicWatchlist");
    }
    if (dyn && dyn.length) {
      this.configSource = `cold start: ${dyn.length} most-active pools (scanner warming up)`;
      return { minUsd, pctThreshold, watch: dyn, apiKey };
    }
    this.configSource = `bundled watchlist.json (${FALLBACK_WATCHLIST.watch.length} pools)`;
    return { ...FALLBACK_WATCHLIST, minUsd, pctThreshold, apiKey };
  }

  private isStablePair(syms: string[]): boolean {
    return syms.length === 2 && syms.every((s) => STABLES.has(String(s).toUpperCase()));
  }
  private poolLabel(p: any): { syms: string[]; dex: string; label: string } {
    const dex = String(p.dex_name ?? p.dex_id ?? "?");
    const syms = (p.tokens ?? []).map((t: any) => t.symbol ?? "?").slice(0, 2);
    return { syms, dex, label: `${syms.join("/")} (${dex})` };
  }
  private ageHours(createdAt: unknown): number {
    const ms = Date.parse(String(createdAt ?? ""));
    return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 3_600_000) : NaN;
  }
  // FDV of the risky (non-quote) leg. The quote token (USDC/SOL/...) has a huge,
  // irrelevant FDV, so pick the non-quote token. A quote/quote pair (e.g.
  // SOL/WETH) has no risky leg, so FDV is "unknown" (0), never the quote's FDV.
  private riskyFdv(p: any): number {
    const toks = (p.tokens ?? []) as any[];
    const risky = toks.filter((t) => {
      const id = String(t.id ?? "");
      return !(QUOTE_TOKENS.has(id) || QUOTE_TOKENS.has(id.toLowerCase()));
    });
    if (!risky.length) return 0; // quote/quote: unknown FDV, not the quote's
    let fdv = 0;
    for (const t of risky) {
      const v = Number(t.fdv);
      if (Number.isFinite(v) && v > fdv) fdv = v;
    }
    return fdv;
  }

  // --- tier 1: candidate discovery ------------------------------------------
  // Build the rotation universe the stream draws from, ranked by a rug-risk score
  // (age x churn x thin-float x wash), NOT raw volume. Two passes per chain, both
  // over /pools/search (the /pools/filter and plain /pools endpoints were removed
  // in the June-2026 API consolidation; search is cursor-paginated, not page=N):
  //   1. LIQUID  - established rug-prone pools; real liquidity is in the index.
  //   2. FRESH   - brand-new pools whose liquidity_usd the index reports as 0 until
  //                it backfills TVL; deep-probed via getPoolDetails for real values.
  // It does NOT measure growth (that comes from the live stream, since REST
  // liquidity_usd barely moves per minute). Paced (REST is a burst limiter).
  private async scanCandidates(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const now = Date.now();
    const key = this.apiKey();
    const pages = envInt(this.env.SCAN_PAGES, key ? KEYED_SCAN_PAGES : DEFAULT_SCAN_PAGES);
    const spacing = key ? KEYED_PAGE_SPACING_MS : PAGE_SPACING_MS;
    const createdAfter = Math.floor((now - SCAN_AGE_DAYS * 86400_000) / 1000);
    const seenIds = new Set<string>(); // dedupe a pool seen across passes/pages this scan
    // Keyed: scan the pro REST host; if its WAF ever 403s this (worker) IP, fall
    // back to the free host mid-scan so discovery never breaks.
    let base = key ? "https://api-pro.dexpaprika.com" : "https://api.dexpaprika.com";
    let headers: Record<string, string> = key
      ? { accept: "application/json", authorization: key }
      : { accept: "application/json" };
    let usingPro = !!key;
    let seen = 0;
    const freshRaw: { chain: string; p: any }[] = []; // fresh pools to enrich for real liquidity

    // GET one /pools/search page: fall off api-pro on a WAF block, honor one
    // Retry-After backoff, and LOG a non-OK status before giving up so a future
    // endpoint removal can't fail silently the way /pools/filter did. Returns the
    // page's results plus the next cursor ("" when there is no next page).
    const getPage = async (chain: string, query: string, cursor: string, tag: string): Promise<{ results: any[]; next: string } | null> => {
      let rl = 0; // 429 retries (bounded; one-time host fallback is separate and can't loop)
      for (;;) {
        const url = `${base}/networks/${chain}/pools/search?${query}&limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        let r: Response;
        try {
          r = await fetch(url, { headers });
        } catch (e) {
          this.note(`scan ${chain} ${tag}: ${String(e)}`);
          return null;
        }
        if (usingPro && (r.status === 401 || r.status === 403)) {
          this.note(`api-pro REST blocked from this host (${r.status}); falling back to free api`);
          base = "https://api.dexpaprika.com";
          headers = { accept: "application/json" };
          usingPro = false; // flips off, so this branch can't loop
          continue; // retry the same page on the free host
        }
        if (r.status === 429) {
          if (rl++ >= MAX_429_RETRIES) {
            this.note(`scan ${chain} ${tag} still 429 after ${rl} retries; skipping`);
            return null;
          }
          const wait = Math.min(envInt(r.headers.get("retry-after") ?? undefined, 20), MAX_BACKOFF_S);
          this.note(`scan ${chain} ${tag} rate-limited, backing off ${wait}s`);
          await sleep(wait * 1000);
          continue;
        }
        if (!r.ok) {
          this.note(`scan ${chain} ${tag}: HTTP ${r.status}`); // visible, not swallowed
          return null;
        }
        try {
          const j = (await r.json()) as { results?: any[]; next_cursor?: string; has_next_page?: boolean };
          return { results: j.results ?? [], next: j.has_next_page && j.next_cursor ? j.next_cursor : "" };
        } catch (e) {
          this.note(`scan ${chain} ${tag}: bad json ${String(e)}`);
          return null;
        }
      }
    };

    try {
      for (const chain of DYNAMIC_CHAINS) {
        // PASS 1 - established, rug-prone pools: real liquidity is in the index.
        let cursor = "";
        for (let page = 0; page < pages; page++) {
          const q = `liquidity_usd_min=${SCAN_LIQ_MIN}&liquidity_usd_max=${SCAN_LIQ_MAX}&txns_24h_min=${SCAN_TXNS_MIN}`;
          const pg = await getPage(chain, q, cursor, `liquid p${page}`);
          if (!pg || !pg.results.length) break;
          for (const p of pg.results) {
            const id = String(p.id ?? "");
            const liq = Number(p.liquidity_usd);
            if (!id || seenIds.has(id) || !Number.isFinite(liq) || liq <= 0) continue;
            const { syms, dex, label } = this.poolLabel(p);
            if (SKIP_DEX.test(dex) || this.isStablePair(syms)) continue;
            seenIds.add(id);
            this.storeCandidate(id, chain, label, liq, p, now);
            seen++;
          }
          if (!pg.next) break;
          cursor = pg.next;
          await sleep(spacing);
        }
        // PASS 2 - collect brand-new pools (one page; the API sorts by 24h volume).
        const fresh = await getPage(chain, `created_after=${createdAfter}&txns_24h_min=${SCAN_TXNS_MIN}`, "", "fresh");
        if (fresh) {
          for (const p of fresh.results) {
            const id = String(p.id ?? "");
            if (!id || seenIds.has(id) || this.candidates.has(id)) continue; // already known
            const { syms, dex } = this.poolLabel(p);
            if (SKIP_DEX.test(dex) || this.isStablePair(syms)) continue; // stable check is best-effort here (search rows carry no symbols); re-checked after enrichment
            freshRaw.push({ chain, p });
          }
        }
      }

      // Deep-probe the highest-volume fresh pools to read their REAL liquidity, then
      // admit the ones inside the scan's liquidity band. Bounded N + concurrency +
      // deadline so it can't storm REST or starve the stream's connections.
      const freshN = key ? FRESH_ENRICH_KEYED : FRESH_ENRICH_FREE;
      const topFresh = freshRaw
        .sort((a, b) => (Number(b.p.volume_usd_24h) || 0) - (Number(a.p.volume_usd_24h) || 0))
        .slice(0, freshN);
      await this.mapLimit(topFresh, ENRICH_CONCURRENCY, FRESH_DEADLINE_MS, async ({ chain, p }) => {
        const id = String(p.id);
        if (seenIds.has(id)) return;
        const d = await this.fetchPoolDetail(chain, id, key);
        if (!d) return;
        const liq = Number(d.liquidity_usd);
        if (!Number.isFinite(liq) || liq < SCAN_LIQ_MIN || liq > SCAN_LIQ_MAX) return; // outside our band
        const dsyms = ((d.tokens ?? []) as any[]).map((t) => t?.symbol ?? "?").slice(0, 2);
        const ddex = String(d.dex_name ?? d.dex_id ?? "?");
        if (SKIP_DEX.test(ddex) || this.isStablePair(dsyms)) return;
        seenIds.add(id);
        const label = this.labelFromDetail(d) ?? this.poolLabel(p).label;
        this.storeCandidate(id, chain, label, liq, p, now, d);
        seen++;
      });
    } finally {
      this.capCandidates();
      this.lastScanMs = Date.now();
      this.scanning = false;
    }
    if (seen) this.note(`scan ok: ${seen} candidates this cycle, ${this.candidates.size} in universe`);
  }

  // Build+store a Candidate from a /pools/search row, and optionally a
  // getPoolDetails payload `d` (fresh pools) which carries real fdv, a quote-valued
  // reserve, short-window sell-skew, and a proper pair label the search row lacks.
  private storeCandidate(id: string, chain: string, label: string, liq: number, p: any, now: number, d?: any): void {
    const vol = Number(p.volume_usd_24h);
    const volUsd = Number.isFinite(vol) ? vol : 0;
    const ageHours = this.ageHours(p.created_at ?? d?.created_at);
    const txns = Number(p.transactions_24h) || 0;
    const fdv = d ? this.riskyFdv(d) : this.riskyFdv(p);
    const sellSkew = d ? this.shortSellSkew(d) : undefined;
    const reserveUsd = d ? this.quoteReserveOf(d.token_reserves) : NaN;
    const priceTime = d ? Date.parse(String(d.price_time ?? "")) / 1000 : NaN;
    const prev = this.candidates.get(id);
    this.candidates.set(id, {
      label,
      chain,
      liqUsd: liq,
      volUsd,
      ageHours,
      txns,
      fdv,
      score: rugScore({ ageHours, liqUsd: liq, volUsd, txns, fdv, sellSkew }),
      // preserve the last enrichment so promotion can compare across cycles
      reserveUsd: Number.isFinite(reserveUsd) ? reserveUsd : prev?.reserveUsd,
      priceTime: Number.isFinite(priceTime) ? priceTime : prev?.priceTime,
      t: now,
    });
  }

  // Real pair label from a getPoolDetails payload (its tokens[] carry symbols;
  // /pools/search rows don't, so discovered candidates read "?/?" until enriched).
  private labelFromDetail(d: any): string | null {
    const syms = ((d?.tokens ?? []) as any[]).map((t) => t?.symbol).filter(Boolean).slice(0, 2);
    if (syms.length < 2) return null;
    return `${syms.join("/")} (${String(d?.dex_name ?? d?.dex_id ?? "?")})`;
  }

  private capCandidates(): void {
    if (this.candidates.size <= CAND_CAP) return;
    const byAge = [...this.candidates.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [id] of byAge.slice(0, this.candidates.size - CAND_CAP)) this.candidates.delete(id);
  }

  // --- tier 1b: enrichment (key-gated booster) ------------------------------
  // Deep-probe the top rug-scored candidates via getPoolDetails to (P2) sharpen
  // their score with short-window sell-skew and (P3) read a per-swap-fresh quote
  // reserve and PROMOTE pools whose reserve just moved sharply onto the stream
  // (a wide REST pre-filter the 74 slots can't cover by rotation alone). Bounded
  // N and concurrency so it never starves the alarm or the stream's connections.
  // Free tier (no key) skips this entirely and ranks on the pools/search score.
  private async enrichTopCandidates(): Promise<void> {
    const key = this.apiKey();
    if (!key) return;
    const n = envInt(this.env.ENRICH_POOLS, ENRICH_TOP_N);
    if (n <= 0 || this.candidates.size === 0) return;
    const top = [...this.candidates.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, n);
    let probed = 0;
    let promotedNow = 0;
    await this.mapLimit(top, ENRICH_CONCURRENCY, ENRICH_DEADLINE_MS, async ([id, c]) => {
      const d = await this.fetchPoolDetail(c.chain, id, key);
      if (!d) return;
      probed++;
      const reserveUsd = this.quoteReserveOf(d.token_reserves);
      const priceTime = Date.parse(String(d.price_time ?? "")) / 1000;
      const sellSkew = this.shortSellSkew(d);
      // P3: a sharp quote-reserve move since the last fresh probe = promote to the
      // stream so it gets block-level confirmation. price_time must advance, else a
      // quiet pool's frozen snapshot reads as a phantom move.
      if (
        c.reserveUsd !== undefined && c.reserveUsd > 0 && Number.isFinite(reserveUsd) &&
        c.priceTime !== undefined && Number.isFinite(priceTime) && priceTime > c.priceTime &&
        Math.abs(reserveUsd - c.reserveUsd) / c.reserveUsd >= PROMOTE_MOVE_PCT
      ) {
        this.promoted.set(id, { chain: c.chain, label: c.label, t: Date.now() });
        promotedNow++;
      }
      // P2: fold sell-skew into the score; backfill the real label/fdv the search
      // row lacked; persist the fresh reserve for next cycle.
      const label = this.labelFromDetail(d) ?? c.label;
      const fdv = this.riskyFdv(d) || c.fdv;
      const score = rugScore({ ageHours: c.ageHours, liqUsd: c.liqUsd, volUsd: c.volUsd, txns: c.txns, fdv, sellSkew });
      this.candidates.set(id, { ...c, label, fdv, score, reserveUsd: Number.isFinite(reserveUsd) ? reserveUsd : c.reserveUsd, priceTime: Number.isFinite(priceTime) ? priceTime : c.priceTime, t: c.t });
    });
    // expire stale promotions (the stream's own pinning takes over once it sees the move)
    for (const [id, m] of this.promoted) if (Date.now() - m.t > PROMOTE_TTL_MS) this.promoted.delete(id);
    this.lastEnrich = `enriched ${probed}/${top.length}, ${promotedNow} promoted, ${this.promoted.size} pinned`;
    if (probed) this.note(`enrich ok: ${this.lastEnrich}`);
  }

  // Run fn over items with bounded concurrency (stay under the Workers/stream
  // outbound-connection ceiling) AND a wall-clock deadline (stop pulling new items
  // past it, so the pass can never dominate the alarm). Errors swallowed per-item.
  private async mapLimit<T>(items: T[], limit: number, deadlineMs: number, fn: (x: T) => Promise<void>): Promise<void> {
    let i = 0;
    const deadline = Date.now() + deadlineMs;
    const worker = async () => {
      while (i < items.length && Date.now() < deadline) {
        const idx = i++;
        try {
          await fn(items[idx]);
        } catch (e) {
          this.note(`enrich item failed: ${String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  // getPoolDetails with the key on api-pro; on a WAF 401/403 from this host, retry
  // once on the free host so enrichment still works from worker IPs. Each call is
  // hard-bounded by a timeout: a hung origin must never pin an enrich worker and
  // stall the alarm (and with it the stream watchdog).
  private async fetchPoolDetail(chain: string, id: string, key?: string): Promise<any | null> {
    const hosts: [string, Record<string, string>][] = key
      ? [
          ["https://api-pro.dexpaprika.com", { accept: "application/json", authorization: key }],
          ["https://api.dexpaprika.com", { accept: "application/json" }],
        ]
      : [["https://api.dexpaprika.com", { accept: "application/json" }]];
    for (const [base, headers] of hosts) {
      try {
        const r = await fetch(`${base}/networks/${chain}/pools/${id}`, {
          headers,
          signal: AbortSignal.timeout(ENRICH_FETCH_TIMEOUT_MS),
        });
        if (r.status === 401 || r.status === 403) continue; // try the next host
        if (!r.ok) return null;
        return await r.json();
      } catch {
        continue; // timeout / network: skip this pool (and host)
      }
    }
    return null;
  }

  // Quote-valued reserve from a getPoolDetails token_reserves[] (same QUOTE_TOKENS
  // basis the stream uses): sum the reserve_usd of the SOL/USDC/USDT/... legs.
  private quoteReserveOf(tokenReserves: unknown): number {
    if (!Array.isArray(tokenReserves)) return NaN;
    let sum = 0;
    let quoted = false;
    for (const leg of tokenReserves as any[]) {
      const tid = String(leg?.token_id ?? "");
      if (QUOTE_TOKENS.has(tid) || QUOTE_TOKENS.has(tid.toLowerCase())) {
        const v = Number(leg?.reserve_usd);
        if (Number.isFinite(v)) {
          sum += v;
          quoted = true;
        }
      }
    }
    return quoted ? sum : NaN; // meme/meme pair: no trustworthy quote leg
  }

  // Short-window sell pressure from getPoolDetails: sell/(buy+sell) over 5m (with
  // a 15m fallback when 5m is too thin to be meaningful). NaN if no flow.
  private shortSellSkew(d: any): number | undefined {
    for (const w of ["5m", "15m"]) {
      const buy = Number(d?.[w]?.buy_usd);
      const sell = Number(d?.[w]?.sell_usd);
      const total = (Number.isFinite(buy) ? buy : 0) + (Number.isFinite(sell) ? sell : 0);
      if (total > 0) return (Number.isFinite(sell) ? sell : 0) / total;
    }
    return undefined;
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
  // down) past PIN_MOVE_THRESHOLD in the window, plus drains mid-confirmation,
  // plus pools the REST enrichment pass just flagged as movers (within TTL).
  private pinnedIds(): Set<string> {
    const ids = new Set<string>();
    for (const subject of this.pending.keys()) ids.add(subject);
    for (const subject of this.series.keys()) {
      const chg = this.streamChange(subject, STREAM_RISE_WINDOW_S);
      if (chg !== null && Math.abs(chg) >= PIN_MOVE_THRESHOLD) ids.add(subject);
    }
    const now = Date.now();
    for (const [id, m] of this.promoted) {
      if (now - m.t <= PROMOTE_TTL_MS) ids.add(id);
      else this.promoted.delete(id);
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
    // Candidate universe, ranked by composite rug-risk score (age x churn x thin
    // float x wash, plus enrichment sell-skew), NOT raw volume: that wasted slots
    // on huge blue chips that never rug.
    const ranked = [...this.candidates.entries()]
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => b.score - a.score);
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
      let cursor = ""; // /pools/search is cursor-paginated (page=N is ignored); it defaults to order_by=volume_usd_24h, which is what a cold-start list wants
      for (let page = 0; page < 2 && kept < perChain; page++) {
        let j: { results?: any[]; next_cursor?: string; has_next_page?: boolean };
        try {
          const url = `https://api.dexpaprika.com/networks/${chain}/pools/search?limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
          const r = await fetch(url, { headers: { accept: "application/json" } });
          if (!r.ok) {
            this.note(`watchlist refresh ${chain} p${page}: HTTP ${r.status}`);
            break;
          }
          j = await r.json();
        } catch (e) {
          this.note(`watchlist refresh ${chain} p${page}: ${String(e)}`);
          break;
        }
        const pools = j.results ?? [];
        if (!pools.length) break;
        for (const p of pools) {
          if (kept >= perChain) break;
          const { syms, dex, label } = this.poolLabel(p);
          if (SKIP_DEX.test(dex)) continue;
          if (this.isStablePair(syms)) continue;
          out.push({ method: "pool_reserves", chain, address: p.id, label });
          kept++;
        }
        if (!j.has_next_page || !j.next_cursor) break;
        cursor = j.next_cursor;
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
    let classified = 0;
    for (const [subject, p] of [...this.pending]) {
      if (now - p.atMs < confirmMs) continue;
      this.pending.delete(subject);
      const cur = this.lastReserve.get(subject);
      // "Held" = the reserve has not refilled most of the drained amount. Measured
      // against the DRAIN itself, not an absolute fraction of the pre-drain size,
      // so a small drain ($250 off a $10k pool) confirms when it sticks, instead
      // of being wrongly suppressed for not having halved the whole pool.
      const drainAmt = Math.abs(p.alert.deltaUsd);
      const stillDrained = cur === undefined ? true : cur <= p.prevReserveUsd - PERSIST_FRACTION * drainAmt;
      if (stillDrained) {
        // Cumulative fraction of the pool gone from the pre-drain baseline to the
        // reserve now (both known here). This, not a single frozen stream event's
        // pct, is what tells a full rug from a partial exit. undefined when we have
        // no current reserve -> classifyDrain must not guess "rug".
        const completeness = cur === undefined || !(p.prevReserveUsd > 0)
          ? undefined
          : Math.min(Math.max(0, (p.prevReserveUsd - cur) / p.prevReserveUsd), 1);
        // bound confirm-time lookups per cycle; a burst commits as "unknown" rather than stalling the alarm
        const intent = classified < CLASSIFY_MAX_PER_CYCLE ? await this.classifyDrain(p.alert, completeness) : "unknown";
        classified++;
        await this.commit(p.alert, intent);
      } else {
        await this.record(p.alert, false, "suppressed: refilled");
        await this.bumpStats({ drains: 1, suppressed: 1 });
      }
    }
  }

  private async commit(alert: Alert, intent?: DrainIntent): Promise<void> {
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
      const tag = alert.kind === "drain" && intent ? `\n${this.intentLabel(intent)}` : "";
      const result = await postAlert(formatAlert(alert) + tag + suffix, alert, this.env);
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
    await this.record(alert, !reason, reason, intent);
    await this.bumpStats({ drains: 1, sent: reason ? 0 : 1, rugs: intent === "rug" ? 1 : 0 });
    if (alert.kind === "drain") {
      const dr = (await this.state.storage.get<Record<string, HypMark>>("hyp_dr")) ?? {};
      dr[alert.subject] = { label: alert.label ?? alert.subject, chain: alert.chain, t: now, pct: alert.pct };
      await this.state.storage.put("hyp_dr", capObject(dr, HYP_CAP));
    }
  }

  private async record(alert: Alert, posted: boolean, reason?: string, intent?: DrainIntent): Promise<void> {
    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    recent.unshift({ alert, posted, reason, intent });
    await this.state.storage.put("recent", recent.slice(0, RECENT_CAP));
  }

  private async bumpStats(d: { drains?: number; sent?: number; suppressed?: number; rugs?: number }): Promise<void> {
    const s = (await this.state.storage.get<Stats>("stats")) ?? emptyStats(Date.now());
    s.drains += d.drains ?? 0;
    s.sent += d.sent ?? 0;
    s.suppressed += d.suppressed ?? 0;
    s.rugs = (s.rugs ?? 0) + (d.rugs ?? 0);
    await this.state.storage.put("stats", s);
  }

  // Intent classification of a CONFIRMED drain. We can't know intent for sure, so
  // this is a labelled inference: did the token's liquidity vanish (rug) or move
  // to another pool (migration)? `summary.liquidity_usd` from getTokenDetails is
  // the token's TOTAL liquidity across all its pools; subtracting this gutted
  // pool's residual leaves what lives elsewhere.
  private async classifyDrain(alert: Alert, completeness?: number): Promise<DrainIntent> {
    const rugC = envFloat(this.env.RUG_COMPLETENESS, RUG_COMPLETENESS);
    const migMin = envInt(this.env.MIGRATION_MIN_USD, MIGRATION_MIN_USD);
    // cumulative fraction of the pool drained (from resolvePending's baseline-to-now
    // reserve); undefined = current reserve unknown, so completeness can't be judged.
    const comp = typeof completeness === "number" && Number.isFinite(completeness)
      ? Math.min(Math.max(0, completeness), 1)
      : undefined;
    const token = this.meta.get(alert.subject)?.token;
    if (token) {
      const tokenLiq = await this.fetchTokenLiquidity(alert.chain, token);
      if (tokenLiq !== null) {
        const otherLiq = Math.max(0, tokenLiq - 2 * (alert.reserveUsd || 0));
        if (otherLiq >= Math.max(migMin, alert.prevReserveUsd)) return "migration";
      }
    }
    if (comp === undefined) return "unknown"; // no clear migration and completeness unknown: don't guess "rug"
    return comp >= rugC ? "rug" : "exit";
  }

  private intentLabel(intent: DrainIntent): string {
    return intent === "rug"
      ? "likely rug (liquidity gone)"
      : intent === "migration"
        ? "liquidity migrated elsewhere"
        : intent === "exit"
          ? "partial exit"
          : "";
  }

  // Token-level total liquidity (getTokenDetails.summary.liquidity_usd), timeout-
  // bounded, key on api-pro with a free-host fallback. null if it can't be read.
  private async fetchTokenLiquidity(chain: string, token: string): Promise<number | null> {
    const key = this.apiKey();
    const hosts: [string, Record<string, string>][] = key
      ? [["https://api-pro.dexpaprika.com", { accept: "application/json", authorization: key }], ["https://api.dexpaprika.com", { accept: "application/json" }]]
      : [["https://api.dexpaprika.com", { accept: "application/json" }]];
    for (const [base, headers] of hosts) {
      try {
        const r = await fetch(`${base}/networks/${chain}/tokens/${token}`, { headers, signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS) });
        if (r.status === 401 || r.status === 403) continue;
        if (!r.ok) return null;
        const d = (await r.json()) as any;
        const liq = Number(d?.summary?.liquidity_usd);
        return Number.isFinite(liq) ? liq : null;
      } catch {
        continue;
      }
    }
    return null;
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
      .map((r) => ({ id: r.alert.subject, label: r.alert.label ?? r.alert.subject, chain: r.alert.chain, deltaUsd: r.alert.deltaUsd, pct: r.alert.pct, block: r.alert.block, t: r.alert.timestamp, intent: r.intent ?? "unknown" }));

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
      watching: this.activeAddrs.size, // pools subscribed on the live reserve stream right now
      emitting: this.meta.size, // subset of those that have ticked recently
      scanning: this.candidates.size, // pools the REST scanner has discovered as rotation candidates
      hero,
      series: streams.slice(0, 18), // overlaid live lines
      rising,
      rugWatch,
      draining,
      hypothesis: await this.buildHypothesis(),
      stats: { drains: stats.drains, sent: stats.sent, suppressed: stats.suppressed, rugs: stats.rugs ?? 0 },
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
scanner: ${this.candidates.size} candidates discovered (ranked by rug-risk score) · last scan ${escapeHtml(lastScan)}<br>
${this.lastEnrich ? `enrichment: ${escapeHtml(this.lastEnrich)}<br>` : ""}${escapeHtml(this.thresholds)}<br>last raw msg incl ping: ${escapeHtml(lastRaw)} · last reserve event: ${escapeHtml(lastEvent)} · last sent: ${escapeHtml(lastPost)}<br>
<strong>${escapeHtml(totals)}</strong></p>
${paused}${postError}
<h2>Recent drains</h2>
<ul style="list-style:none;padding:0">${rows || "<li>nothing caught yet</li>"}</ul>
${issues}
<p style="color:#666;margin-top:24px"><a href="/">← live dashboard</a> · <a href="https://github.com/coinpaprika/liquidity-radar">source</a></p>
</body>`;
  }
}
