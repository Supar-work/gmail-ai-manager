import type { Action } from '@gam/shared';
import { prisma } from '../db/client.js';
import { applyAction } from '../gmail/actions.js';
import { classifyEmail, type ClassifyEmail, type ClassifyRule } from '../claude/classifier.js';
import { resolveRunAt } from '../time/resolve.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { syncInbox } from '../gmail/sync.js';
import { pMapLimit } from '../util/concurrency.js';
import { recordAgentAction } from '../audit/record.js';

export type ClassifyRunResult = {
  scanned: number;
  matched: number;
  applied: number;
  scheduled: number;
  skippedAlreadySeen: number;
};

export type ClassifyTrigger = 'manual' | 'poll' | 'schedule';

type ProgressSink = {
  event?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  counts?: (c: Partial<ClassifyRunResult>) => void;
  action?: (a: {
    kind: 'applied' | 'scheduled';
    ruleId: string;
    subject: string | null;
    gmailMessageId: string;
    action: Action;
    runAt?: string;
  }) => void;
  /**
   * Returns false when the caller has requested a stop. Pausing blocks this
   * promise until resumed or stopped. Workers call it between messages.
   */
  shouldContinue?: () => Promise<boolean>;
};

// `claude -p` subprocesses can be rate-limited or resource-heavy; keep a
// conservative default and let ops tune by env later if needed.
const CLASSIFY_CONCURRENCY = 3;

/**
 * Sync-then-classify pipeline:
 *   1. syncInbox() — pull current Gmail inbox into local cache (InboxMessage).
 *      Runs by default for manual and poll triggers so classification always
 *      sees fresh state.
 *   2. Read candidate messages from the local cache (fast, no Gmail fetch).
 *   3. Run `claude -p` classification in parallel (bounded) and apply/schedule
 *      actions per message.
 *
 * Actions still mutate Gmail (labels, archive, trash, forward). The next sync
 * pulls those state changes back into the cache automatically.
 */
