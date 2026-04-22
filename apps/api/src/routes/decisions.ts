import { Router, type Router as RouterT } from 'express';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';

export const decisionsRouter: RouterT = Router();

decisionsRouter.use(requireUser);

type Scheduled = { ruleId?: string; action?: unknown; runAt?: string; scheduledId?: string };

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

decisionsRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const rows = await prisma.emailDecision.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const decisions = rows.map((d) => ({
    id: d.id,
    gmailMessageId: d.gmailMessageId,
    matchedRuleIds: parseJson<string[]>(d.matchedRuleIds, []),
    reasoning: parseJson<Array<{ ruleId: string; reasoning: string }>>(d.reasoning, []),
    actionsApplied: parseJson<unknown[]>(d.actionsApplied, []),
    actionsScheduled: parseJson<Scheduled[]>(d.actionsScheduled, []),
    modelVersion: d.modelVersion,
    createdAt: d.createdAt,
  }));

  const scheduledIds = decisions.flatMap((d) =>
    (d.actionsScheduled ?? []).map((s) => s.scheduledId).filter((id): id is string => !!id),
  );

  const scheduled =
    scheduledIds.length > 0
      ? await prisma.scheduledAction.findMany({
          where: { id: { in: scheduledIds } },
          select: { id: true, status: true, runAt: true, lastError: true, attempts: true },
        })
      : [];
  const scheduledById = new Map(scheduled.map((s) => [s.id, s] as const));

  res.json({ decisions, scheduled: Object.fromEntries(scheduledById) });
});
