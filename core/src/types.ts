// Event shapes captured live from streaming.dexpaprika.com/sse/reserves (2026-06-10).
// Numeric reserves/deltas arrive as strings to protect JS float precision; the
// USD fields are already numbers.

export type ReserveMethod = "token_reserves" | "pool_reserves";

export interface TokenReserveEvent {
  type: "token_reserves";
  chain: string;
  token_id: string;
  reserve: string;
  delta: string;
  block: string;
  price_usd: number;
  reserve_usd: number;
  delta_usd: number;
  updated_at: number;
  timestamp: number;
}

export interface PoolTokenLeg {
  token_id: string;
  reserve: string;
  delta: string;
  price_usd: number;
  reserve_usd: number;
  delta_usd: number;
}

export interface PoolReserveEvent {
  type: "pool_reserves";
  chain: string;
  pool_id: string;
  block: string;
  previous_block: string;
  tokens: PoolTokenLeg[];
  total_reserve_usd: number;
  total_delta_usd: number;
  timestamp: number;
  block_timestamp: number;
}

export type ReserveEvent = TokenReserveEvent | PoolReserveEvent;

export interface WatchEntry {
  method: ReserveMethod;
  chain: string;
  address: string;
  /** Human label for output, e.g. "WETH" or "USDC/WETH 0.05%". */
  label?: string;
}

export type AlertKind = "drain" | "add";

export interface Alert {
  kind: AlertKind;
  scope: "token" | "pool";
  chain: string;
  /** token_id or pool_id */
  subject: string;
  label?: string;
  deltaUsd: number;
  reserveUsd: number;
  prevReserveUsd: number;
  /** signed fraction of the prior reserve, e.g. -0.18 = down 18% */
  pct: number;
  block: string;
  timestamp: number;
}
