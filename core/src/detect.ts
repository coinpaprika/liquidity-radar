import type { Alert, ReserveEvent, WatchEntry } from "./types.js";

export interface DetectConfig {
  /** Ignore moves smaller than this absolute USD value. */
  minUsd: number;
  /** Trigger when |delta| is at least this fraction of the prior reserve (0.1 = 10%). */
  pctThreshold: number;
}

export const DEFAULT_DETECT: DetectConfig = {
  minUsd: 25_000,
  pctThreshold: 0.1,
};

/**
 * Classify a reserve event as a drain, an add, or nothing.
 *
 * For a pool, we use the net USD across both legs: a normal swap nets ~0
 * (one leg up, the other down), while an LP pull negates both legs at once.
 * That is what separates "someone traded" from "someone yanked the liquidity".
 */
export function detect(
  event: ReserveEvent,
  cfg: DetectConfig,
  entry?: WatchEntry,
): Alert | null {
  let scope: "token" | "pool";
  let subject: string;
  let reserveUsd: number;
  let deltaUsd: number;

  if (event.type === "token_reserves") {
    scope = "token";
    subject = event.token_id;
    reserveUsd = event.reserve_usd;
    deltaUsd = event.delta_usd;
  } else {
    scope = "pool";
    subject = event.pool_id;
    reserveUsd = event.total_reserve_usd;
    deltaUsd = event.total_delta_usd;
  }

  if (Math.abs(deltaUsd) < cfg.minUsd) return null;

  const prevReserveUsd = reserveUsd - deltaUsd;
  // Brand-new pool (no prior liquidity): any sizable inflow is a fresh add.
  const pct = prevReserveUsd > 0 ? deltaUsd / prevReserveUsd : Infinity * Math.sign(deltaUsd);

  if (Math.abs(pct) < cfg.pctThreshold) return null;

  return {
    kind: deltaUsd < 0 ? "drain" : "add",
    scope,
    chain: event.chain,
    subject,
    label: entry?.label,
    deltaUsd,
    reserveUsd,
    prevReserveUsd,
    pct,
    block: event.block,
    timestamp: event.timestamp,
  };
}
