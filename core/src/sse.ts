// Minimal SSE parser over a fetch ReadableStream. No dependency on EventSource,
// so the same code runs in Node 18+, Cloudflare Workers, Deno, and the browser.

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];

  const flush = (): SseMessage | undefined => {
    if (data.length === 0) return undefined;
    const msg: SseMessage = { event, data: data.join("\n"), id };
    event = undefined;
    id = undefined;
    data = [];
    return msg;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          const msg = flush();
          if (msg) yield msg;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat keepalive

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);

        if (field === "event") event = val;
        else if (field === "data") data.push(val);
        // the reserve stream tags messages with `request_id`, not `id`
        else if (field === "id" || field === "request_id") id = val;
      }
    }
    const msg = flush();
    if (msg) yield msg;
  } finally {
    // cancel tears down the underlying HTTP connection when the consumer
    // exits early (break/throw); after a normal EOF it's a no-op
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}
