import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, DEFAULT_DETECT } from "../src/detect.js";
import { formatAlert, usd, pct } from "../src/format.js";
import type { PoolReserveEvent, TokenReserveEvent } from "../src/types.js";

// Shapes mirror events captured live from /sse/reserves on 2026-06-10.

function tokenEvent(over: Partial<TokenReserveEvent>): TokenReserveEvent {
  return {
    type: "token_reserves",
    chain: "ethereum",
    token_id: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    reserve: "0",
    delta: "0",
    block: "25286202",
    price_usd: 1618.74,
    reserve_usd: 0,
    delta_usd: 0,
    updated_at: 1781084315,
    timestamp: 1781084317,
    ...over,
  };
}

function poolEvent(over: Partial<PoolReserveEvent>): PoolReserveEvent {
  return {
    type: "pool_reserves",
    chain: "ethereum",
    pool_id: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    block: "25286203",
    previous_block: "25286202",
    tokens: [],
    total_reserve_usd: 0,
    total_delta_usd: 0,
    timestamp: 1781084332,
    block_timestamp: 1781084327,
    ...over,
  };
}

test("token drain over both thresholds triggers", () => {
  const a = detect(
    tokenEvent({ reserve_usd: 70_000, delta_usd: -30_000 }),
    DEFAULT_DETECT,
  );
  assert.ok(a);
  assert.equal(a.kind, "drain");
  assert.equal(a.scope, "token");
  assert.equal(a.prevReserveUsd, 100_000);
  assert.ok(Math.abs(a.pct - -0.3) < 1e-9);
});

test("move below minUsd is ignored even at huge pct", () => {
  const a = detect(
    tokenEvent({ reserve_usd: 100, delta_usd: -900 }),
    DEFAULT_DETECT,
  );
  assert.equal(a, null);
});

test("big USD move that is a tiny fraction of reserve is ignored", () => {
  const a = detect(
    tokenEvent({ reserve_usd: 10_000_000, delta_usd: -30_000 }),
    DEFAULT_DETECT,
  );
  assert.equal(a, null); // 0.3% of prior reserve, under the 10% gate
});

test("ordinary swap nets ~0 on a pool and never triggers", () => {
  // real captured behavior: one leg +$46k, other -$45.9k, net $84
  const a = detect(
    poolEvent({ total_reserve_usd: 84_031_158, total_delta_usd: 84.37 }),
    DEFAULT_DETECT,
  );
  assert.equal(a, null);
});

test("LP pull negates both legs and triggers a pool drain", () => {
  const a = detect(
    poolEvent({ total_reserve_usd: 50_000, total_delta_usd: -200_000 }),
    DEFAULT_DETECT,
  );
  assert.ok(a);
  assert.equal(a.kind, "drain");
  assert.equal(a.scope, "pool");
  assert.equal(a.prevReserveUsd, 250_000);
  assert.ok(Math.abs(a.pct - -0.8) < 1e-9);
});

test("brand-new pool (no prior reserve) registers as an add", () => {
  const a = detect(
    poolEvent({ total_reserve_usd: 100_000, total_delta_usd: 100_000 }),
    DEFAULT_DETECT,
  );
  assert.ok(a);
  assert.equal(a.kind, "add");
  assert.equal(a.pct, Infinity);
  assert.ok(formatAlert(a).includes("(new)"));
});

test("liquidity add over thresholds triggers an add", () => {
  const a = detect(
    tokenEvent({ reserve_usd: 130_000, delta_usd: 30_000 }),
    DEFAULT_DETECT,
  );
  assert.ok(a);
  assert.equal(a.kind, "add");
});

test("usd formatting", () => {
  assert.equal(usd(1_240_000), "$1.24M");
  assert.equal(usd(-27_881), "-$27.9K");
  assert.equal(usd(525_025_172), "$525.03M");
  assert.equal(usd(42), "$42");
  assert.equal(usd(2_100_000_000), "$2.10B");
});

test("pct formatting", () => {
  assert.equal(pct(-0.831), "-83.1%");
  assert.equal(pct(0.105), "+10.5%");
  assert.equal(pct(Infinity), "new");
});

test("formatAlert produces the canonical drain line", () => {
  const a = detect(
    poolEvent({ total_reserve_usd: 254_000, total_delta_usd: -1_240_000 }),
    DEFAULT_DETECT,
    {
      method: "pool_reserves",
      chain: "ethereum",
      address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      label: "SOMETOKEN/WETH",
    },
  );
  assert.ok(a);
  const text = formatAlert(a);
  assert.ok(text.includes("🚨 DRAIN · SOMETOKEN/WETH on ethereum"));
  assert.ok(text.includes("-$1.24M"));
  assert.ok(text.includes("block 25286203"));
});
