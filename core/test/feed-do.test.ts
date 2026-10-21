import { test, mock } from "node:test";
import assert from "node:assert/strict";
import worker, { RadarDO } from "../../feed/src/index.js";
import type { Alert } from "../src/types.js";

// Durable Object storage stand-in: one Map shared by every instance built on
// it, which is what survives when the runtime evicts an instance.
function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = Date.now() + 60_000;
  const storage = {
    data,
    async get<T>(k: string): Promise<T | undefined> {
      return structuredClone(data.get(k)) as T | undefined;
    },
    async put(k: string, v: unknown): Promise<void> {
      data.set(k, structuredClone(v));
    },
    async delete(k: string | string[]): Promise<void> {
      for (const key of Array.isArray(k) ? k : [k]) data.delete(key);
    },
    async getAlarm(): Promise<number | null> {
      return alarm;
    },
    async setAlarm(t: number): Promise<void> {
      alarm = t;
    },
  };
  return { storage } as unknown as DurableObjectState & { storage: typeof storage };
}

const drain: Alert = {
  kind: "drain",
  scope: "pool",
  chain: "solana",
  subject: "PoolAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  label: "MEME/SOL (pumpswap)",
  deltaUsd: -40_000,
  reserveUsd: 5_000,
  prevReserveUsd: 45_000,
  pct: -40_000 / 45_000,
  block: "123",
  timestamp: 1781200000,
};

test("a drain held by an evicted instance is still confirmed by the next one", async () => {
  const state = fakeState();
  const env = { DRAIN_CONFIRM_SECONDS: "90" } as any;
  const t0 = Date.now();
  const now = mock.method(Date, "now", () => t0);
  try {
    const first = new RadarDO(state, env) as any;
    await first.handleAlert(drain);

    // eviction: the in-memory instance is gone, storage is not
    now.mock.mockImplementation(() => t0 + 120_000);
    const second = new RadarDO(state, env) as any;
    await second.resolvePending();

    const recent = (state.storage.data.get("recent") ?? []) as { alert: Alert; posted: boolean }[];
    assert.equal(recent.length, 1, "the held drain must be resolved, not lost");
    assert.equal(recent[0].alert.subject, drain.subject);
    assert.equal(state.storage.data.has("pending"), false, "a resolved drain leaves the hold");
  } finally {
    now.mock.restore();
  }
});

test("the public cache ignores the query string, so cache-busting cannot reach the radar", async () => {
  const store = new Map<string, Response>();
  const g = globalThis as any;
  const prev = g.caches;
  g.caches = {
    default: {
      async match(r: Request) {
        return store.get(r.url)?.clone();
      },
      async put(r: Request, res: Response) {
        store.set(r.url, res);
      },
    },
  };
  let radarHits = 0;
  const env = {
    RADAR: {
      idFromName: () => "singleton",
      get: () => ({
        fetch: async () => {
          radarHits++;
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      }),
    },
  } as any;
  const pendingPuts: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pendingPuts.push(p) } as any;
  try {
    for (const q of ["", "?x=1", "?x=2", "?cb=" + "z".repeat(40)]) {
      const res = await worker.fetch(new Request(`https://radar.example/api/live${q}`), env, ctx);
      assert.equal(res.status, 200);
      await Promise.all(pendingPuts);
    }
    assert.equal(radarHits, 1, "only the first request may wake the radar");
  } finally {
    g.caches = prev;
  }
});
