import { test } from "node:test";
import assert from "node:assert/strict";
import { createRadar, type WatchEntry } from "../src/index.js";

// Stand-in for the reserve stream's POST multiplex. A connection whose body
// carries the bad address is rejected with one in-stream error, the way the
// server rejects a whole connection over one entry; any other connection
// sends one pool event per entry and stays open until aborted.
function stubStream(badAddress: string, errorMessage: string) {
  const subscribed: string[][] = [];
  const fetchStub = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const wanted = JSON.parse(String(init?.body)) as { chain: string; address: string }[];
    subscribed.push(wanted.map((w) => w.address));
    const enc = new TextEncoder();
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        if (wanted.some((w) => w.address === badAddress)) {
          c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`));
          c.close();
          return;
        }
        wanted.forEach((w, i) => {
          const ev = {
            chain: w.chain, pool_id: w.address, block: "2", previous_block: "1", tokens: [],
            total_reserve_usd: 1000, total_delta_usd: 0, timestamp: 1, block_timestamp: 1,
          };
          c.enqueue(enc.encode(`event: pool_reserves\nrequest_id: ${i}\ndata: ${JSON.stringify(ev)}\n\n`));
        });
        signal?.addEventListener("abort", () => {
          try { c.close(); } catch {}
        }, { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetchStub, subscribed };
}

const entry = (address: string): WatchEntry => ({ method: "pool_reserves", chain: "solana", address, label: address.slice(0, 4) });

async function runUntil(
  watch: WatchEntry[],
  badAddress: string,
  errorMessage: string,
  want: (seen: Set<string>) => boolean,
) {
  const { fetchStub, subscribed } = stubStream(badAddress, errorMessage);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchStub as typeof fetch;
  const fatals: string[][] = [];
  const seen = new Set<string>();
  const radar = createRadar({ watch, minUsd: 1e12 }, {
    onAlert: () => {},
    onEvent: (_e, en) => {
      seen.add(en.address);
    },
    onFatal: (_err, entries) => fatals.push(entries.map((e) => e.address)),
    onWarning: () => {},
    onError: () => {},
  });
  const done = radar.start();
  const deadline = Date.now() + 2000;
  while (!want(seen) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  radar.stop();
  await done;
  globalThis.fetch = realFetch;
  return { fatals, seen, subscribed };
}

test("an entry the server names is dropped and its chunk keeps streaming", async () => {
  const bad = "BADbad1111111111111111111111111111111111111";
  const good = ["Good1111111111111111111111111111111111111111", "Good2222222222222222222222222222222222222222"];
  const { fatals, seen } = await runUntil(
    [entry(good[0]), entry(bad), entry(good[1])],
    bad,
    "token not found: solana/BADbad…",
    (s) => good.every((g) => s.has(g)),
  );
  assert.deepEqual(fatals, [[bad]], "only the rejected entry is reported");
  for (const g of good) assert.ok(seen.has(g), `${g} must keep streaming`);
});

test("an unattributed rejection is narrowed down to the one bad entry", async () => {
  const bad = "Poison11111111111111111111111111111111111111";
  const good = ["A", "B", "C", "D"].map((p) => p.repeat(44));
  const { fatals, seen } = await runUntil(
    [entry(good[0]), entry(good[1]), entry(bad), entry(good[2]), entry(good[3])],
    bad,
    "subscription rejected",
    (s) => good.every((g) => s.has(g)),
  );
  assert.deepEqual(fatals, [[bad]], "only the poisoned entry is reported");
  for (const g of good) assert.ok(seen.has(g), `${g.slice(0, 4)} must keep streaming`);
});

test("a caller-level rejection stops the chunk without blaming any entry", async () => {
  const bad = "Key111111111111111111111111111111111111111111";
  const watch = [entry(bad), entry("Z".repeat(44))];
  const { fatals, subscribed } = await runUntil(watch, bad, "invalid api key", () => false);
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].length, 2, "the whole chunk is reported, not a scapegoat");
  assert.equal(subscribed.length, 1, "no split for an error about the caller");
});
