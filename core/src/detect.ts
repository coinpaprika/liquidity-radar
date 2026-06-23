import type { Alert, PoolReserveEvent, ReserveEvent, WatchEntry } from "./types.js";

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
 * Quote tokens: the "real money" side of a pair. A meme token's USD value is
 * derived from its own thin pool (circular, inflatable), so total_reserve_usd
 * is not trustworthy. The SOL / USDC / USDT leg is. We value pools by their
 * quote leg(s) instead. Solana mints are case-sensitive base58; Ethereum
 * addresses are matched case-insensitively (stored lowercased).
 */
export const QUOTE_TOKENS = new Set<string>([
  // Solana
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  // Ethereum (lowercased)
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0xaca92e438df0b2401ff60da7e4337b687a2435da", // mUSD (MetaMask/Consensys USD)
]);

function isQuote(tokenId: string): boolean {
  return QUOTE_TOKENS.has(tokenId) || QUOTE_TOKENS.has(tokenId.toLowerCase());
}

/**
 * Value a pool by its quote leg(s): the real USD on the SOL/USDC/USDT side,
 * not the meme leg's inflated notional. `quoted` is false when neither leg is a
 * known quote token (meme/meme pair); then we fall back to the pool total,
 * which can't be trusted, so callers may choose to ignore it. `nonQuoteRose`
 * flags that a non-quote leg increased, which (with the quote leg falling) means
 * a sell-swap, not a liquidity removal.
 */
export function poolQuoteUsd(event: PoolReserveEvent): {
  reserveUsd: number;
  deltaUsd: number;
  quoted: boolean;
  nonQuoteRose: boolean;
} {
  let reserveUsd = 0;
  let deltaUsd = 0;
  let quoted = false;
  let nonQuoteRose = false;
  for (const leg of event.tokens) {
    if (isQuote(leg.token_id)) {
      reserveUsd += leg.reserve_usd;
      deltaUsd += leg.delta_usd;
      quoted = true;
    } else if (leg.delta_usd > 0) {
      nonQuoteRose = true;
    }
  }
  if (!quoted) {
    return { reserveUsd: event.total_reserve_usd, deltaUsd: event.total_delta_usd, quoted: false, nonQuoteRose };
  }
  return { reserveUsd, deltaUsd, quoted, nonQuoteRose };
}

/** Real, quote-valued reserve for a pool event (for charts/series). */
export function poolReserveUsd(event: PoolReserveEvent): number {
  return poolQuoteUsd(event).reserveUsd;
}

/**
 * Classify a reserve event as a drain, an add, or nothing.
 *
 * Pools are valued by their quote leg (SOL/USDC/USDT), so the USD figures are
 * the real money, not a meme token's inflated notional. A drain is a liquidity
 * removal: the quote leg falls AND no non-quote leg rises (a sell-swap pulls
 * the quote leg down too, but pushes the meme leg up, which is not a drain).
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
  let nonQuoteRose = false;

  if (event.type === "token_reserves") {
    scope = "token";
    subject = event.token_id;
    reserveUsd = event.reserve_usd;
    deltaUsd = event.delta_usd;
  } else {
    scope = "pool";
    subject = event.pool_id;
    const q = poolQuoteUsd(event);
    reserveUsd = q.reserveUsd;
    deltaUsd = q.deltaUsd;
    nonQuoteRose = q.nonQuoteRose;
  }

  if (Math.abs(deltaUsd) < cfg.minUsd) return null;

  const prevReserveUsd = reserveUsd - deltaUsd;
  // Brand-new pool (no prior liquidity): any sizable inflow is a fresh add.
  const pct = prevReserveUsd > 0 ? deltaUsd / prevReserveUsd : Infinity * Math.sign(deltaUsd);

  if (Math.abs(pct) < cfg.pctThreshold) return null;

  const kind = deltaUsd < 0 ? "drain" : "add";
  // A falling quote leg while a meme leg rises is a sell-swap, not a drain.
  if (kind === "drain" && nonQuoteRose) return null;

  return {
    kind,
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
