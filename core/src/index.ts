import { detect, DEFAULT_DETECT, type DetectConfig } from "./detect.js";
import {
  DEFAULT_BASE_URL,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  StreamFatalError,
  subscribeReservesMulti,
} from "./stream.js";
import type { Alert, ReserveEvent, WatchEntry } from "./types.js";

export * from "./types.js";
export { parseSse } from "./sse.js";
export {
  DEFAULT_BASE_URL,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  StreamFatalError,
  coercePoolEvent,
  coerceTokenEvent,
  subscribeReserves,
  subscribeReservesMulti,
  type MultiplexedEvent,
  type StreamOptions,
  type SubscribeOptions,
} from "./stream.js";
export { detect, DEFAULT_DETECT, poolQuoteUsd, poolReserveUsd, QUOTE_TOKENS, type DetectConfig } from "./detect.js";
export { rugScore, type RugScoreFeatures } from "./score.js";
export { DATA_CREDIT, formatAlert, usd, pct, shortAddr } from "./format.js";
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
   * A subscription chunk stopped permanently: the server rejected an entry
   * (bad chain/address/method). Not retried; fix the watchlist. Other chunks
   * keep running.
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
 * Handler errors are logged and never kill a subscription. A server-rejected
 * chunk stops permanently and reports through onFatal; the rest keep running.
 */
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
        if (handlers.onFatal) handlers.onFatal(err, entries);
        else console.error(`[${label}] subscription stopped permanently: ${err.message}`);
        return; // other chunks keep running
      }
      throw err;
    }
  }

  return {
    start: () => Promise.all(chunks.map(runChunk)).then(() => undefined),
    stop: () => controller.abort(),
  };
}
