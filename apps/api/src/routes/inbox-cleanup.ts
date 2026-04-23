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
  reproposeForEditedRule,
  type EmailForProposal,
} from '../claude/inbox-rule-propose.js';
import { searchMatchesForRule } from '../gmail/inbox-rule-search.js';
import { applyRuleToScope } from '../gmail/apply-rule-to-scope.js';
import {
  fetchLabelSamplesForQuery,
  recommendFromSamples,
  type LabelRecommendation,
} from '../gmail/label-recommend.js';
import { migrateLabel } from '../gmail/label-migrate.js';
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

function proposalKey(userId: string, messageId: string, historyId: string | null): string {
  return `${userId}:${messageId}:${historyId ?? 'nh'}`;
}

function ruleHash(naturalLanguage: string): string {
  return createHash('sha256').update(naturalLanguage).digest('hex').slice(0, 16);
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
    // Also seed the preview cache under the initial rule text so edits
    // that revert to the original don't re-hit Claude.
    previewCache.set(`${userId}:${row.gmailMessageId}:${ruleHash(proposal.naturalLanguage)}`, {
      naturalLanguage: proposal.naturalLanguage,
      gmailQuery: proposal.gmailQuery,
      actions: proposal.actions,
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
 * user edits the natural-language rule. Derives a fresh action list +
 * Gmail query from the edited text (with the source email as context)
 * so the wizard's action chips stay in sync with what the rule actually
 * says, not just the match count.
 */
const PreviewBody = z.object({
  naturalLanguage: z.string().min(1),
  messageId: z.string(),
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

  const row = await prisma.inboxMessage.findFirst({
    where: { userId, gmailMessageId: parsed.data.messageId },
  });
  if (!row) {
    res.status(404).json({ error: 'message_not_found' });
    return;
  }

  // Composite cache key: repropose output varies per (message, ruleText)
  // because the email context can tip Claude toward different actions
  // for the same rule wording.
  const cacheKey = `${userId}:${row.gmailMessageId}:${ruleHash(parsed.data.naturalLanguage)}`;
  const cached = previewCache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });

  try {
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

    const reproposed = await reproposeForEditedRule({
      email,
      editedNaturalLanguage: parsed.data.naturalLanguage,
      nowIso: new Date().toISOString(),
      timezone: user?.timezone ?? 'UTC',
      model: user?.claudeModel ?? undefined,
    });

    const search = await searchMatchesForRule(userId, reproposed.gmailQuery, {
      maxSamples: parsed.data.limit ?? 10,
    });

    const preview: CleanupPreview = {
      naturalLanguage: reproposed.naturalLanguage,
      gmailQuery: reproposed.gmailQuery,
      actions: reproposed.actions,
      samples: search.samples,
      totals: search.totals,
    };

    CleanupPreviewSchema.parse(preview);
    previewCache.set(cacheKey, preview);
    res.json(preview);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId }, 'preview-matches failed');
    res.status(500).json({
      error: 'preview_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Label-recommendation for a single inbox-cleanup candidate ────────────
//
// Mirrors GET /api/gmail-filters/:id/label-recommendation but keyed on a
// session+message rather than a filter mirror. Reuses the same
// recommend-from-samples helper so the UX (canonical taxonomy,
// confidence, reasoning, disposition) is identical across the two
// wizards.

const recommendCache = new TtlCache<LabelRecommendation>(TTL_12H);

function labelRecKey(userId: string, messageId: string, historyId: string | null): string {
  return `${userId}:lr:${messageId}:${historyId ?? 'nh'}`;
}

inboxCleanupRouter.get('/session/:id/message/:messageId/label-recommendation', async (req, res) => {
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

  const ck = labelRecKey(userId, row.gmailMessageId, row.historyId);
  const cached = recommendCache.get(ck);
  if (cached) {
    res.json(cached);
    return;
  }

  // Reuse the proposer's samples + its proposed label if available —
  // they were sampled from the same Gmail query we'd search here, so
  // there's no point re-querying. Falls back to a from-the-sender probe
  // if no proposal has been fetched yet (e.g., user skipped ahead).
  const proposalK = proposalKey(userId, row.gmailMessageId, row.historyId);
  const cachedProposal = proposalCache.get(proposalK);

  let samples: Awaited<ReturnType<typeof fetchLabelSamplesForQuery>> = [];
  let currentLabel: string | null = null;
  if (cachedProposal) {
    samples = cachedProposal.samples.map((s) => ({
      from: s.from,
      subject: s.subject,
      snippet: s.snippet,
    }));
    const addLabel = cachedProposal.actions.find((a) => a.type === 'addLabel');
    if (addLabel && addLabel.type === 'addLabel') {
      currentLabel = addLabel.labelName;
    }
  } else if (row.fromHeader) {
    const senderAddress = extractEmailAddress(row.fromHeader) ?? row.fromHeader;
    const q = `from:${JSON.stringify(senderAddress)}`;
    try {
      samples = await fetchLabelSamplesForQuery(userId, q);
    } catch (err) {
      logger.warn({ err, userId }, 'label-rec sample fetch failed');
    }
  }

  try {
    const rec = await recommendFromSamples(samples, { currentLabel });
    recommendCache.set(ck, rec);
    res.json(rec);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId, messageId: row.gmailMessageId }, 'inbox label recommend failed');
    res.status(500).json({
      error: 'recommendation_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// Migrate endpoint matches the shape the LabelRecommendation component
// expects so the frontend stays source-agnostic. In the inbox-cleanup
// context the proposed rule has not yet been applied, so we create the
// Gmail label + move any messages currently carrying the old label —
// exactly what `migrateLabel` does — and the client-side onApplied
// callback takes care of rewriting the proposed NL + re-deriving
// actions. If no Gmail messages currently carry oldLabelName, the
// helper's moved count will be 0, which is fine.
const MigrateBody = z.object({
  newLabelPath: z.string().min(1).max(200),
  oldLabelName: z.string().max(200).nullable().optional(),
});

inboxCleanupRouter.post('/session/:id/message/:messageId/migrate-label', async (req, res) => {
  const userId = getUserId(req);
  const parsed = MigrateBody.safeParse(req.body);
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
  try {
    const result = await migrateLabel(userId, {
      newLabelPath: parsed.data.newLabelPath,
      oldLabelName: parsed.data.oldLabelName ?? null,
    });
    res.json(result);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error(
      { err, userId, messageId: req.params.messageId },
      'inbox-cleanup label migration failed',
    );
    res.status(500).json({
      error: 'migrate_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Apply ────────────────────────────────────────────────────────────────

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

/** Pull the bare address out of a "Display Name <addr@host>" from header. */
function extractEmailAddress(fromHeader: string): string | null {
  const m = /<([^>]+)>/.exec(fromHeader);
  if (m && m[1]) return m[1].trim();
  const bare = fromHeader.trim();
  return /@/.test(bare) ? bare : null;
}
