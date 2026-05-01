import type { Action } from '@gam/shared';
import { prisma } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Single source of truth for the agent-action audit log.
 *
 * Every code path that mutates Gmail or persists rules / schedules /
 * other side-effects calls into this module so the user has one place —
 * Settings → Audit log — to see what the system did and undo it when
 * something is wrong. Chat-driven mutations (MCP tools) and rule-driven
 * mutations land in the same table with the same shape.
 *
 * Two write modes:
 *   - `recordAgentAction`        one-shot, written as `applied`. Use for
 *                                operations that succeed or throw atomically
 *                                (rules.create, settings updates, etc.).
 *   - `beginAgentAction` →
 *     `completeAgentAction`      pre-write a `pending` row, run the
 *                                external mutation (Gmail), flip to
 *                                `applied`/`failed`. A crash between the
 *                                two leaves a visible `pending` row
 *                                instead of an invisible mutation.
 *
 * Both modes throw on DB failure rather than swallowing — the audit log
 * is the trust mechanism, so a failed write means the caller must abort
 * (or, for `complete*`, surface the inconsistency loudly).
 */

export type AuditSource =
  | 'rule'         // classify run / per-rule run
  | 'schedule'    // scheduled-action sweeper
  | 'cleanup'     // inbox-cleanup wizard apply
  | 'chat'        // chat agent
  | 'consolidator' // memory consolidator (rare; usually no Gmail mutation)
  | 'maintenance'; // rule-maintenance auditor (Settings → Rule maintenance)

export type AuditTargetType =
  | 'gmailMessage'
  | 'gmailLabel'
  | 'rule'
  | 'scheduledAction';

export type RecordInput = {
  userId: string;
  source: AuditSource;
  /** ChatMessage.id / Rule.id / ScheduledAction.id / etc — context-specific. */
  sourceId?: string | null;
  targetType: AuditTargetType;
  targetId: string;
  /** Namespaced tool name: "inbox.apply", "rules.create", "schedule.add", … */
  toolName: string;
  /** Already-serialised tool input. */
  toolInputJson: string;
  /** Optional Gmail-API result blob (e.g. label id returned by labels.create). */
  toolResultJson?: string | null;
  /** Free-form rationale the caller emitted ("classifier matched rule X"). */
  reasoning?: string | null;
  /** When non-null, the inverse Action that would undo this one. The reversal
   *  endpoint will re-apply this Action with source='chat'/sourceId=null. */
  reversibleAs?: Action | null;
};

export type CompleteOutcome = 'applied' | 'failed';

export interface CompleteMeta {
  /** Optional Gmail-API result blob captured after the mutation. */
  toolResultJson?: string | null;
  /** Error captured when outcome === 'failed'. Stringified before storage. */
  error?: unknown;
}

/**
 * Pre-write a "pending" audit row before the underlying mutation runs.
 * Returns the row id. Throws on DB write failure — the caller must NOT
 * proceed with the mutation in that case (an unaudited mutation is the
 * thing this whole log exists to prevent).
 */
export async function beginAgentAction(input: RecordInput): Promise<string> {
  const row = await prisma.agentAction.create({
    data: {
      userId: input.userId,
      source: input.source,
      sourceId: input.sourceId ?? null,
      targetType: input.targetType,
      targetId: input.targetId,
      toolName: input.toolName,
      toolInputJson: input.toolInputJson,
      toolResultJson: input.toolResultJson ?? null,
      reasoning: input.reasoning ?? null,
      reversibleAs: input.reversibleAs ? JSON.stringify(input.reversibleAs) : null,
      status: 'pending',
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Flip a pending row to its terminal state. `applied` sets `appliedAt`
 * to now; `failed` records `errorMessage`. Logs (but does not throw) on
 * DB failure: the underlying mutation already happened, so the system
 * should keep moving and surface the inconsistency in logs/metrics.
 */
export async function completeAgentAction(
  id: string,
  outcome: CompleteOutcome,
  meta: CompleteMeta = {},
): Promise<void> {
  const errorMessage =
    outcome === 'failed' ? stringifyError(meta.error) : null;
  try {
    await prisma.agentAction.update({
      where: { id },
      data: {
        status: outcome,
        appliedAt: outcome === 'applied' ? new Date() : null,
        errorMessage,
        ...(meta.toolResultJson !== undefined
          ? { toolResultJson: meta.toolResultJson }
          : {}),
      },
    });
  } catch (err) {
    logger.error(
      { err, auditId: id, outcome },
      'audit-log complete failed; row stuck as pending',
    );
  }
}

/**
 * One-shot record. The mutation either succeeded (call this after) or
 * failed atomically (do not call). Throws on DB failure.
 *
 * Prefer `beginAgentAction` + `completeAgentAction` whenever the
 * underlying operation can crash mid-flight (Gmail mutation, network
 * call). Use this only when the audit row IS the operation
 * (rules.create, settings update).
 */
export async function recordAgentAction(input: RecordInput): Promise<string> {
  const row = await prisma.agentAction.create({
    data: {
      userId: input.userId,
      source: input.source,
      sourceId: input.sourceId ?? null,
      targetType: input.targetType,
      targetId: input.targetId,
      toolName: input.toolName,
      toolInputJson: input.toolInputJson,
      toolResultJson: input.toolResultJson ?? null,
      reasoning: input.reasoning ?? null,
      reversibleAs: input.reversibleAs ? JSON.stringify(input.reversibleAs) : null,
      status: 'applied',
      appliedAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

function stringifyError(err: unknown): string | null {
  if (err == null) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Build the inverse of a Gmail action when one exists. Used by callers
 * that want to populate `reversibleAs` so the audit-log UI can offer a
 * one-click undo. Returns null for actions whose inverse is undefined,
 * destructive, or unknown.
 *
 *   addLabel(X)        → removeLabel(X)
 *   removeLabel(X)     → addLabel(X)
 *   archive            → addLabel("INBOX")  (un-archive)
 *   markRead           → addLabel("UNREAD") (mark unread again)
 *   star               → removeLabel("STARRED")
 *   markImportant      → removeLabel("IMPORTANT")
 *   forward            → null  (already sent; no clean undo)
 *   trash              → null  (banned; never emitted)
 *
 * The inverse intentionally keeps the same `runAt` shape so a re-applied
 * undo executes immediately by default unless caller overrides.
 */
export function inverseAction(action: Action): Action | null {
  switch (action.type) {
    case 'addLabel':
      return { type: 'removeLabel', labelName: action.labelName };
    case 'removeLabel':
      return { type: 'addLabel', labelName: action.labelName };
    case 'archive':
      return { type: 'addLabel', labelName: 'INBOX' };
    case 'markRead':
      return { type: 'addLabel', labelName: 'UNREAD' };
    case 'star':
      return { type: 'removeLabel', labelName: 'STARRED' };
    case 'markImportant':
      return { type: 'removeLabel', labelName: 'IMPORTANT' };
    case 'forward':
    case 'trash':
      return null;
  }
}
