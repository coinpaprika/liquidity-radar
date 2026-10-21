// Minimal SSE parser over a fetch ReadableStream. No dependency on EventSource,
// so the same code runs in Node 18+, Cloudflare Workers, Deno, and the browser.

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export interface SseLimits {
  /** Longest line kept, in characters. A longer line is dropped with its event. */
  maxLineLength?: number;
  /** Most data kept for one event, in characters. A bigger event is dropped. */
  maxEventSize?: number;
  /** Told about every dropped line or event; parsing resumes at the next event. */
  onOverflow?: (what: "line" | "event", size: number) => void;
}

// A reserve event is a few hundred bytes of JSON; these leave wide headroom
// while keeping one bad message from growing a shared connection's memory.
export const DEFAULT_MAX_LINE_LENGTH = 256 * 1024;
export const DEFAULT_MAX_EVENT_SIZE = 1024 * 1024;

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  limits: SseLimits = {},
): AsyncGenerator<SseMessage> {
  const maxLine = limits.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const maxEvent = limits.maxEventSize ?? DEFAULT_MAX_EVENT_SIZE;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];
  let size = 0;
  // Overflow recovery: skip the rest of an over-long line, then every field up
  // to the next blank line, so the stream resyncs on the next whole event.
  let skipLine = false;
  let dropEvent = false;

  const reset = () => {
    event = undefined;
    id = undefined;
    data = [];
    size = 0;
  };
  const overflow = (what: "line" | "event", n: number) => {
    reset();
    dropEvent = true;
    limits.onOverflow?.(what, n);
  };
  const flush = (): SseMessage | undefined => {
    if (data.length === 0) return undefined;
    const msg: SseMessage = { event, data: data.join("\n"), id };
    reset();
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
        if (skipLine) {
          skipLine = false; // the tail of a line already reported as too long
          continue;
        }
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > maxLine) {
          overflow("line", line.length);
          continue;
        }

        if (line === "") {
          if (dropEvent) {
            dropEvent = false;
            reset();
            continue;
          }
          const msg = flush();
          if (msg) yield msg;
          continue;
        }
        if (dropEvent) continue;
        if (line.startsWith(":")) continue; // comment / heartbeat keepalive

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);

        if (field === "event") event = val;
        else if (field === "data") {
          size += val.length + 1;
          if (size > maxEvent) overflow("event", size);
          else data.push(val);
        }
        // the reserve stream tags messages with `request_id`, not `id`
        else if (field === "id" || field === "request_id") id = val;
      }
      // No newline yet: an unterminated line past the cap is dropped now
      // instead of being held until a newline that may never come.
      if (buf.length > maxLine) {
        if (!skipLine) overflow("line", buf.length);
        skipLine = true;
        buf = "";
      }
    }
    if (!dropEvent && !skipLine) {
      const msg = flush();
      if (msg) yield msg;
    }
  } finally {
    // cancel tears down the underlying HTTP connection when the consumer
    // exits early (break/throw); after a normal EOF it's a no-op
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}
