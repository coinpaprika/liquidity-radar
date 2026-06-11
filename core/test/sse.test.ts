import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse, type SseMessage } from "../src/sse.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const msg of parseSse(stream)) out.push(msg);
  return out;
}

test("parses a complete event with event, request_id and data", async () => {
  const msgs = await collect(
    streamOf('event: token_reserves\nrequest_id: 0\ndata: {"chain":"ethereum"}\n\n'),
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event, "token_reserves");
  assert.equal(msgs[0].id, "0");
  assert.equal(msgs[0].data, '{"chain":"ethereum"}');
});

test("survives chunk boundaries splitting a line mid-field", async () => {
  const msgs = await collect(
    streamOf("event: pool_res", "erves\nda", 'ta: {"a"', ":1}\n", "\n"),
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event, "pool_reserves");
  assert.equal(msgs[0].data, '{"a":1}');
});

test("joins multiple data lines with newline", async () => {
  const msgs = await collect(streamOf("data: line1\ndata: line2\n\n"));
  assert.equal(msgs[0].data, "line1\nline2");
});

test("skips comment/heartbeat lines", async () => {
  const msgs = await collect(
    streamOf(": keepalive\n\ndata: real\n\n: another comment\n"),
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].data, "real");
});

test("handles CRLF line endings", async () => {
  const msgs = await collect(streamOf("event: ping\r\ndata: {}\r\n\r\n"));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event, "ping");
  assert.equal(msgs[0].data, "{}");
});

test("flushes a final event with no trailing blank line at EOF", async () => {
  const msgs = await collect(streamOf("data: tail"));
  // no trailing newline at all: the line never completes, so nothing buffered
  // as a *line*; but with a newline it must flush at EOF:
  const msgs2 = await collect(streamOf("data: tail\n"));
  assert.equal(msgs.length, 0);
  assert.equal(msgs2.length, 1);
  assert.equal(msgs2[0].data, "tail");
});

test("emits two consecutive events separately", async () => {
  const msgs = await collect(
    streamOf("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"),
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].event, "a");
  assert.equal(msgs[1].event, "b");
});

test("value without leading space after colon is preserved", async () => {
  const msgs = await collect(streamOf("data:nospace\n\n"));
  assert.equal(msgs[0].data, "nospace");
});
