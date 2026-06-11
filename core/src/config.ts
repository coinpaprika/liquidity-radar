import type { ReserveMethod } from "./types.js";

const METHODS: ReserveMethod[] = ["token_reserves", "pool_reserves"];

/**
 * Validate a parsed watchlist/config object. Returns human-readable problems;
 * an empty array means valid. Used by the CLI (fail fast on typos) and the
 * Worker (fall back loudly instead of silently).
 */
export function validateRadarConfig(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return ["config must be a JSON object"];
  const cfg = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!Array.isArray(cfg.watch) || cfg.watch.length === 0) {
    return ['"watch" must be a non-empty array'];
  }
  cfg.watch.forEach((w: any, i: number) => {
    const at = `watch[${i}]`;
    if (!w || typeof w !== "object") {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (!METHODS.includes(w.method)) {
      errors.push(
        `${at}: method ${JSON.stringify(w.method)} invalid (expected "token_reserves" or "pool_reserves")`,
      );
    }
    if (typeof w.chain !== "string" || w.chain.length === 0) {
      errors.push(`${at}: chain must be a non-empty string`);
    }
    if (typeof w.address !== "string" || w.address.length === 0) {
      errors.push(`${at}: address must be a non-empty string`);
    }
  });

  for (const k of ["minUsd", "pctThreshold"]) {
    const v = cfg[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      errors.push(`"${k}" must be a non-negative finite number`);
    }
  }
  if (cfg.baseUrl !== undefined && typeof cfg.baseUrl !== "string") {
    errors.push('"baseUrl" must be a string URL');
  }
  return errors;
}
