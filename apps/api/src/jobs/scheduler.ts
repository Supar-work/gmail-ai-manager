import type { Action } from '@gam/shared';
import { prisma } from '../db/client.js';
import { applyAction } from '../gmail/actions.js';
import { isInvalidGrant } from '../gmail/client.js';
import { logger } from '../logger.js';

/**
 * Scheduled-action sweeper. Polls for `pending` rows whose `runAt` has
 * passed, fires their action through the standard `applyAction` path
 * (which writes its own audit-log row), and flips the row to `done`.
 *
 * Hardening properties:
 *   - **Re-entrancy**: only one tick runs at a time. A long-running
 *     batch under throttling won't stack with the next interval.
 *   - **At-most-once for non-idempotent actions**: each row is claimed
 *     atomically (pending → running) before the mutation. A claim that
 *     loses the race skips. On crash mid-mutation the row stays
 *     `running`; the startup recovery sweep flips long-`running` rows
 *     back to `pending` (with `attempts` already incremented), so the
 *     re-fire is bounded.
 *   - **Stale-after-sleep cap**: rows whose `runAt` is older than
 *     `STALE_AFTER_MS` (the laptop slept) get marked `stale` instead of
 *     firing — the user's "in 1 hour" intent doesn't survive an 8-hour
 *     sleep. They're surfaced in the audit-log UI for manual review.
 */

const BATCH = 25;
const MAX_ATTEMPTS = 5;
const INTERVAL_MS = 60_000;
// runAt older than this gets marked stale instead of firing. Six hours
// is long enough to absorb a normal lunch-break sleep but short enough
// that an overnight-asleep machine doesn't wake up and dump a tidal
// wave of "in 1 hour" actions all at once.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
// A `running` row this old is presumed to have crashed mid-flight; the
// startup sweep returns it to `pending` so the next tick re-fires it.
const RUNNING_STUCK_MS = 10 * 60 * 1000;

let started = false;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startScheduler(): void {
  if (started) return;
  started = true;
  void recoverStuckRunning().then(() => void tick());
  timer = setInterval(() => void tick(), INTERVAL_MS);
  logger.info('scheduled-action sweeper started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  ticking = false;
}

export async function tick(): Promise<{ processed: number; skipped: boolean }> {
  // Re-entrancy guard. A previous tick that overran into this interval
  // owns the work; this one bows out so we don't double-fire under
  // backpressure.
  if (ticking) {
    logger.debug('scheduler tick already running; skipping');
    return { processed: 0, skipped: true };
  }
  ticking = true;
  try {
    return await tickInner();
  } finally {
    ticking = false;
  }
}

async function tickInner(): Promise<{ processed: number; skipped: false }> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);

  // Stale cap: don't fire actions whose runAt was hours ago — the user
  // expected them to fire on time, not after sleep+wake. Mark them so
  // they're visible but skipped.
  const stale = await prisma.scheduledAction.updateMany({
    where: { status: 'pending', runAt: { lt: staleBefore } },
    data: { status: 'stale', lastError: 'runAt too far in the past' },
  });
  if (stale.count > 0) {
    logger.warn({ count: stale.count }, 'marked scheduled actions stale');
  }

  // N+1 fix: pull rule alongside scheduledAction in a single query.
  const due = await prisma.scheduledAction.findMany({
    where: { status: 'pending', runAt: { gte: staleBefore, lte: now } },
    orderBy: { runAt: 'asc' },
    take: BATCH,
    include: { rule: true },
  });

  let processed = 0;
  for (const s of due) {
    if (!s.rule || !s.rule.enabled) {
      await prisma.scheduledAction.update({
        where: { id: s.id },
        data: { status: 'cancelled', lastError: 'rule_missing_or_disabled' },
      });
      continue;
    }

    // Claim atomically. If another worker (or a re-fire after crash)
    // has already grabbed it, skip — `updateMany` returns count=0 when
    // the precondition fails.
    const claim = await prisma.scheduledAction.updateMany({
      where: { id: s.id, status: 'pending' },
      data: { status: 'running', attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue;

    processed++;

    try {
      const action = JSON.parse(s.action) as Action;
      await applyAction(s.userId, s.gmailMessageId, action, {
        source: 'schedule',
        sourceId: s.id,
        reasoning: `scheduled action firing at ${s.runAt.toISOString()}`,
      });
      await prisma.scheduledAction.update({
        where: { id: s.id },
        data: { status: 'done' },
      });
    } catch (err) {
      const fatal = isInvalidGrant(err);
      const attempts = s.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS || fatal;
      await prisma.scheduledAction.update({
        where: { id: s.id },
        data: {
          lastError: String(err).slice(0, 1000),
          status: failed ? 'failed' : 'pending',
          runAt: failed ? s.runAt : new Date(Date.now() + backoffMs(attempts)),
        },
      });
      logger.warn({ err, scheduledId: s.id, attempts }, 'scheduled action failed');
    }
  }
  return { processed, skipped: false };
}

/**
 * On startup, return any rows stuck in `running` for more than
 * RUNNING_STUCK_MS to `pending` so they get re-fired. Without this, a
 * crash mid-mutation would leave the row inert forever.
 */
async function recoverStuckRunning(): Promise<void> {
  const cutoff = new Date(Date.now() - RUNNING_STUCK_MS);
  const recovered = await prisma.scheduledAction.updateMany({
    where: { status: 'running', updatedAt: { lt: cutoff } },
    data: { status: 'pending' },
  });
  if (recovered.count > 0) {
    logger.warn(
      { count: recovered.count },
      'recovered scheduled actions stuck in running',
    );
  }
}

function backoffMs(attempts: number): number {
  // 1m, 5m, 15m, 60m, 60m…
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  return steps[Math.min(attempts - 1, steps.length - 1)] ?? 60_000;
}
