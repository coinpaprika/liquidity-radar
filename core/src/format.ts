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
  const name = a.label ?? shortAddr(a.subject);
  const where = a.scope === "pool" ? "pool" : "token";
  return (
    `${icon} ${verb} · ${name} on ${a.chain}\n` +
    `${usd(a.deltaUsd)} (${pct(a.pct)}) · reserve now ${usd(a.reserveUsd)}\n` +
    `${where} ${shortAddr(a.subject)} · block ${a.block}`
  );
}
