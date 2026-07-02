/**
 * Rug-risk prior for a candidate pool, from cheap market-microstructure signals
 * (all available on a single /pools/filter row, plus an optional sell-skew from
 * a /pools/{id} detail call). This is NOT a drain detector: it only decides which
 * pools are worth a scarce live-stream slot. DexPaprika exposes no contract
 * security (mint authority, LP-lock, holder concentration), so this is built
 * entirely from market behaviour: age, turnover, float thinness, wash, sell flow.
 *
 * Higher score = more worth watching. The factors are bounded so no single one
 * collapses the score to zero (a pool missing one signal still ranks on the rest).
 */
export interface RugScoreFeatures {
  /** Hours since the pool was created. Younger pools rug far more often. */
  ageHours: number;
  /** Current liquidity in USD (the quote/TVL side). */
  liqUsd: number;
  /** 24h volume in USD. */
  volUsd: number;
  /** 24h transaction count. */
  txns: number;
  /** Fully-diluted valuation of the risky (non-quote) token; 0 = unknown. */
  fdv: number;
  /** Optional short-window sell pressure, sell/(buy+sell) in 0..1, from a detail call. */
  sellSkew?: number;
}

/** Steep decay with age: fresh pools are where rugs happen. */
function ageFactor(ageHours: number): number {
  if (!(ageHours >= 0)) return 0.4; // unknown age: treat as elevated, not extreme
  if (ageHours <= 6) return 1;
  if (ageHours <= 48) return 0.7;
  if (ageHours <= 168) return 0.4; // 7 days
  return 0.15;
}

/**
 * Composite rug-risk prior in roughly 0..1.75. Pure and deterministic so it can
 * be unit-tested and reused by the CLI and the feed worker alike.
 */
export function rugScore(f: RugScoreFeatures): number {
  const liq = f.liqUsd > 0 ? f.liqUsd : 0;

  const age = ageFactor(f.ageHours);

  // Turnover: 24h volume against TVL. 3x+ churn on a young pool is the classic
  // farmed/pre-drain pattern. Bounded so it boosts (0.3..1), never zeroes.
  const churn = liq > 0 ? Math.min(f.volUsd / liq / 3, 1) : 0;
  const churnF = 0.3 + 0.7 * churn;

  // Thin float: a high FDV behind little real liquidity is easy to crater.
  // Unknown FDV (0/null) is neutral, never treated as safe.
  const fdvLiq = f.fdv > 0 && liq > 0 ? Math.min(f.fdv / liq / 50, 1) : 0.5;
  const fdvF = 0.5 + 0.5 * fdvLiq;

  // Wash: a single average trade larger than half the pool means the volume is
  // one whale/bot, not organic. Discount it so fake churn can't win a slot.
  const avgTrade = f.txns > 0 ? f.volUsd / f.txns : 0;
  const washF = liq > 0 && avgTrade > liq * 0.5 ? 0.3 : 1;

  let score = age * churnF * fdvF * washF;

  // Optional enrichment: heavy short-window sell pressure on a young pool is an
  // early-exit signal. Skew 0.5 -> 1x, 1.0 -> 1.75x.
  if (typeof f.sellSkew === "number" && Number.isFinite(f.sellSkew)) {
    score *= 1 + Math.max(0, f.sellSkew - 0.5) * 1.5;
  }
  // Enforce the contract at the source: always a finite, non-negative number. A
  // NaN here (e.g. a non-finite input from a future caller) would poison the
  // sort comparators that rank stream-slot candidates.
  return Number.isFinite(score) ? Math.max(0, score) : 0;
}
