import { test } from "node:test";
import assert from "node:assert/strict";
import { rugScore } from "../src/score.js";

test("a young, churny, thin pool outranks an old, quiet, deep pool", () => {
  const risky = rugScore({ ageHours: 3, liqUsd: 50_000, volUsd: 200_000, txns: 4_000, fdv: 4_000_000 });
  const safe = rugScore({ ageHours: 24 * 90, liqUsd: 20_000_000, volUsd: 1_000_000, txns: 30_000, fdv: 50_000_000 });
  assert.ok(risky > safe, `expected risky ${risky} > safe ${safe}`);
});

test("wash trading (one trade larger than half the pool) is penalized", () => {
  const base = { ageHours: 3, liqUsd: 50_000, fdv: 2_000_000 };
  const organic = rugScore({ ...base, volUsd: 150_000, txns: 3_000 }); // avg trade $50
  const washed = rugScore({ ...base, volUsd: 150_000, txns: 3 }); // avg trade $50k > half the pool
  assert.ok(washed < organic, `expected washed ${washed} < organic ${organic}`);
});

test("unknown FDV is neutral, not treated as zero risk", () => {
  const known = rugScore({ ageHours: 3, liqUsd: 50_000, volUsd: 150_000, txns: 3_000, fdv: 5_000_000 });
  const unknown = rugScore({ ageHours: 3, liqUsd: 50_000, volUsd: 150_000, txns: 3_000, fdv: 0 });
  assert.ok(unknown > 0, "unknown fdv must still produce a positive score");
  assert.ok(unknown < known, "a high known fdv/liq should outrank unknown");
});

test("heavy short-window sell pressure boosts the score", () => {
  const f = { ageHours: 3, liqUsd: 50_000, volUsd: 150_000, txns: 3_000, fdv: 2_000_000 };
  const calm = rugScore({ ...f, sellSkew: 0.5 });
  const dumping = rugScore({ ...f, sellSkew: 0.9 });
  assert.ok(dumping > calm, `expected dumping ${dumping} > calm ${calm}`);
  assert.equal(rugScore({ ...f, sellSkew: 0.5 }), rugScore(f), "skew at 0.5 is the neutral point");
});

test("zero / missing liquidity never yields NaN", () => {
  const s = rugScore({ ageHours: 1, liqUsd: 0, volUsd: 0, txns: 0, fdv: 0 });
  assert.ok(Number.isFinite(s), "score must be finite even with empty inputs");
});

test("non-finite inputs are clamped to a finite, non-negative score (sort-safe)", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const s = rugScore({ ageHours: 3, liqUsd: 50_000, volUsd: bad, txns: 3_000, fdv: 1_000_000 });
    assert.ok(Number.isFinite(s) && s >= 0, `volUsd=${bad} must yield a finite non-negative score, got ${s}`);
  }
  const skewBad = rugScore({ ageHours: 3, liqUsd: 50_000, volUsd: 150_000, txns: 3_000, fdv: 1_000_000, sellSkew: NaN });
  assert.ok(Number.isFinite(skewBad) && skewBad >= 0, "NaN sellSkew must not poison the score");
});
