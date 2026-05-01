import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
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

const ListQuery = z.object({
  /** Show only decisions where at least one rule matched (default true).
   *  When false, surfaces classifier passes that hit no rules — useful
   *  for debugging "why didn't anything fire?" but noisy for the UI. */
  onlyActed: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v !== 'false'),
  /** Filter to a specific rule id. */
  ruleId: z.string().optional(),
  /** Cursor — id of the last row from the previous page. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

decisionsRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_query', details: parsed.error.flatten() });
    return;
  }
  const { onlyActed, ruleId, cursor, limit } = parsed.data;

  // SQLite + Prisma can't filter on JSON-encoded matchedRuleIds, so we
  // peek 4× the page size and do the boolean filtering in JS. Plenty
  // for typical inboxes; bump the multiplier later if it gets sparse.
  const peekTake = Math.min(limit * 4 + 1, 500);
  const rows = await prisma.emailDecision.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: peekTake,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  // Filter: drop decisions where no rule matched OR no actions taken,
  // and (when ruleId is set) drop those that didn't include that rule.
  const filtered = rows.filter((d) => {
    const matched = parseJson<string[]>(d.matchedRuleIds, []);
    const applied = parseJson<unknown[]>(d.actionsApplied, []);
    const scheduled = parseJson<Scheduled[]>(d.actionsScheduled, []);
    if (onlyActed) {
      if (matched.length === 0 && applied.length === 0 && scheduled.length === 0) return false;
    }
    if (ruleId && !matched.includes(ruleId)) return false;
    return true;
  });

  const hasMore = filtered.length > limit;
  const page = hasMore ? filtered.slice(0, limit) : filtered;
  const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null;

  // Hydrate sender / subject so the UI can render readable rows
  // without an extra round-trip per decision.
  const messageIds = page.map((d) => d.gmailMessageId);
  const messages =
    messageIds.length > 0
      ? await prisma.inboxMessage.findMany({
          where: { userId, gmailMessageId: { in: messageIds } },
          select: {
            gmailMessageId: true,
            fromHeader: true,
            subject: true,
            snippet: true,
            listId: true,
            originalFromHeader: true,
          },
        })
      : [];
  const messageById = new Map(messages.map((m) => [m.gmailMessageId, m]));

  const ruleIds = Array.from(
    new Set(
      page.flatMap((d) => parseJson<string[]>(d.matchedRuleIds, [])),
    ),
  );
  const rules =
    ruleIds.length > 0
      ? await prisma.rule.findMany({
          where: { userId, id: { in: ruleIds } },
          select: { id: true, naturalLanguage: true },
        })
      : [];
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const decisions = page.map((d) => {
    const matched = parseJson<string[]>(d.matchedRuleIds, []);
    const applied = parseJson<unknown[]>(d.actionsApplied, []);
    const scheduledList = parseJson<Scheduled[]>(d.actionsScheduled, []);
    const m = messageById.get(d.gmailMessageId);
    return {
      id: d.id,
      gmailMessageId: d.gmailMessageId,
      from: m?.fromHeader ?? null,
      subject: m?.subject ?? null,
      snippet: m?.snippet ?? null,
      listId: m?.listId ?? null,
      originalFrom: m?.originalFromHeader ?? null,
      matchedRules: matched.map((id) => ({
        id,
        naturalLanguage: ruleById.get(id)?.naturalLanguage ?? '(rule deleted)',
      })),
      reasoning: parseJson<Array<{ ruleId: string; reasoning: string }>>(d.reasoning, []),
      actionsApplied: applied,
      actionsScheduled: scheduledList,
      modelVersion: d.modelVersion,
      createdAt: d.createdAt.toISOString(),
    };
  });

  // Schedule status hydration (kept for the inline scheduled-action chip).
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

  res.json({
    decisions,
    scheduled: Object.fromEntries(scheduledById),
    nextCursor,
  });
});
