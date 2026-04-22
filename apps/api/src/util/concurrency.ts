/**
 * Run `fn` over each item with at most `limit` concurrent in-flight promises.
 * Preserves input order in the result array. Used for parallel Gmail fetches
 * and parallel `claude -p` classify calls.
 *
 * `shouldContinue`, if provided, is consulted between items. Returning false
 * causes every worker to exit its loop without claiming further items — the
 * already-inflight tasks still resolve, but no new work starts. Entries for
 * skipped items are left as undefined in the returned array.
 */
export async function pMapLimit<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
  opts: { shouldContinue?: () => boolean } = {},
): Promise<U[]> {
  if (limit < 1) throw new Error('limit must be >= 1');
  const results: U[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (opts.shouldContinue && !opts.shouldContinue()) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
