import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRadarConfig } from "../src/config.js";

const valid = {
  minUsd: 25000,
  pctThreshold: 0.1,
  watch: [
    { method: "pool_reserves", chain: "ethereum", address: "0x88e6", label: "x" },
    { method: "token_reserves", chain: "solana", address: "abc" },
  ],
};

test("accepts a valid config", () => {
  assert.deepEqual(validateRadarConfig(valid), []);
});

test("rejects non-objects and empty watch", () => {
  assert.ok(validateRadarConfig(null).length > 0);
  assert.ok(validateRadarConfig("nope").length > 0);
  assert.ok(validateRadarConfig({}).length > 0);
  assert.ok(validateRadarConfig({ watch: [] }).length > 0);
});

test("flags a bad method with the entry index", () => {
  const errors = validateRadarConfig({
    watch: [{ method: "pool", chain: "ethereum", address: "0x1" }],
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("watch[0]"));
  assert.ok(errors[0].includes('"pool"'));
});

test("flags missing chain and address separately", () => {
  const errors = validateRadarConfig({
    watch: [{ method: "token_reserves" }],
  });
  assert.equal(errors.length, 2);
});

test("rejects non-finite thresholds", () => {
  assert.ok(validateRadarConfig({ ...valid, minUsd: NaN }).length > 0);
  assert.ok(validateRadarConfig({ ...valid, pctThreshold: -1 }).length > 0);
  assert.ok(validateRadarConfig({ ...valid, minUsd: "25000" }).length > 0);
});
