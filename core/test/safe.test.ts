import { test } from "node:test";
import assert from "node:assert/strict";
import { pathSegment, redact } from "../../feed/src/safe.js";

test("real pool and token ids pass through unchanged", () => {
  for (const id of [
    "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
    "So11111111111111111111111111111111111111112",
  ]) {
    assert.equal(pathSegment(id), id);
  }
});

test("ids that would leave their path segment are refused", () => {
  for (const id of ["", ".", "..", "../../usage", "abc/def", "abc\\def", "abc?x=1", "abc#f", "..%2Fusage", "%2e%2e", "a b", "a\nb"]) {
    assert.equal(pathSegment(id), null, JSON.stringify(id));
  }
});

test("configured secrets never reach the status text", () => {
  const key = "a1b2c3d4e5f6a7b8";
  const hook = "https://discord.com/api/webhooks/123/secret-token";
  const msg = `TypeError: Fetch API cannot load: ${hook} (auth ${key})`;
  const out = redact(msg, [key, hook]);
  assert.ok(!out.includes(key) && !out.includes("secret-token"), out);
  assert.equal(redact("plain", [undefined, ""]), "plain");
});
