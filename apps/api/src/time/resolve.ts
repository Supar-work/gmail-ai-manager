import type { RunAt } from '@gaf/shared';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { addDays, addHours, addMinutes, isWeekend, setHours, setMilliseconds, setMinutes, setSeconds } from 'date-fns';

export type Resolved = { runAtUtc: Date } | { unresolved: string };

export function resolveRunAt(
  runAt: RunAt | undefined,
  ctx: { now: Date; timezone: string },
): Resolved | 'immediate' {
  if (!runAt || runAt.kind === 'immediate') return 'immediate';
  if (runAt.kind === 'atTime') return { runAtUtc: new Date(runAt.iso) };
  if (runAt.kind === 'relative') {
    let t = ctx.now;
    if (runAt.minutes) t = addMinutes(t, runAt.minutes);
    if (runAt.hours) t = addHours(t, runAt.hours);
    if (runAt.days) t = addDays(t, runAt.days);
    return { runAtUtc: t };
  }
  if (runAt.kind === 'endOfDay') {
    const local = toZonedTime(ctx.now, ctx.timezone);
    const eod = setMilliseconds(setSeconds(setMinutes(setHours(local, 23), 59), 59), 0);
    return { runAtUtc: fromZonedTime(eod, ctx.timezone) };
  }
  if (runAt.kind === 'endOfNextBusinessDay') {
    const local = toZonedTime(ctx.now, ctx.timezone);
    let candidate = addDays(local, 1);
    while (isWeekend(candidate)) candidate = addDays(candidate, 1);
    const eod = setMilliseconds(setSeconds(setMinutes(setHours(candidate, 23), 59), 59), 0);
    return { runAtUtc: fromZonedTime(eod, ctx.timezone) };
  }
  // contentDerived should have been resolved by the classifier to atTime.
  return { unresolved: `content_derived_not_resolved:${runAt.hint ?? ''}` };
}
