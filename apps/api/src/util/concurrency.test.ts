import { describe, expect, it } from 'vitest';
import { pMapLimit } from './concurrency.js';

describe('pMapLimit', () => {
  it('preserves input order', async () => {
    const out = await pMapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 5));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never has more than `limit` in-flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await pMapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles empty input', async () => {
    expect(await pMapLimit([], 5, async () => 1)).toEqual([]);
  });

  it('propagates rejections', async () => {
    await expect(
      pMapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
