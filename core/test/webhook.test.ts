import { test } from "node:test";
import assert from "node:assert/strict";
import { webhookBody } from "../../feed/src/webhook.js";
import { detect, DEFAULT_DETECT } from "../src/detect.js";
import { coercePoolEvent } from "../src/stream.js";

const alert = (() => {
  const e = coercePoolEvent({
    chain: "base", pool_id: "0x8b47", block: "1", previous_block: "0",
    tokens: [], total_reserve_usd: 1900, total_delta_usd: -66982,
    timestamp: 1781200000, block_timestamp: 1781200000,
  });
  const a = detect(e!, DEFAULT_DETECT);
  assert.ok(a);
  return a;
})();

test("discord webhook URLs get the content shape", () => {
  const b = JSON.parse(webhookBody("https://discord.com/api/webhooks/123/abc", "hi", alert));
  assert.deepEqual(Object.keys(b), ["content"]);
  assert.equal(b.content, "hi");
  const b2 = JSON.parse(webhookBody("https://canary.discordapp.com/api/webhooks/1/a", "x", alert));
  assert.ok(b2.content);
});

test("generic webhooks get text plus the full alert", () => {
  const b = JSON.parse(webhookBody("https://example.com/hook", "hi", alert));
  assert.equal(b.text, "hi");
  assert.equal(b.alert.kind, "drain");
  assert.equal(b.alert.deltaUsd, -66982);
});
