import { describe, expect, it } from 'vitest';
import { resolveRunAt } from './resolve.js';

const now = new Date('2026-04-18T14:00:00Z'); // a Saturday

describe('resolveRunAt', () => {
  it('returns immediate when runAt missing', () => {
    expect(resolveRunAt(undefined, { now, timezone: 'UTC' })).toBe('immediate');
  });

  it('returns immediate for kind=immediate', () => {
    expect(resolveRunAt({ kind: 'immediate' }, { now, timezone: 'UTC' })).toBe('immediate');
  });

  it('parses atTime ISO', () => {
    const r = resolveRunAt({ kind: 'atTime', iso: '2026-05-01T09:00:00Z' }, { now, timezone: 'UTC' });
    expect(r).toEqual({ runAtUtc: new Date('2026-05-01T09:00:00Z') });
  });

  it('adds relative minutes', () => {
    const r = resolveRunAt({ kind: 'relative', minutes: 30 }, { now, timezone: 'UTC' });
    if (r === 'immediate' || !('runAtUtc' in r)) throw new Error('expected scheduled');
    expect(r.runAtUtc.toISOString()).toBe('2026-04-18T14:30:00.000Z');
  });

  it('endOfDay resolves to 23:59:59 in tz', () => {
    const r = resolveRunAt({ kind: 'endOfDay' }, { now, timezone: 'America/New_York' });
    if (r === 'immediate' || !('runAtUtc' in r)) throw new Error('expected scheduled');
    // 23:59:59 EDT on 2026-04-18 = 03:59:59 UTC on 2026-04-19
    expect(r.runAtUtc.toISOString()).toBe('2026-04-19T03:59:59.000Z');
  });

  it('endOfNextBusinessDay skips weekends', () => {
    // now = Saturday UTC. next business day = Monday.
    const r = resolveRunAt({ kind: 'endOfNextBusinessDay' }, { now, timezone: 'UTC' });
    if (r === 'immediate' || !('runAtUtc' in r)) throw new Error('expected scheduled');
    expect(r.runAtUtc.toISOString().startsWith('2026-04-20T23:59:59')).toBe(true);
  });

  it('contentDerived without prior resolution is unresolved', () => {
    const r = resolveRunAt({ kind: 'contentDerived', hint: 'otp' }, { now, timezone: 'UTC' });
    expect(r).toHaveProperty('unresolved');
  });
});
