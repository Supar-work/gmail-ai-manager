import type { Action } from '@gam/shared';
import { prisma } from '../db/client.js';
import { applyAction } from './actions.js';
import { resolveRunAt } from '../time/resolve.js';
import { pMapLimit } from '../util/concurrency.js';
import { logger } from '../logger.js';
import { recordAgentAction } from '../audit/record.js';
import {
  listAllMailIdsForQuery,
  listInboxIdsForQuery,
} from './inbox-rule-search.js';

/**
 * Apply a freshly-created Rule to every message matching its Gmail
 * query, scoped to either the current inbox or all mail.
 *
 *   - Immediate actions run straight through `applyAction`.
 *   - Deferred actions (runAt with any non-immediate kind) become
 *     ScheduledAction rows so the existing scheduler ticks them off.
 *
 * The caller is expected to have already created the Rule row so
 * `ruleId` / `userId` are real foreign keys.
 */

const APPLY_CONCURRENCY = 4;
const MAX_ALL_MAIL = 2000;
const MAX_INBOX = 500;

export type ApplyScope = 'inbox-only' | 'all-mail';

export type ApplyResult = {
  appliedImmediateCount: number;
  scheduledCount: number;
  failures: Array<{ gmailMessageId: string; error: string }>;
  targetIds: string[];
};

export async function applyRuleToScope(params: {
  userId: string;
  ruleId: string;
  gmailQuery: string;
  actions: Action[];
  scope: ApplyScope;
  timezone: string;
}): Promise<ApplyResult> {
  const { userId, ruleId, gmailQuery, actions, scope, timezone } = params;

  const ids =
    scope === 'all-mail'
      ? await listAllMailIdsForQuery(userId, gmailQuery, MAX_ALL_MAIL)
      : await listInboxIdsForQuery(userId, gmailQuery, MAX_INBOX);

  if (ids.length === 0) {
    return {
      appliedImmediateCount: 0,
      scheduledCount: 0,
      failures: [],
      targetIds: [],
    };
  }

  let appliedImmediateCount = 0;
  let scheduledCount = 0;
  const failures: Array<{ gmailMessageId: string; error: string }> = [];

  await pMapLimit(ids, APPLY_CONCURRENCY, async (gmailMessageId) => {
    for (const action of actions) {
      const when = resolveRunAt(action.runAt, { now: new Date(), timezone });

      if (when === 'immediate') {
        try {
          await applyAction(userId, gmailMessageId, action, {
            source: 'cleanup',
            sourceId: ruleId,
            reasoning: 'inbox-cleanup wizard apply',
          });
          appliedImmediateCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push({ gmailMessageId, error: msg });
          logger.warn({ err, userId, gmailMessageId, ruleId }, 'cleanup apply failed');
          // Don't short-circuit other actions for this message — each is
          // independent. But if it's an auth failure Gmail will fail the
          // next one too, so break to avoid hammering.
          if (msg.toLowerCase().includes('invalid_grant') || msg.includes(' 401')) break;
        }
        continue;
      }

      if ('runAtUtc' in when) {
        try {
          const scheduled = await prisma.scheduledAction.create({
            data: {
              userId,
              ruleId,
              gmailMessageId,
              action: JSON.stringify(action),
              runAt: when.runAtUtc,
              status: 'pending',
            },
            select: { id: true },
          });
          // Record the scheduling itself (not the eventual mutation —
          // that's logged by the scheduler when it fires). Reversal of a
          // scheduled-but-not-yet-fired action means cancelling the
          // ScheduledAction row, so reversibleAs is null here; the
          // audit-log UI offers a "Cancel" button for unfired schedules.
          await recordAgentAction({
            userId,
            source: 'cleanup',
            sourceId: ruleId,
            targetType: 'scheduledAction',
            targetId: scheduled.id,
            toolName: 'schedule.add',
            toolInputJson: JSON.stringify({
              gmailMessageId,
              action,
              runAt: when.runAtUtc.toISOString(),
            }),
            reasoning: 'inbox-cleanup wizard scheduled deferred action',
          });
          scheduledCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push({ gmailMessageId, error: msg });
          logger.warn({ err, userId, gmailMessageId, ruleId }, 'cleanup schedule failed');
        }
        continue;
      }

      // unresolved content-derived timing — log + skip.
      logger.warn(
        { gmailMessageId, ruleId, unresolved: when.unresolved },
        'cleanup action with unresolved timing — dropped',
      );
    }
  });

  return {
    appliedImmediateCount,
    scheduledCount,
    failures,
    targetIds: ids,
  };
}
