/**
 * Minimal, safe glob matcher supporting only the `*` wildcard (matches any run
 * of characters, including none). Used for vendor host allowlists
 * (e.g. "*.trusted.io") and agent-id targeting (e.g. "agt_research_*").
 *
 * Deliberately NOT a regex from user input — the pattern is escaped so a
 * malicious policy value cannot inject regex behavior (ReDoS, etc.).
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex metachars
  const withWildcard = escaped.replace(/\\\*/g, '.*'); // re-enable only `*`
  return new RegExp(`^${withWildcard}$`).test(value);
}

/** True if `value` matches any pattern in the list. */
export function globMatchAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => globMatch(p, value));
}
