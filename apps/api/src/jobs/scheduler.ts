import type { Action } from '@gam/shared';
import { prisma } from '../db/client.js';
import { applyAction } from '../gmail/actions.js';
import { isInvalidGrant } from '../gmail/client.js';
import { logger } from '../logger.js';

const BATCH = 25;
const MAX_ATTEMPTS = 5;
const INTERVAL_MS = 60_000;

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (started) return;
  started = true;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
  logger.info('scheduled-action sweeper started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export async function tick(): Promise<{ processed: number }> {
  const now = new Date();
  const due = await prisma.scheduledAction.findMany({
    where: { status: 'pending', runAt: { lte: now } },
    orderBy: { runAt: 'asc' },
    take: BATCH,
  });

  let processed = 0;
  for (const s of due) {
    processed++;

    const rule = await prisma.rule.findUnique({ where: { id: s.ruleId } });
    if (!rule || !rule.enabled) {
      await prisma.scheduledAction.update({
        where: { id: s.id },
        data: { status: 'cancelled', lastError: 'rule_missing_or_disabled' },
      });
      continue;
    }

    try {
      const action = JSON.parse(s.action) as Action;
      await applyAction(s.userId, s.gmailMessageId, action);
      await prisma.scheduledAction.update({
        where: { id: s.id },
        data: { status: 'done', attempts: { increment: 1 } },
      });
    } catch (err) {
      const fatal = isInvalidGrant(err);
      const attempts = s.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS || fatal;
      await prisma.scheduledAction.update({
        where: { id: s.id },
        data: {
          attempts,
          lastError: String(err).slice(0, 1000),
          status: failed ? 'failed' : 'pending',
          runAt: failed ? s.runAt : new Date(Date.now() + backoffMs(attempts)),
        },
      });
      logger.warn({ err, scheduledId: s.id, attempts }, 'scheduled action failed');
    }
  }
  return { processed };
}

function backoffMs(attempts: number): number {
  // 1m, 5m, 15m, 60m, 60m…
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  return steps[Math.min(attempts - 1, steps.length - 1)] ?? 60_000;
}
