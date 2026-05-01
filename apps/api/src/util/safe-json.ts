/**
 * Lossy JSON parsing helpers used wherever a column stores JSON text
 * (Rule.actionsJson, AgentAction.toolInputJson, …) and the caller
 * needs to keep moving when the row is malformed rather than 500ing.
 *
 * Centralised here so a fix (e.g. adding a logger.warn for malformed
 * rows) lands in one place instead of seven.
 */

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** As `safeJson`, but always returns an array — common for ArrayJSON columns. */
export function safeParseArray<T = unknown>(s: string | null | undefined): T[] {
  if (s == null) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
