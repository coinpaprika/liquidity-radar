// Generic outbound sink: every gated alert POSTs to WEBHOOK_URL.
//
// Works with anything that accepts a webhook. Discord URLs are detected and
// get Discord's {content} shape, everything else gets {text, alert} JSON.
// No WEBHOOK_URL configured = fail-closed dry run: catches stay on the
// status page and nothing leaves the worker.

import type { Alert } from "../../core/src/index.js";

export interface SinkEnv {
  WEBHOOK_URL?: string;
}

export interface PostResult {
  ok: boolean;
  dryRun: boolean;
  status?: number;
  error?: string;
  /** Set on 429: do not send again before this (ms epoch). */
  rateLimitedUntilMs?: number;
}

export function isLive(env: SinkEnv): boolean {
  return !!env.WEBHOOK_URL;
}

/** Discord webhooks want {content}; everything else gets the full payload. */
export function webhookBody(url: string, text: string, alert: Alert): string {
  if (/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) {
    return JSON.stringify({ content: text });
  }
  return JSON.stringify({ text, alert });
}

export async function postAlert(text: string, alert: Alert, env: SinkEnv): Promise<PostResult> {
  const url = env.WEBHOOK_URL;
  if (!url) {
    console.log(`[sink:dry-run]\n${text}\n`);
    return { ok: true, dryRun: true };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: webhookBody(url, text, alert),
    });
    if (res.ok) return { ok: true, dryRun: false, status: res.status };
    const body = (await res.text()).slice(0, 300);
    const result: PostResult = {
      ok: false,
      dryRun: false,
      status: res.status,
      error: `webhook responded ${res.status}: ${body}`,
    };
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      result.rateLimitedUntilMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Date.now() + retryAfter * 1000
          : Date.now() + 5 * 60 * 1000;
    }
    return result;
  } catch (err) {
    return { ok: false, dryRun: false, error: String(err) };
  }
}
