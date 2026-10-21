import type { Alert } from "./types.js";

/**
 * Data-source credit for outbound alert sinks (X, Telegram, Discord, …).
 * Sinks should append this by default and may allow opting out; see the
 * feed's POST_SUFFIX for the pattern.
 */
export const DATA_CREDIT = "data: dexpaprika.com";

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

const ZWSP = "\u200b";
const LABEL_MAX = 80;

/**
 * A label, chain or id that came from upstream data (token symbols are chosen
 * by whoever deployed the token), made safe to drop into chat text: one line,
 * bounded length, and no working mention, channel, masked-link or URL syntax.
 * A zero-width space after "@" and "<" stops @everyone, @here, <@id>, <@&role>
 * and <#channel>; one inside "](" and "://" stops masked links and auto-embeds.
 */
export function safeLabel(text: string): string {
  let out = String(text).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim();
  if (out.length > LABEL_MAX) out = `${out.slice(0, LABEL_MAX - 1)}…`;
  return out
    .replace(/@/g, `@${ZWSP}`)
    .replace(/</g, `<${ZWSP}`)
    .replace(/\]\(/g, `]${ZWSP}(`)
    .replace(/:\/\//g, `:${ZWSP}//`);
}

export function usd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function pct(p: number): string {
  if (!isFinite(p)) return "new";
  return `${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)}%`;
}

/**
 * One-line, emoji-tagged summary used by both the CLI and the X feed.
 *
 * Pool-scope drains net both legs, so they really do mean liquidity left the
 * pool, so those get the DRAIN siren. Token-scope events are one-sided by
 * nature (a whale buy drops reserves too), so they get the softer
 * RESERVE DROP/ADD copy to avoid branding a big swap as a rug.
 */
export function formatAlert(a: Alert): string {
  const drain = a.kind === "drain";
  const icon = a.scope === "pool" ? (drain ? "🚨" : "🟢") : drain ? "📉" : "📈";
  const verb = a.scope === "pool" ? (drain ? "DRAIN" : "ADD") : drain ? "RESERVE DROP" : "RESERVE ADD";
  const addr = safeLabel(shortAddr(a.subject));
  const name = a.label !== undefined ? safeLabel(a.label) : addr;
  const where = a.scope === "pool" ? "pool" : "token";
  return (
    `${icon} ${verb} · ${name} on ${safeLabel(a.chain)}\n` +
    `${usd(a.deltaUsd)} (${pct(a.pct)}) · reserve now ${usd(a.reserveUsd)}\n` +
    `${where} ${addr} · block ${safeLabel(a.block)}`
  );
}
