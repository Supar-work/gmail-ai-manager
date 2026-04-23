import { randomBytes, createHash } from 'node:crypto';
import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import {
  ActionSchema,
  CleanupApplyResultSchema,
  CleanupPreviewSchema,
  CleanupProposalSchema,
  CleanupScopeSchema,
  CleanupSessionSchema,
  type CleanupProposal,
  type CleanupPreview,
  type InboxMessagePreview,
} from '@gam/shared';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { syncInbox } from '../gmail/sync.js';
import { GoogleTokenError, isInvalidGrant, markNeedsReauth } from '../gmail/client.js';
import {
  proposeAndRefine,
  proposeQueryFromRule,
  type EmailForProposal,
} from '../claude/inbox-rule-propose.js';
import { searchMatchesForRule } from '../gmail/inbox-rule-search.js';
import { applyRuleToScope } from '../gmail/apply-rule-to-scope.js';
import { TtlCache } from '../util/ttl-cache.js';
import { logger } from '../logger.js';

export const inboxCleanupRouter: RouterT = Router();
inboxCleanupRouter.use(requireUser);

// ── In-memory sessions ─────────────────────────────────────────────────────

const SESSION_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_INBOX_QUEUE = 200;

type AppliedRuleSummary = {
  ruleId: string;
  naturalLanguage: string;
  scope: 'inbox-only' | 'all-mail' | 'save-only';
  appliedImmediateCount: number;
  scheduledCount: number;
  coveredInboxMessageIds: string[];
};

type SessionState = {
  userId: string;
  createdAt: number;
  queue: string[]; // gmailMessageIds in order
  covered: Set<string>; // ids no longer in queue
  applied: AppliedRuleSummary[];
  totalInbox: number;
};

const sessions = new Map<string, SessionState>();