export async function classifyRecent(
  userId: string,
  opts: {
    maxMessages?: number;
    trigger?: ClassifyTrigger;
    ids?: string[];
    ruleIds?: string[];
    syncFirst?: boolean;
    /**
     * When true (default for full runs), a cached EmailDecision is reused
     * if the message's historyId hasn't changed and no rule has been edited
     * since classification. When false (per-rule runs), always re-classify.
     */
    useCache?: boolean;
    sink?: ProgressSink;
  } = {},
): Promise<ClassifyRunResult> {
  const trigger: ClassifyTrigger = opts.trigger ?? 'manual';
  const syncFirst = opts.syncFirst ?? true;
  // Per-rule runs default to bypassing cache (user is iterating on rule text).
  const useCache = opts.useCache ?? !(opts.ruleIds && opts.ruleIds.length > 0);
  const emit = (msg: string, level: 'info' | 'warn' | 'error' = 'info') =>
    opts.sink?.event?.(msg, level);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, timezone: true, claudeModel: true, learnedMemoryAt: true },
  });
  if (!user) throw new Error('no_user');

  const enabledRules = await prisma.rule.findMany({
    where: {
      userId,
      enabled: true,
      ...(opts.ruleIds && opts.ruleIds.length > 0 ? { id: { in: opts.ruleIds } } : {}),
    },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });

  if (enabledRules.length === 0) {
    emit('No enabled rules to run.', 'warn');
    return { scanned: 0, matched: 0, applied: 0, scheduled: 0, skippedAlreadySeen: 0 };
  }

  emit(
    opts.ruleIds && opts.ruleIds.length > 0
      ? `Running ${enabledRules.length} selected rule${enabledRules.length === 1 ? '' : 's'}.`
      : `Running all ${enabledRules.length} enabled rule${enabledRules.length === 1 ? '' : 's'}.`,
  );

  // Rule is just NL now — the classifier figures out the action plan from the
  // text + email at evaluation time. Structured `actionsJson` on the row is
  // legacy (populated only by Gmail filter import) and no longer consulted.
  const ruleList: ClassifyRule[] = enabledRules.map((r) => ({
    id: r.id,
    naturalLanguage: r.naturalLanguage,
  }));

  if (syncFirst) {
    await syncInbox(userId, { sink: { event: emit } });
  }

  // Pick the target messages. An explicit id list (from the poller) runs
  // exactly those. Otherwise default to "all cached inbox messages" — the
  // cache skip keeps runs cheap after the first pass.
  const maxMessages = opts.maxMessages;

  type InboxRow = NonNullable<Awaited<ReturnType<typeof prisma.inboxMessage.findFirst>>>;
  let candidates: InboxRow[];
  if (opts.ids && opts.ids.length > 0) {
    const rows = await prisma.inboxMessage.findMany({
      where: { userId, gmailMessageId: { in: opts.ids } },
    });
    const byId = new Map(rows.map((r) => [r.gmailMessageId, r] as const));
    candidates = opts.ids
      .map((id) => byId.get(id) ?? null)
      .filter((r): r is InboxRow => r != null);
  } else {
    candidates = await prisma.inboxMessage.findMany({
      where: { userId },
      orderBy: { internalDate: 'desc' },
      ...(maxMessages != null ? { take: maxMessages } : {}),
    });
  }

  if (candidates.length === 0) {
    emit('No messages in the local inbox cache.', 'warn');
    return { scanned: 0, matched: 0, applied: 0, scheduled: 0, skippedAlreadySeen: 0 };
  }

  // ── cache-hit pre-filter ─────────────────────────────────────────────
  // Pull every stored decision for the candidates in one go. A decision
  // is still valid iff:
  //   decision.contentHistoryId === message.historyId   // message unchanged
  //   decision.updatedAt >= ruleSetUpdatedAt            // no rule edited since
  //   decision.updatedAt >= learnedMemoryAt             // memory not refreshed since
  // The learnedMemory check matters because the consolidator updates
  // learnedMemory in the background and that changes how the proposer
  // would interpret the same email — without this gate, rule meaning
  // drifts silently against cached decisions.
  const ruleSetUpdatedAt = Math.max(
    enabledRules.reduce<number>((max, r) => Math.max(max, r.updatedAt.getTime()), 0),
    user.learnedMemoryAt?.getTime() ?? 0,
  );
  const cachedDecisions = useCache
    ? await prisma.emailDecision.findMany({
        where: {
          userId,
          gmailMessageId: { in: candidates.map((c) => c.gmailMessageId) },
        },
        select: { gmailMessageId: true, contentHistoryId: true, updatedAt: true },
      })
    : [];
  const decisionByMessage = new Map(cachedDecisions.map((d) => [d.gmailMessageId, d] as const));
  const isCacheHit = (row: InboxRow): boolean => {
    if (!useCache) return false;
    const d = decisionByMessage.get(row.gmailMessageId);
    if (!d || !d.contentHistoryId) return false;
    if (d.contentHistoryId !== row.historyId) return false;
    if (d.updatedAt.getTime() < ruleSetUpdatedAt) return false;
    return true;
  };

  emit(
    `Classifying ${candidates.length} message${candidates.length === 1 ? '' : 's'} with concurrency ${CLASSIFY_CONCURRENCY}${useCache ? ' (cache on)' : ' (cache bypassed)'}…`,
  );

  let matched = 0;
  let applied = 0;
  let scheduled = 0;
  let skippedAlreadySeen = 0;
  let completed = 0;

  let stopped = false;
  await pMapLimit(
    candidates,
    CLASSIFY_CONCURRENCY,
    async (row, idx) => {
      if (!row || stopped) return;

      // Pause/stop gate — blocks while paused, returns false on stop.
      if (opts.sink?.shouldContinue) {
        const go = await opts.sink.shouldContinue();
        if (!go) {
          stopped = true;
          return;
        }
      }

    if (isCacheHit(row)) {
      skippedAlreadySeen++;
      completed++;
      if (completed <= 20 || completed % 25 === 0) {
        emit(
          `[${idx + 1}/${candidates.length}] cached: ${row.subject?.slice(0, 60) ?? row.gmailMessageId.slice(0, 10)}`,
        );
      }
      opts.sink?.counts?.({ skippedAlreadySeen, scanned: completed });
      return;
    }

    const subject = row.subject ? `"${row.subject.slice(0, 60)}"` : `(no subject)`;
    emit(`[${idx + 1}/${candidates.length}] ${subject}`);
    const now = new Date();

    const email = rowToClassifyEmail(row);
    let result;
    try {
      result = await classifyEmail({
        now: now.toISOString(),
        timezone: user.timezone,
        rules: ruleList,
        email,
        ...(user.claudeModel ? { model: user.claudeModel } : {}),
      });
    } catch (err) {
      emit(`     classify failed: ${String(err).slice(0, 160)}`, 'error');
      completed++;
      opts.sink?.counts?.({ scanned: completed });
      return;
    }

    const actionsApplied: Array<{ ruleId: string; action: Action; at: string }> = [];
    const actionsScheduled: Array<{ ruleId: string; action: Action; runAt: string; scheduledId: string }> = [];
    const reasoning: Array<{ ruleId: string; reasoning: string }> = [];

    if (result.matches.length === 0) {
      emit(`     → no match`);
    }

    for (const match of result.matches) {
      const rule = enabledRules.find((r) => r.id === match.ruleId);
      if (!rule) continue;
      reasoning.push({ ruleId: rule.id, reasoning: match.reasoning });
      matched++;
      emit(`     → matched: ${rule.naturalLanguage.slice(0, 80)}`);

      for (const a of match.actions) {
        const action = normalizeAction(a);
        if (!action) continue;

        // Timing comes entirely from the classifier's resolvedRunAtIso; it
        // parses the rule text + email body and returns a concrete UTC ISO
        // (or null for immediate).
        const runAt = a.resolvedRunAtIso
          ? ({ kind: 'atTime', iso: a.resolvedRunAtIso } as const)
          : undefined;

        const resolved = resolveRunAt(runAt, { now, timezone: user.timezone });
        if (resolved === 'immediate') {
          try {
            await applyAction(userId, row.gmailMessageId, action, {
              source: 'rule',
              sourceId: rule.id,
              reasoning: match.reasoning,
            });
            actionsApplied.push({
              ruleId: rule.id,
              action,
              at: new Date().toISOString(),
            });
            applied++;
            emit(`        applied ${action.type}`);
            opts.sink?.action?.({
              kind: 'applied',
              ruleId: rule.id,
              subject: row.subject,
              gmailMessageId: row.gmailMessageId,
              action,
            });
          } catch (err) {
            emit(`        apply ${action.type} failed: ${String(err).slice(0, 120)}`, 'error');
            logger.error({ err, userId, ruleId: rule.id, gmailMessageId: row.gmailMessageId }, 'apply action failed');
          }
        } else if ('runAtUtc' in resolved) {
          const sched = await prisma.scheduledAction.create({
            data: {
              userId,
              ruleId: rule.id,
              gmailMessageId: row.gmailMessageId,
              action: JSON.stringify(action),
              runAt: resolved.runAtUtc,
              reasoning: match.reasoning,
            },
          });
          // Audit the scheduling itself; the actual mutation gets its
          // own row when the scheduler fires.
          await recordAgentAction({
            userId,
            source: 'rule',
            sourceId: rule.id,
            targetType: 'scheduledAction',
            targetId: sched.id,
            toolName: 'schedule.add',
            toolInputJson: JSON.stringify({
              gmailMessageId: row.gmailMessageId,
              action,
              runAt: resolved.runAtUtc.toISOString(),
            }),
            reasoning: match.reasoning,
          });
          actionsScheduled.push({
            ruleId: rule.id,
            action,
            runAt: resolved.runAtUtc.toISOString(),
            scheduledId: sched.id,
          });
          scheduled++;
          emit(`        scheduled ${action.type} for ${resolved.runAtUtc.toISOString()}`);
          opts.sink?.action?.({
            kind: 'scheduled',
            ruleId: rule.id,
            subject: row.subject,
            gmailMessageId: row.gmailMessageId,
            action,
            runAt: resolved.runAtUtc.toISOString(),
          });
        } else {
          emit(`        could not resolve timing`, 'warn');
        }
      }
    }

    const decisionData = {
      userId,
      gmailMessageId: row.gmailMessageId,
      matchedRuleIds: JSON.stringify(result.matches.map((m) => m.ruleId)),
      reasoning: JSON.stringify(reasoning),
      actionsApplied: JSON.stringify(actionsApplied),
      actionsScheduled: JSON.stringify(actionsScheduled),
      modelVersion: user.claudeModel || env.CLAUDE_MODEL || 'claude-default',
      contentHistoryId: row.historyId ?? null,
    };
    await prisma.emailDecision.upsert({
      where: { userId_gmailMessageId: { userId, gmailMessageId: row.gmailMessageId } },
      create: decisionData,
      update: {
        matchedRuleIds: decisionData.matchedRuleIds,
        reasoning: decisionData.reasoning,
        actionsApplied: decisionData.actionsApplied,
        actionsScheduled: decisionData.actionsScheduled,
        modelVersion: decisionData.modelVersion,
        contentHistoryId: decisionData.contentHistoryId,
      },
    });

    completed++;
    opts.sink?.counts?.({
      scanned: completed,
      matched,
      applied,
      scheduled,
      skippedAlreadySeen,
    });
  },
    { shouldContinue: () => !stopped },
  );

  const classifiedThisRun = completed - skippedAlreadySeen;
  if (stopped) {
    emit(
      `Stopped. processed=${completed}/${candidates.length} classified=${classifiedThisRun} cached=${skippedAlreadySeen} matched=${matched} applied=${applied} scheduled=${scheduled}.`,
      'warn',
    );
  } else {
    emit(
      `Done. scanned=${completed} classified=${classifiedThisRun} cached=${skippedAlreadySeen} matched=${matched} applied=${applied} scheduled=${scheduled}.`,
    );
  }

  return {
    scanned: completed,
    matched,
    applied,
    scheduled,
    skippedAlreadySeen,
  };
}

function normalizeAction(a: {
  type: string;
  labelName?: string | null;
  to?: string | null;
}): Action | null {
  switch (a.type) {
    case 'addLabel':
      return a.labelName ? { type: 'addLabel', labelName: a.labelName } : null;
    case 'removeLabel':
      return a.labelName ? { type: 'removeLabel', labelName: a.labelName } : null;
    case 'archive':
    case 'markRead':
    case 'star':
    case 'markImportant':
    case 'trash':
      return { type: a.type };
    case 'forward':
      return a.to ? { type: 'forward', to: a.to } : null;
    default:
      return null;
  }
}

type InboxRow = NonNullable<Awaited<ReturnType<typeof prisma.inboxMessage.findFirst>>>;

function rowToClassifyEmail(row: InboxRow): ClassifyEmail {
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(row.labelIds);
    if (Array.isArray(parsed)) labels = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* empty */
  }
  return {
    id: row.gmailMessageId,
    from: row.fromHeader,
    to: row.toHeader,
    subject: row.subject,
    snippet: row.snippet,
    date: row.dateHeader,
    labels,
    body: row.bodyText,
  };
}
