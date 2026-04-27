import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { ActionSchema, type Action } from '@gam/shared';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { applyAction } from '../gmail/actions.js';
import { recordAgentAction, inverseAction } from '../audit/record.js';
import { GoogleTokenError, isInvalidGrant, markNeedsReauth } from '../gmail/client.js';
import { logger } from '../logger.js';

/**
 * Audit-log surface. Every mutating code path (rules, scheduler, cleanup
 * wizard, future chat agent) writes an `AgentAction` row via
 * apps/api/src/audit/record.ts. This router exposes them for read +
 * one-click reversal.
 */

export const agentActionsRouter: RouterT = Router();
agentActionsRouter.use(requireUser);

// ── GET / — list with filters ──────────────────────────────────────────

const ListQuerySchema = z.object({
  source: z.enum(['rule', 'schedule', 'cleanup', 'chat', 'consolidator']).optional(),
  targetType: z.enum(['gmailMessage', 'gmailLabel', 'rule', 'scheduledAction']).optional(),
  /** ISO timestamp; only entries newer than this. */
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(), // AgentAction.id of the last row from previous page
});

agentActionsRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_query', details: parsed.error.flatten() });
    return;
  }

  const where: import('@prisma/client').Prisma.AgentActionWhereInput = { userId };
  if (parsed.data.source) where.source = parsed.data.source;
  if (parsed.data.targetType) where.targetType = parsed.data.targetType;
  if (parsed.data.since) where.createdAt = { gt: new Date(parsed.data.since) };

  const rows = await prisma.agentAction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parsed.data.limit + 1, // peek for pagination
    ...(parsed.data.cursor
      ? { cursor: { id: parsed.data.cursor }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > parsed.data.limit;
  const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.id : null;

  res.json({
    rows: page.map(toApiShape),
    nextCursor,
  });
});

// ── POST /:id/reverse — apply the stored inverse Action ────────────────

agentActionsRouter.post('/:id/reverse', async (req, res) => {
  const userId = getUserId(req);
  const original = await prisma.agentAction.findFirst({
    where: { id: req.params.id, userId },
  });
  if (!original) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (original.reversedAt) {
    res.status(409).json({ error: 'already_reversed' });
    return;
  }
  if (!original.reversibleAs) {
    res.status(409).json({ error: 'not_reversible' });
    return;
  }

  let inverse: Action;
  try {
    const parsed = ActionSchema.safeParse(JSON.parse(original.reversibleAs));
    if (!parsed.success) throw new Error(parsed.error.message);
    inverse = parsed.data;
  } catch (err) {
    logger.warn({ err, id: original.id }, 'invalid reversibleAs json');
    res.status(500).json({ error: 'invalid_reversible' });
    return;
  }

  // Only Gmail-message reversals are wired today (label add/remove, archive,
  // markRead/star/markImportant). Rule + scheduledAction reversal would
  // need separate handlers; reject here so the UI can show "not supported"
  // rather than silently failing.
  if (original.targetType !== 'gmailMessage') {
    res.status(409).json({ error: 'unsupported_target_type' });
    return;
  }

  try {
    // Apply the inverse and let applyAction itself record the new row.
    // The reversal's source is 'chat' since it's a user-initiated action
    // through the audit-log UI; we link it back to the original via
    // sourceId so the UI can show the pair.
    await applyAction(userId, original.targetId, inverse, {
      source: 'chat',
      sourceId: original.id,
      reasoning: `reversal of ${original.toolName} (audit row ${original.id})`,
    });

    // Mark the original row reversed. We pick the freshly-inserted
    // AgentAction id by looking it up — applyAction already wrote it.
    const newest = await prisma.agentAction.findFirst({
      where: {
        userId,
        source: 'chat',
        sourceId: original.id,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await prisma.agentAction.update({
      where: { id: original.id },
      data: {
        reversedAt: new Date(),
        reversedBy: newest?.id ?? null,
      },
    });

    res.json({ ok: true, reversedBy: newest?.id ?? null });
  } catch (err) {
    if (err instanceof GoogleTokenError || isInvalidGrant(err)) {
      void markNeedsReauth(userId);
      res.status(401).json({ error: 'needs_reauth' });
      return;
    }
    logger.error({ err, userId, id: original.id }, 'reversal failed');
    res.status(500).json({
      error: 'reverse_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── shape helper ───────────────────────────────────────────────────────

function toApiShape(row: import('@prisma/client').AgentAction) {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.sourceId,
    targetType: row.targetType,
    targetId: row.targetId,
    toolName: row.toolName,
    toolInput: safeJson(row.toolInputJson),
    toolResult: row.toolResultJson ? safeJson(row.toolResultJson) : null,
    reasoning: row.reasoning,
    reversibleAs: row.reversibleAs ? safeJson(row.reversibleAs) : null,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    reversedBy: row.reversedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Re-exported so callers in other modules can compute inverses without
// reaching into ../audit/record.ts directly.
export { inverseAction };