function sweep(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getSession(sessionId: string, userId: string): SessionState {
  sweep();
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  if (s.userId !== userId) throw new Error('session_not_found');
  return s;
}

// ── Caches (12h) ───────────────────────────────────────────────────────────

const TTL_12H = 12 * 60 * 60 * 1000;
const proposalCache = new TtlCache<CleanupProposal>(TTL_12H);
const previewCache = new TtlCache<CleanupPreview>(TTL_12H);
const queryFromRuleCache = new TtlCache<string>(TTL_12H);

function proposalKey(userId: string, messageId: string, historyId: string | null): string {
  return `${userId}:${messageId}:${historyId ?? 'nh'}`;
}

function ruleHash(naturalLanguage: string): string {
  return createHash('sha256').update(naturalLanguage).digest('hex').slice(0, 16);
}

function queryHash(gmailQuery: string): string {
  return createHash('sha256').update(gmailQuery).digest('hex').slice(0, 16);
}

// ── Error helper (mirrors pattern in other routers) ────────────────────────

function handleGmailError(err: unknown, userId: string, res: import('express').Response): boolean {
  if (err instanceof GoogleTokenError || isInvalidGrant(err)) {
    void markNeedsReauth(userId);
    res.status(401).json({ error: 'needs_reauth' });
    return true;
  }
  return false;
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /session/start — start a new cleanup wizard session. Runs an
 * inbox sync so the queue reflects what's currently in Gmail, then
 * loads the most recent MAX_INBOX_QUEUE messages.
 */
inboxCleanupRouter.post('/session/start', async (req, res) => {
  const userId = getUserId(req);
  try {
    await syncInbox(userId, { maxMessages: MAX_INBOX_QUEUE });
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.warn({ err, userId }, 'inbox sync failed — continuing with cached data');
  }

  const rows = await prisma.inboxMessage.findMany({
    where: { userId },
    orderBy: { internalDate: 'desc' },
    take: MAX_INBOX_QUEUE,
    select: { gmailMessageId: true },
  });
  const totalInbox = await prisma.inboxMessage.count({ where: { userId } });

  const sessionId = randomBytes(9).toString('base64url');
  const state: SessionState = {
    userId,
    createdAt: Date.now(),
    queue: rows.map((r) => r.gmailMessageId),
    covered: new Set(),
    applied: [],
    totalInbox,
  };
  sessions.set(sessionId, state);

  const body = CleanupSessionSchema.parse({
    sessionId,
    messageIds: state.queue,
    totalInbox,
  });
  res.json(body);
});

/**
 * GET /session/:id — current session snapshot (uncovered queue + applied rules).
 */
inboxCleanupRouter.get('/session/:id', async (req, res) => {
  const userId = getUserId(req);
  let state: SessionState;
  try {
    state = getSession(req.params.id, userId);
  } catch {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  res.json({
    sessionId: req.params.id,
    messageIds: state.queue.filter((id) => !state.covered.has(id)),
    coveredCount: state.covered.size,
    totalInbox: state.totalInbox,
    applied: state.applied,
  });
});

/**
 * GET /session/:id/message/:messageId — minimal email preview for the
 * wizard header card. Reads from the local InboxMessage mirror.
 */
inboxCleanupRouter.get('/session/:id/message/:messageId', async (req, res) => {
  const userId = getUserId(req);
  try {
    getSession(req.params.id, userId);
  } catch {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  const row = await prisma.inboxMessage.findFirst({
    where: { userId, gmailMessageId: req.params.messageId },
  });
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const preview: InboxMessagePreview = {
    messageId: row.gmailMessageId,
    from: row.fromHeader,
    to: row.toHeader,
    subject: row.subject,
    snippet: row.snippet,
    date: row.dateHeader,
  };
  res.json(preview);
});

/**
 * POST /session/:id/propose — run the full propose → search → evaluate
 * → refine loop for a single email. Returns the final proposal with
 * match set attached.
 */
const ProposeBody = z.object({ messageId: z.string() });

inboxCleanupRouter.post('/session/:id/propose', async (req, res) => {
  const userId = getUserId(req);
  const parsed = ProposeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  let state: SessionState;
  try {
    state = getSession(req.params.id, userId);
  } catch {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  const row = await prisma.inboxMessage.findFirst({
    where: { userId, gmailMessageId: parsed.data.messageId },
  });
  if (!row) {
    res.status(404).json({ error: 'message_not_found' });
    return;
  }

  const cacheK = proposalKey(userId, row.gmailMessageId, row.historyId);
  const cached = proposalCache.get(cacheK);
  if (cached) {
    res.json(cached);
    return;
  }

  const email: EmailForProposal = {
    messageId: row.gmailMessageId,
    from: row.fromHeader,
    to: row.toHeader,
    subject: row.subject,
    snippet: row.snippet,
    body: row.bodyText,
    labels: safeLabels(row.labelIds),
    date: row.dateHeader,
  };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const timezone = user?.timezone ?? 'UTC';

  try {
    const result = await proposeAndRefine({
      email,
      nowIso: new Date().toISOString(),
      timezone,
      model: user?.claudeModel ?? undefined,
      searchMatches: (query) => searchMatchesForRule(userId, query),
    });

    const proposal: CleanupProposal = {
      messageId: row.gmailMessageId,
      naturalLanguage: result.naturalLanguage,
      actions: result.actions,
      gmailQuery: result.gmailQuery,
      groupDescription: result.groupDescription,
      confidence: result.confidence,
      reasoning: result.reasoning,
      refineHistory: result.refineHistory,
      samples: result.samples,
      totals: result.totals,
    };

    CleanupProposalSchema.parse(proposal); // runtime sanity check
    proposalCache.set(cacheK, proposal);
    // Also seed the preview cache under the initial query so edits that
    // revert to the original don't re-hit Gmail.
    previewCache.set(`${userId}:${queryHash(proposal.gmailQuery)}`, {
      gmailQuery: proposal.gmailQuery,
      samples: proposal.samples,
      totals: proposal.totals,
    });

    res.json(proposal);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId, messageId: row.gmailMessageId }, 'propose failed');
    res.status(500).json({
      error: 'propose_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /session/:id/preview-matches — debounced re-search after the
 * user edits the natural-language rule. Derives a fresh Gmail query
 * from the edited text (cached per text hash) then fetches samples.
 */
const PreviewBody = z.object({
  naturalLanguage: z.string().min(1),
  limit: z.number().int().min(1).max(25).optional(),
});

inboxCleanupRouter.post('/session/:id/preview-matches', async (req, res) => {
  const userId = getUserId(req);
  const parsed = PreviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  try {
    getSession(req.params.id, userId);
  } catch {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  try {
    // 1. Cache the NL → query derivation so repeated preview calls during
    //    the same edit session are cheap.
    const ruleKey = `${userId}:${ruleHash(parsed.data.naturalLanguage)}`;
    let gmailQuery = queryFromRuleCache.get(ruleKey);
    if (!gmailQuery) {
      gmailQuery = await proposeQueryFromRule({
        naturalLanguage: parsed.data.naturalLanguage,
        model: user?.claudeModel ?? undefined,
      });
      queryFromRuleCache.set(ruleKey, gmailQuery);
    }

    // 2. Cache the Gmail search itself by query hash.
    const searchKey = `${userId}:${queryHash(gmailQuery)}`;
    let hit = previewCache.get(searchKey);
    if (!hit) {
      const search = await searchMatchesForRule(userId, gmailQuery, {
        maxSamples: parsed.data.limit ?? 10,
      });
      hit = { gmailQuery, ...search };
      previewCache.set(searchKey, hit);
    }

    CleanupPreviewSchema.parse(hit);
    res.json(hit);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId }, 'preview-matches failed');
    res.status(500).json({
      error: 'preview_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /session/:id/apply — create the Rule row and optionally apply
 * to inbox / all mail.
 */
const ApplyBody = z.object({
  naturalLanguage: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
  gmailQuery: z.string().min(1),
  scope: CleanupScopeSchema,
});

inboxCleanupRouter.post('/session/:id/apply', async (req, res) => {
  const userId = getUserId(req);
  const parsed = ApplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }
  let state: SessionState;
  try {
    state = getSession(req.params.id, userId);
  } catch {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  // ── Create the persistent Rule row so future mail is auto-classified. ──
  const existingRuleCount = await prisma.rule.count({ where: { userId } });
  const created = await prisma.rule.create({
    data: {
      userId,
      naturalLanguage: parsed.data.naturalLanguage,
      actionsJson: JSON.stringify(parsed.data.actions),
      originalFilterJson: JSON.stringify({
        source: 'inbox-cleanup',
        gmailQuery: parsed.data.gmailQuery,
      }),
      position: existingRuleCount,
      enabled: true,
    },
  });

  let appliedImmediateCount = 0;
  let scheduledCount = 0;
  let failures: Array<{ gmailMessageId: string; error: string }> = [];
  let targetIds: string[] = [];

  if (parsed.data.scope !== 'save-only') {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const timezone = user?.timezone ?? 'UTC';
      const result = await applyRuleToScope({
        userId,
        ruleId: created.id,
        gmailQuery: parsed.data.gmailQuery,
        actions: parsed.data.actions,
        scope: parsed.data.scope,
        timezone,
      });
      appliedImmediateCount = result.appliedImmediateCount;
      scheduledCount = result.scheduledCount;
      failures = result.failures;
      targetIds = result.targetIds;
    } catch (err) {
      if (handleGmailError(err, userId, res)) return;
      logger.error({ err, userId, ruleId: created.id }, 'apply-rule-to-scope failed');
      res.status(500).json({
        error: 'apply_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // ── Coverage: mark every queue message whose id was affected. ──
  const covered = new Set<string>(targetIds);
  const coveredInboxMessageIds: string[] = [];
  for (const mid of state.queue) {
    if (covered.has(mid) && !state.covered.has(mid)) {
      state.covered.add(mid);
      coveredInboxMessageIds.push(mid);
    }
  }

  const summary: AppliedRuleSummary = {
    ruleId: created.id,
    naturalLanguage: parsed.data.naturalLanguage,
    scope: parsed.data.scope,
    appliedImmediateCount,
    scheduledCount,
    coveredInboxMessageIds,
  };
  state.applied.push(summary);

  const result = CleanupApplyResultSchema.parse({
    ruleId: created.id,
    scope: parsed.data.scope,
    appliedImmediateCount,
    scheduledCount,
    coveredInboxMessageIds,
    failures,
  });
  res.json(result);
});

/**
 * POST /session/:id/skip — mark a message as "user chose to skip, move on."
 */
const SkipBody = z.object({ messageId: z.string() });

inboxCleanupRouter.post('/session/:id/skip', async (req, res) => {
  const userId = getUserId(req);
  const parsed = SkipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  let state: SessionState;
  try {
    state = getSession(req.params.id, userId);
  } catch {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  state.covered.add(parsed.data.messageId);
  res.json({ covered: state.covered.size });
});

/**
 * GET /session/:id/summary — "All done" screen data.
 */
inboxCleanupRouter.get('/session/:id/summary', async (req, res) => {
  const userId = getUserId(req);
  let state: SessionState;
  try {
    state = getSession(req.params.id, userId);
  } catch {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  res.json({
    applied: state.applied,
    coveredCount: state.covered.size,
    queueSize: state.queue.length,
    remaining: state.queue.filter((id) => !state.covered.has(id)).length,
  });
});

// ── Small helper ───────────────────────────────────────────────────────────

function safeLabels(labelIdsJson: string): string[] {
  try {
    const parsed = JSON.parse(labelIdsJson);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
