// LiquidityRadar live feed: Cloudflare Worker + Durable Object.
//
// Worker: edge-cached public status page + /health; a cron trigger bootstraps
// the Durable Object after deploy and keeps it alive with no visitors.
// RadarDO: holds the multiplexed SSE subscription, gates alerts (dedup,
// per-subject cooldown, hourly cap, 429 pauses), sends them to your webhook,
// renders the status page.
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
} from "../../core/src/index.js";
import { isLive, postAlert, type SinkEnv } from "./webhook.js";
import bundledWatchlist from "../../watchlist.json";

export interface Env extends SinkEnv {
  RADAR: DurableObjectNamespace;
  WATCHLIST?: string; // JSON RadarConfig (same shape as watchlist.json)
  POST_COOLDOWN_MINUTES?: string; // per-subject cooldown (default 30)
  POSTS_PER_HOUR?: string; // global cap (default 6)
  POST_SUFFIX?: string; // appended to every alert; "" disables the default credit
}

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const ALARM_INTERVAL_MS = 30_000;

function envInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// curated default: the repo-root watchlist.json, bundled at deploy time (too
// large for an env var). The WATCHLIST var still overrides it without a redeploy.
const FALLBACK_WATCHLIST = bundledWatchlist as unknown as RadarConfig;

interface RecentEntry {
  alert: Alert;
  posted: boolean;
  reason?: string; // why a catch was not posted (duplicate, cooldown, cap, pause)
}

interface Stats {
  catches: number;
  passedGate: number;
  sinceMs: number;
}

const RECENT_CAP = 150; // ~60KB of a 128KB DO storage value; a busy night fits

interface Gate {
  posted: Record<string, number>; // dedup key -> ms timestamp
  lastBySubject: Record<string, number>; // subject -> ms of last post
  recentPosts: number[]; // ms timestamps inside the sliding hour
  pausedUntilMs: number;
  lastPostAtMs?: number;
  lastPostError?: string;
}

const emptyGate = (): Gate => ({
  posted: {},
  lastBySubject: {},
  recentPosts: [],
  pausedUntilMs: 0,
});

function escapeHtml(v: unknown): string {
  return String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (url.pathname !== "/") return new Response("not found", { status: 404 });

    // serve the status page from the edge cache so launch-day traffic never
    // piles onto the single DO holding the SSE connections
    const cache = caches.default;
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await env.RADAR.get(env.RADAR.idFromName("singleton")).fetch(req);
    if (res.ok) ctx.waitUntil(cache.put(req, res.clone()));
    return res;
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // bootstrap after deploy + keep-alive belt over the DO's own alarm chain
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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    await this.ensureRunning();
    const url = new URL(req.url);
    if (url.pathname === "/__start") return new Response("started", { status: 200 });

    if (this.issues.length === 0) {
      this.issues = (await this.state.storage.get<string[]>("issues")) ?? [];
    }
    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    const gate = (await this.state.storage.get<Gate>("gate")) ?? emptyGate();
    const stats = (await this.state.storage.get<Stats>("stats")) ?? null;
    return new Response(this.renderStatus(recent, gate, stats), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=30",
      },
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    await this.ensureRunning();
  }

  private async ensureRunning(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
    if (this.running) return;
    this.running = true;

    const config = this.loadConfig();
    this.thresholds = `alerts at ≥$${(config.minUsd ?? 25000).toLocaleString("en-US")} and ≥${((config.pctThreshold ?? 0.1) * 100).toFixed(0)}% of reserve`;

    // thresholds define the experiment: when they change, the catch list and
    // counters restart so old-epoch noise doesn't pollute the readout (the
    // posting gate survives; its cooldowns protect the X quota)
    const epoch = (await this.state.storage.get<string>("epoch")) ?? "";
    if (epoch !== this.thresholds) {
      await this.state.storage.put("epoch", this.thresholds);
      await this.state.storage.delete("recent");
      await this.state.storage.delete("stats");
    }

    const radar = createRadar(config, {
      onAlert: (alert) => this.handleAlert(alert),
      onEvent: () => {
        this.lastEventMs = Date.now();
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
        // abort any surviving sibling subscriptions so the next restart can
        // never run two radars (and double-post) at once
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

  private async handleAlert(alert: Alert): Promise<void> {
    this.lastEventMs = Date.now();
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
    else if (now < gate.pausedUntilMs) reason = "rate-limited by X";
    else if (now - (gate.lastBySubject[alert.subject] ?? 0) < cooldownMs) {
      reason = "subject cooldown";
    } else if (gate.recentPosts.length >= capPerHour) reason = "hourly cap";

    if (!reason) {
      // claim the slot before the network call so a slow post can't double-send
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

    const recent = (await this.state.storage.get<RecentEntry[]>("recent")) ?? [];
    recent.unshift({ alert, posted: !reason, reason });
    await this.state.storage.put("recent", recent.slice(0, RECENT_CAP));

    const stats = (await this.state.storage.get<Stats>("stats")) ?? {
      catches: 0,
      passedGate: 0,
      sinceMs: now,
    };
    stats.catches++;
    if (!reason) stats.passedGate++;
    await this.state.storage.put("stats", stats);
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
      ? "live, sending alerts to webhook"
      : "watch-only (no WEBHOOK_URL, catches stay on this page)";
    const lastEvent =
      this.lastEventMs > 0 ? `${Math.round((now - this.lastEventMs) / 1000)}s ago` : "none yet";
    const lastPost = gate.lastPostAtMs
      ? new Date(gate.lastPostAtMs).toISOString()
      : "never";
    const passedLabel = live ? "sent" : "would have sent";
    const totals = stats
      ? `${stats.catches} catches (${stats.passedGate} ${passedLabel}) since ${new Date(stats.sinceMs).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "no catches yet";
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
        const tag = r.posted ? passedLabel : `skipped: ${r.reason}`;
        return `<li><code>${escapeHtml(when)} UTC · ${escapeHtml(age)}</code><br>${icon} ${escapeHtml(a.label ?? a.subject)} on ${escapeHtml(a.chain)} · ${escapeHtml(amount)} (${escapeHtml(pctText)}) · block ${escapeHtml(a.block)} · <em>${escapeHtml(tag)}</em></li>`;
      })
      .join("\n");
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>LiquidityRadar</title>
<body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px">
<h1>LiquidityRadar (live)</h1>
<p>Real-time DEX liquidity drains &amp; adds on the free DexPaprika reserve stream.</p>
<p>mode: <strong>${escapeHtml(mode)}</strong> · watchlist: ${escapeHtml(this.configSource)}<br>
${escapeHtml(this.thresholds)}<br>
last reserve event: ${escapeHtml(lastEvent)} · last sent: ${escapeHtml(lastPost)}<br>
<strong>${escapeHtml(totals)}</strong></p>
${paused}${postError}
<h2>Recent catches</h2>
<ul style="list-style:none;padding:0">${rows ? rows.replace(/<li>/g, '<li style="margin:10px 0">') : "<li>nothing caught yet (drains are rare by design)</li>"}</ul>
${issues}
<hr style="margin-top:32px;border:none;border-top:1px solid #ddd">
<p style="color:#666">Powered by <a href="https://dexpaprika.com">DexPaprika</a>: free real-time DEX data, no API key needed ·
<a href="https://docs.dexpaprika.com">streaming docs</a> ·
<a href="https://github.com/coinpaprika/liquidity-radar">fork this radar</a></p>
</body>`;
  }
}
