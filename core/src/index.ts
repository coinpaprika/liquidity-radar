import { detect, DEFAULT_DETECT, type DetectConfig } from "./detect.js";
import {
  DEFAULT_BASE_URL,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  StreamFatalError,
  subscribeReservesMulti,
} from "./stream.js";
import type { Alert, ReserveEvent, WatchEntry } from "./types.js";

export * from "./types.js";
export { parseSse, DEFAULT_MAX_EVENT_SIZE, DEFAULT_MAX_LINE_LENGTH, type SseLimits } from "./sse.js";
export {
  DEFAULT_BASE_URL,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  StreamFatalError,
  coercePoolEvent,
  coerceTokenEvent,
  offendingEntries,
  subscribeReserves,
  subscribeReservesMulti,
  type MultiplexedEvent,
  type StreamOptions,
  type SubscribeOptions,
} from "./stream.js";
export { detect, DEFAULT_DETECT, poolQuoteUsd, poolReserveUsd, QUOTE_TOKENS, SWAP_OFFSET_RATIO, type DetectConfig } from "./detect.js";
export { rugScore, type RugScoreFeatures } from "./score.js";
export { DATA_CREDIT, formatAlert, safeLabel, usd, pct, shortAddr } from "./format.js";
export { validateRadarConfig } from "./config.js";

export interface RadarConfig extends Partial<DetectConfig> {
  watch: WatchEntry[];
  baseUrl?: string;
  /** Optional DexPaprika API key; lifts the stream limit from 3 to 7 connections. */
  apiKey?: string;
}

export type AlertHandler = (
  alert: Alert,
  event: ReserveEvent,
  entry: WatchEntry,
) => void | Promise<void>;

/** Called on every reserve event, before detection. Useful for tick logging. */
export type EventHandler = (
  event: ReserveEvent,
  entry: WatchEntry,
) => void | Promise<void>;

export interface RadarHandlers {
  onAlert: AlertHandler;
  onEvent?: EventHandler;
  /**
   * The server rejected a subscription permanently. When the rejection is about
   * one entry (an in-stream error), `entries` is just the entry it was pinned
   * on: the rest of its chunk has already been resubscribed without it, so drop
   * or quarantine those entries. When the request itself was refused (an HTTP
   * error such as a bad key), `entries` is the whole chunk, which stays down.
   * Not retried either way. Other chunks keep running.
   */
  onFatal?: (error: StreamFatalError, entries: WatchEntry[]) => void;
  /** Server warnings / unrecognized event types. */
  onWarning?: (message: string) => void;
  /**
   * Transient connection error on a chunk (e.g. a 429 rate limit or dropped
   * socket). The chunk retries with backoff; this is for visibility/metrics.
   */
  onError?: (error: unknown, entries: WatchEntry[]) => void;
  /** Fires on every delivered message (incl. ping): a connection-liveness signal. */
  onBeat?: () => void;
}

export interface Radar {
  /** Resolves when every subscription has stopped (after stop(), or all fatal). */
  start(): Promise<void>;
  stop(): void;
}

/**
 * Watch every entry through multiplexed connections: the watchlist is chunked
 * into groups of up to 25, one POST connection each. The free tier allows 3
 * concurrent connections per IP, so ~75 entries stream from one IP; beyond that
 * the extra connections 429 and back off until a slot frees.
 *
 * Handler errors are logged and never kill a subscription. When the server
 * rejects one entry of a chunk, that entry is reported through onFatal and the
 * rest of the chunk resubscribes without it. If the error does not say which
 * entry it is about, the chunk is split in half until the bad entry is alone,
 * so one poisoned entry never takes its 24 neighbours down with it.
 */
/**
 * Errors about the caller (key, plan, permissions) are not about any entry, so
 * splitting a chunk over one would only knock every entry out one by one.
 */
export function isCallerError(message: string): boolean {
  return /auth|key|plan|forbidden|permission|denied/i.test(message);
}

/**
 * How to carry on after an in-stream rejection: the entries to drop and the
 * chunks to resubscribe, or null when the chunk just stops (HTTP refusal,
 * caller error, or a chunk of one).
 */
function isolate(
  err: StreamFatalError,
  entries: WatchEntry[],
): { bad: WatchEntry[]; rest: WatchEntry[][] } | null {
  if (err.status !== undefined || entries.length <= 1 || isCallerError(err.message)) return null;
  const bad = (err.offending ?? []).filter((e) => entries.includes(e));
  if (bad.length && bad.length < entries.length) {
    return { bad, rest: [entries.filter((e) => !bad.includes(e))] };
  }
  const mid = Math.ceil(entries.length / 2);
  return { bad: [], rest: [entries.slice(0, mid), entries.slice(mid)] };
}

export function createRadar(config: RadarConfig, handlers: RadarHandlers): Radar {
  const controller = new AbortController();
  const cfg: DetectConfig = {
    minUsd: config.minUsd ?? DEFAULT_DETECT.minUsd,
    pctThreshold: config.pctThreshold ?? DEFAULT_DETECT.pctThreshold,
  };

  const chunks: WatchEntry[][] = [];
  for (let i = 0; i < config.watch.length; i += MAX_SUBSCRIPTIONS_PER_CONNECTION) {
    chunks.push(config.watch.slice(i, i + MAX_SUBSCRIPTIONS_PER_CONNECTION));
  }

  const safely = async (what: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`${what} handler failed (subscription continues): ${String(err)}`);
    }
  };

  async function runChunk(entries: WatchEntry[]): Promise<void> {
    const label =
      entries.length === 1
        ? entries[0].label ?? entries[0].address
        : `${entries.length} subscriptions`;
    try {
      const stream = subscribeReservesMulti(entries, {
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
        apiKey: config.apiKey,
        signal: controller.signal,
        onBeat: handlers.onBeat,
        onError: (err) => {
          console.error(`[${label}] ${String(err)}`);
          handlers.onError?.(err, entries);
        },
        onWarning: (msg) =>
          handlers.onWarning ? handlers.onWarning(msg) : console.error(`[${label}] ${msg}`),
      });
      for await (const { entryIndex, event } of stream) {
        const entry = entries[entryIndex];
        if (handlers.onEvent) await safely("event", () => handlers.onEvent!(event, entry));
        const alert = detect(event, cfg, entry);
        if (alert) await safely("alert", () => handlers.onAlert(alert, event, entry));
      }
    } catch (err) {
      if (err instanceof StreamFatalError && !controller.signal.aborted) {
        const split = isolate(err, entries);
        if (split) {
          if (split.bad.length) fatal(err, split.bad, label);
          else {
            const msg = `${err.message}; splitting ${entries.length} subscriptions to find the rejected one`;
            handlers.onWarning ? handlers.onWarning(msg) : console.error(`[${label}] ${msg}`);
          }
          await Promise.all(split.rest.filter((c) => c.length).map(runChunk));
          return;
        }
        fatal(err, entries, label);
        return; // other chunks keep running
      }
      throw err;
    }
  }

  function fatal(err: StreamFatalError, entries: WatchEntry[], label: string): void {
    if (handlers.onFatal) handlers.onFatal(err, entries);
    else console.error(`[${label}] subscription stopped permanently: ${err.message}`);
  }

  return {
    start: () => Promise.all(chunks.map(runChunk)).then(() => undefined),
    stop: () => controller.abort(),
  };
}
