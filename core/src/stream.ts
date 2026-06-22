import { parseSse } from "./sse.js";
import type {
  PoolReserveEvent,
  PoolTokenLeg,
  ReserveEvent,
  ReserveMethod,
  TokenReserveEvent,
  WatchEntry,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://streaming.dexpaprika.com";

/**
 * Server-side caps: 25 subscriptions per POST connection, and on the free
 * keyless tier 3 concurrent connections per IP (probed live 2026-06-19; the 4th
 * onward gets 429 "stream limit exceeded"). So one IP streams ~75 pools free;
 * an enterprise key raises the connection limit, or shard across IPs.
 */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 25;

/**
 * Permanent failure: the server rejected the subscription itself (bad chain,
 * unknown address, invalid method). Retrying cannot fix it, so the stream
 * stops and throws this instead of looping.
 */
export class StreamFatalError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "StreamFatalError";
    this.status = status;
  }
}

export interface StreamOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  /**
   * Optional DexPaprika API key. Sent as the bare `Authorization` header (no
   * "Bearer" prefix, which trips the WAF). Lifts the per-IP stream limit from
   * 3 concurrent connections to 7. Without it, the free keyless tier is used.
   */
  apiKey?: string;
  /** Transient connection errors; the stream retries with backoff after each. */
  onError?: (err: unknown) => void;
  /** Server warnings and unrecognized event types; the stream continues. */
  onWarning?: (message: string) => void;
  /**
   * Fires on EVERY message the connection delivers, including pings. A
   * liveness signal: if this never fires, the connection is delivering nothing
   * at all (dead/frozen); if it fires but no events arrive, the connection is
   * alive but the server isn't sending data for the subscriptions.
   */
  onBeat?: () => void;
}

/** Build request headers, adding the bare Authorization header when keyed. */
function streamHeaders(base: Record<string, string>, apiKey?: string): Record<string, string> {
  return apiKey ? { ...base, authorization: apiKey } : base;
}

