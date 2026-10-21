// Guards for values the feed did not write itself.

/**
 * An id taken from an API response, if it is safe to use as one URL path
 * segment of a request that may carry the operator's key, else null. Ids are
 * not rewritten, so a valid one reaches the API exactly as it came.
 */
export function pathSegment(id: string): string | null {
  if (!id || id === "." || id === ".." || /[/\\?#%\s\x00-\x1f\x7f]/.test(id)) return null;
  return id;
}

/** Text for the public status page, with every configured secret removed. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  return out;
}
