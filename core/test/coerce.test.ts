import { test } from "node:test";
import assert from "node:assert/strict";
import { coercePoolEvent, coerceTokenEvent } from "../src/stream.js";
import { detect, DEFAULT_DETECT } from "../src/detect.js";
import { formatAlert } from "../src/format.js";

const liveTokenPayload = {
  chain: "ethereum",
  token_id: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  reserve: "324340410963277335049476",
  delta: "-17223947148566447155",
  block: "25286202",
  price_usd: 1618.74,
  reserve_usd: 525025172.27,
  delta_usd: -27881.21,
  updated_at: 1781084315,
  timestamp: 1781084317,
};

test("coerces a live-captured token payload", () => {
  const e = coerceTokenEvent(liveTokenPayload);
  assert.ok(e);
  assert.equal(e.type, "token_reserves");
  assert.equal(e.delta_usd, -27881.21);
  assert.equal(e.block, "25286202");
});

test("a payload cannot override the type discriminant", () => {
  const e = coerceTokenEvent({ ...liveTokenPayload, type: "pool_reserves" });
  assert.ok(e);
  assert.equal(e.type, "token_reserves");
});

test("rejects payloads with missing or non-numeric USD fields", () => {
  assert.equal(coerceTokenEvent({ ...liveTokenPayload, reserve_usd: "evil" }), null);
  assert.equal(coerceTokenEvent({ ...liveTokenPayload, delta_usd: undefined }), null);
  assert.equal(coerceTokenEvent({ ...liveTokenPayload, token_id: 42 }), null);
  assert.equal(coerceTokenEvent(null), null);
});

test("coerces a pool payload and drops malformed token legs", () => {
  const e = coercePoolEvent({
    chain: "ethereum",
    pool_id: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    block: "25286203",
    previous_block: "25286202",
    tokens: [
      { token_id: "0xa0b8", reserve: "1", delta: "1", price_usd: 1, reserve_usd: 1, delta_usd: 1 },
      { not_a_leg: true },
    ],
    total_reserve_usd: 84031158.86,
    total_delta_usd: 84.37,
    timestamp: 1781084332,
    block_timestamp: 1781084327,
  });
  assert.ok(e);
  assert.equal(e.tokens.length, 1);
  assert.equal(e.total_delta_usd, 84.37);
});

test("rejects pool payloads without finite totals", () => {
  assert.equal(
    coercePoolEvent({ chain: "x", pool_id: "0x1", total_reserve_usd: Infinity, total_delta_usd: 1 }),
    null,
  );
});

test("token-scope alerts use RESERVE DROP copy, not DRAIN", () => {
  const e = coerceTokenEvent({ ...liveTokenPayload, reserve_usd: 70_000, delta_usd: -30_000 });
  assert.ok(e);
  const a = detect(e, DEFAULT_DETECT);
  assert.ok(a);
  const text = formatAlert(a);
  assert.ok(text.includes("📉 RESERVE DROP ·"));
  assert.ok(!text.includes("DRAIN"));
});

test("stream-limit errors retry; not-found errors are fatal", async () => {
  const { isRetryableStreamError } = await import("../src/stream.js");
  assert.equal(isRetryableStreamError("stream limit exceeded"), true);
  assert.equal(isRetryableStreamError("ip stream limit exceeded"), true);
  assert.equal(isRetryableStreamError("too many subscriptions"), true);
  assert.equal(isRetryableStreamError("token not found: ethereum/0xdead"), false);
  assert.equal(isRetryableStreamError("unsupported chain: notachain"), false);
  assert.equal(isRetryableStreamError("invalid query parameters"), false);
});
