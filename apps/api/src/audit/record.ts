import type { Action } from '@gam/shared';
import { prisma } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Single source of truth for the agent-action audit log.
 *
 * Every code path that mutates Gmail or persists rules / schedules /
 * other side-effects calls `recordAgentAction(...)` so the user has one
 * place — Settings → Audit log — to see what the system did and undo it
 * when something is wrong.
 *
 * The chat agent (when MCP lands) calls this through the same set of
 * helpers, so chat-driven mutations and rule-driven mutations land in
 * the same table with the same shape.
 */

export type AuditSource =
  | 'rule'         // classify run / per-rule run
  | 'schedule'    // scheduled-action sweeper
  | 'cleanup'     // inbox-cleanup wizard apply
  | 'chat'        // chat agent
  | 'consolidator'; // memory consolidator (rare; usually no Gmail mutation)

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

export async function recordAgentAction(input: RecordInput): Promise<string> {
  try {
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
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    // Audit-log writes must never block a real mutation. Log the failure
    // and return a sentinel so the caller can keep going.
    logger.warn(
      { err, userId: input.userId, toolName: input.toolName, targetId: input.targetId },
      'audit log write failed',
    );
    return '';
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