export interface SubscribeOptions extends StreamOptions {
  method: ReserveMethod;
  chain: string;
  address: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

/** Build a token event from explicitly picked, type-checked fields. */
export function coerceTokenEvent(j: any): TokenReserveEvent | null {
  if (!j || typeof j.token_id !== "string" || typeof j.chain !== "string") return null;
  const reserve_usd = Number(j.reserve_usd);
  const delta_usd = Number(j.delta_usd);
  if (!Number.isFinite(reserve_usd) || !Number.isFinite(delta_usd)) return null;
  return {
    type: "token_reserves",
    chain: j.chain,
    token_id: j.token_id,
    reserve: str(j.reserve),
    delta: str(j.delta),
    block: str(j.block),
    price_usd: Number(j.price_usd) || 0,
    reserve_usd,
    delta_usd,
    updated_at: Number(j.updated_at) || 0,
    timestamp: Number(j.timestamp) || 0,
  };
}

/** Build a pool event from explicitly picked, type-checked fields. */
export function coercePoolEvent(j: any): PoolReserveEvent | null {
  if (!j || typeof j.pool_id !== "string" || typeof j.chain !== "string") return null;
  const total_reserve_usd = Number(j.total_reserve_usd);
  const total_delta_usd = Number(j.total_delta_usd);
  if (!Number.isFinite(total_reserve_usd) || !Number.isFinite(total_delta_usd)) return null;
  const tokens: PoolTokenLeg[] = Array.isArray(j.tokens)
    ? j.tokens.flatMap((t: any) =>
        typeof t?.token_id === "string"
          ? [{
              token_id: t.token_id,
              reserve: str(t.reserve),
              delta: str(t.delta),
              price_usd: Number(t.price_usd) || 0,
              reserve_usd: Number(t.reserve_usd) || 0,
              delta_usd: Number(t.delta_usd) || 0,
            }]
          : [],
      )
    : [];
  return {
    type: "pool_reserves",
    chain: j.chain,
    pool_id: j.pool_id,
    block: str(j.block),
    previous_block: str(j.previous_block),
    tokens,
    total_reserve_usd,
    total_delta_usd,
    timestamp: Number(j.timestamp) || 0,
    block_timestamp: Number(j.block_timestamp) || 0,
  };
}

function toEvent(eventName: string | undefined, j: any): ReserveEvent | null {
  if (eventName === "token_reserves") return coerceTokenEvent(j);
  if (eventName === "pool_reserves") return coercePoolEvent(j);
  // the published spec names this event `reserve_update`; accept it defensively
  // and discriminate by payload shape in case the server is ever aligned to it
  if (eventName === "reserve_update") {
    return j?.pool_id ? coercePoolEvent(j) : coerceTokenEvent(j);
  }
  return null;
}

/**
 * In-stream `error` events come in two flavors: capacity problems ("stream
 * limit exceeded", rate limits) that clear on their own, and subscription
 * problems ("token not found", "unsupported chain") that never will. Caught
 * in production: treating limits as fatal silenced 8 pools for a night.
 */
export function isRetryableStreamError(message: string): boolean {
  return /limit|rate|too many|capacity|timeout|temporar/i.test(message);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

interface RoutedEvent {
  /** The stream's request_id: the subscription's index for POST multiplex. */
  id?: string;
  event: ReserveEvent;
}

/**
 * Shared connect/parse/retry loop. Transient failures retry with capped
 * exponential backoff; backoff only resets after the first parsed SSE message
 * (HTTP 200 alone proves nothing; proxies can 200-and-close). Permanent
 * rejections (4xx other than 408/429, or in-stream `error` events) throw
 * StreamFatalError out of the generator.
 */
async function* streamLoop(
  makeRequest: () => Promise<Response>,
  opts: StreamOptions,
): AsyncGenerator<RoutedEvent> {
  let backoff = 1000;
  const maxBackoff = 30000;
  const unknownSeen = new Set<string>();

  while (!opts.signal?.aborted) {
    try {
      const res = await makeRequest();
      if (!res.ok) {
        let detail = `stream responded ${res.status}`;
        try {
          const body = await res.text();
          detail += `: ${JSON.parse(body).message ?? body}`;
        } catch {}
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw new StreamFatalError(detail, res.status);
        }
        throw new Error(detail);
      }
      if (!res.body) throw new Error("stream response had no body");

      let healthy = false;
      for await (const msg of parseSse(res.body)) {
        if (!msg.data) continue;
        if (msg.event === "error") {
          // the server closes the connection after this; deliberately BEFORE
          // the backoff reset so a limited connection keeps backing off
          let emsg = msg.data;
          try {
            emsg = JSON.parse(msg.data)?.message ?? msg.data;
          } catch {}
          if (isRetryableStreamError(emsg)) throw new Error(`server error: ${emsg}`);
          throw new StreamFatalError(`server error: ${emsg}`);
        }
        if (!healthy) {
          healthy = true;
          backoff = 1000;
        }
        opts.onBeat?.(); // any delivered message (incl. ping) = the connection is alive
        if (msg.event === "ping") continue;
        let json: any;
        try {
          json = JSON.parse(msg.data);
        } catch {
          continue;
        }
        if (msg.event === "warning") {
          opts.onWarning?.(`server warning: ${json?.message ?? msg.data}`);
          continue;
        }
        const event = toEvent(msg.event, json);
        if (event) {
          yield { id: msg.id, event };
          continue;
        }
        if (msg.event && !unknownSeen.has(msg.event)) {
          unknownSeen.add(msg.event);
          opts.onWarning?.(`ignoring unrecognized event type "${msg.event}"`);
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) break;
      if (err instanceof StreamFatalError) throw err;
      opts.onError?.(err);
    }

    if (opts.signal?.aborted) break;
    await sleep(backoff, opts.signal);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}

/**
 * Subscribe to a single reserve stream over GET, yielding typed events.
 * Prefer subscribeReservesMulti for more than a couple of entries, because the API
 * caps concurrent streams per IP (3 on the free tier) and one connection
 * multiplexes up to 25 subscriptions.
 */
export async function* subscribeReserves(
  opts: SubscribeOptions,
): AsyncGenerator<ReserveEvent> {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url =
    `${base}/sse/reserves?method=${encodeURIComponent(opts.method)}` +
    `&chain=${encodeURIComponent(opts.chain)}` +
    `&address=${encodeURIComponent(opts.address)}`;
  const stream = streamLoop(
    () =>
      fetch(url, {
        headers: streamHeaders({ accept: "text/event-stream" }, opts.apiKey),
        signal: opts.signal,
      }),
    opts,
  );
  for await (const routed of stream) yield routed.event;
}

export interface MultiplexedEvent {
  entryIndex: number;
  event: ReserveEvent;
}

/**
 * Subscribe to up to 25 pools/tokens on ONE connection via POST multiplex.
 * Events are routed back to entries by request_id (the index in the POST
 * array), with a chain+address fallback. One invalid entry makes the server
 * reject the whole connection with an in-stream `error` event, which throws
 * StreamFatalError carrying the server's message (e.g. "token not found:
 * ethereum/0xdead…"), so validate entries before subscribing.
 */
export async function* subscribeReservesMulti(
  entries: WatchEntry[],
  opts: StreamOptions = {},
): AsyncGenerator<MultiplexedEvent> {
  if (entries.length === 0) return;
  if (entries.length > MAX_SUBSCRIPTIONS_PER_CONNECTION) {
    throw new RangeError(
      `${entries.length} subscriptions exceed the per-connection cap of ${MAX_SUBSCRIPTIONS_PER_CONNECTION}; chunk the watchlist`,
    );
  }
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const body = JSON.stringify(
    entries.map((e) => ({ chain: e.chain, address: e.address, method: e.method })),
  );
  const byKey = new Map<string, number>();
  entries.forEach((e, i) => byKey.set(`${e.chain}:${e.address.toLowerCase()}`, i));

  const stream = streamLoop(
    () =>
      fetch(`${base}/sse/reserves`, {
        method: "POST",
        headers: streamHeaders(
          { "content-type": "application/json", accept: "text/event-stream" },
          opts.apiKey,
        ),
        body,
        signal: opts.signal,
      }),
    opts,
  );
  for await (const routed of stream) {
    let idx = routed.id !== undefined ? Number(routed.id) : NaN;
    if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) {
      const subject =
        routed.event.type === "token_reserves" ? routed.event.token_id : routed.event.pool_id;
      idx = byKey.get(`${routed.event.chain}:${subject.toLowerCase()}`) ?? -1;
    }
    if (idx >= 0) yield { entryIndex: idx, event: routed.event };
  }
}
