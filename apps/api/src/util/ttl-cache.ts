/**
 * Tiny in-memory TTL cache. Entries expire on access — no background sweep.
 * Fine for caches keyed on per-user resources where the key space is bounded
 * (a few hundred mirror rows). If we ever need a bounded size, swap for
 * lru-cache.
 */
export class TtlCache<V> {
  private store = new Map<string, { at: number; value: V }>();
  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { at: Date.now(), value });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /** Drop expired entries. Call occasionally to keep memory bounded. */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now - v.at > this.ttlMs) this.store.delete(k);
    }
  }
}
