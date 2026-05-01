import type { Action } from '@gam/shared';
import type { gmail_v1 } from 'googleapis';
import { gmailForUser } from './client.js';
import { logger } from '../logger.js';
import {
  beginAgentAction,
  completeAgentAction,
  inverseAction,
  type AuditSource,
} from '../audit/record.js';
import { isForwardTargetAllowed } from './forward-allowlist.js';

/**
 * Optional audit context the caller passes when applying an action so the
 * audit log can show where the mutation came from. Omitting it skips the
 * log row — useful for tests or admin scripts that shouldn't pollute the
 * user-facing audit trail.
 */
export type ApplyAuditCtx = {
  source: AuditSource;
  /** ChatMessage.id / Rule.id / ScheduledAction.id depending on `source`. */
  sourceId?: string | null;
  /** Free-form rationale ("classifier matched rule cmo7..."). */
  reasoning?: string | null;
};

export async function ensureLabel(userId: string, name: string): Promise<string> {
  const gmail = await gmailForUser(userId);
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const found = existing.data.labels?.find((l) => l.name === name);
  if (found?.id) return found.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  if (!created.data.id) throw new Error('label_create_failed');
  return created.data.id;
}

/**
 * Thrown by `applyAction` when a `forward` action targets an address
 * the user hasn't explicitly verified. The audit row is left in
 * `failed` state and no Gmail mutation runs. Caller should surface this
 * to the user (UI confirmation flow) rather than retrying blindly.
 */
export class ForwardNotAllowedError extends Error {
  constructor(public readonly to: string) {
    super(`forward target not allowed: ${to}`);
    this.name = 'ForwardNotAllowedError';
  }
}

export async function applyAction(
  userId: string,
  gmailMessageId: string,
  action: Action,
  auditCtx?: ApplyAuditCtx,
): Promise<void> {
  const gmail = await gmailForUser(userId);

  if (action.type === 'trash') {
    // Hard safety guard: this app never deletes mail, regardless of what a
    // rule or classifier says. Treat as archive. The prompt + zod schema in
    // the classifier already forbid emitting "trash"; this is defense in
    // depth for legacy/imported actions that still reference the type.
    logger.warn(
      { gmailMessageId, userId },
      'trash action downgraded to archive by safety guard',
    );
    const downgraded: Action = { type: 'archive', runAt: action.runAt };
    const auditId = await beginAuditFor(auditCtx, {
      userId,
      gmailMessageId,
      action: downgraded,
      reasoning: auditCtx?.reasoning ?? 'trash downgraded to archive (policy)',
    });
    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: gmailMessageId,
        requestBody: { removeLabelIds: ['INBOX'] },
      });
      await markApplied(auditId);
    } catch (err) {
      await markFailed(auditId, err);
      throw err;
    }
    return;
  }
  if (action.type === 'forward') {
    // Allowlist gate: refuse `forward` to any address the user hasn't
    // explicitly confirmed. The audit row is still written (as `failed`)
    // so the attempt is visible in Settings → Audit log.
    const allowed = await isForwardTargetAllowed(userId, action.to);
    if (!allowed) {
      const auditId = await beginAuditFor(auditCtx, {
        userId,
        gmailMessageId,
        action,
        reasoning:
          (auditCtx?.reasoning ? `${auditCtx.reasoning}; ` : '') +
          `forward target ${action.to} not in user allowlist`,
      });
      const err = new ForwardNotAllowedError(action.to);
      await markFailed(auditId, err);
      throw err;
    }
    const auditId = await beginAuditFor(auditCtx, {
      userId,
      gmailMessageId,
      action,
    });
    try {
      await forwardMessage(gmail, userId, gmailMessageId, action.to);
      await markApplied(auditId);
    } catch (err) {
      await markFailed(auditId, err);
      throw err;
    }
    return;
  }

  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];
  switch (action.type) {
    case 'archive':
      removeLabelIds.push('INBOX');
      break;
    case 'markRead':
      removeLabelIds.push('UNREAD');
      break;
    case 'star':
      addLabelIds.push('STARRED');
      break;
    case 'markImportant':
      addLabelIds.push('IMPORTANT');
      break;
    case 'addLabel':
      addLabelIds.push(await ensureLabel(userId, action.labelName));
      break;
    case 'removeLabel':
      removeLabelIds.push(await ensureLabel(userId, action.labelName));
      break;
  }

  if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;

  const auditId = await beginAuditFor(auditCtx, {
    userId,
    gmailMessageId,
    action,
  });
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: gmailMessageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
    await markApplied(auditId);
  } catch (err) {
    await markFailed(auditId, err);
    throw err;
  }
}

/**
 * Pre-write a pending audit row, returning its id. When `auditCtx` is
 * undefined (admin scripts, tests) returns null and the apply path skips
 * the audit log entirely.
 */
async function beginAuditFor(
  auditCtx: ApplyAuditCtx | undefined,
  payload: {
    userId: string;
    gmailMessageId: string;
    action: Action;
    reasoning?: string | null;
  },
): Promise<string | null> {
  if (!auditCtx) return null;
  return beginAgentAction({
    userId: payload.userId,
    source: auditCtx.source,
    sourceId: auditCtx.sourceId ?? null,
    targetType: 'gmailMessage',
    targetId: payload.gmailMessageId,
    toolName: `inbox.${payload.action.type}`,
    toolInputJson: JSON.stringify(payload.action),
    reasoning: payload.reasoning ?? auditCtx.reasoning ?? null,
    reversibleAs: inverseAction(payload.action),
  });
}

async function markApplied(auditId: string | null): Promise<void> {
  if (auditId) await completeAgentAction(auditId, 'applied');
}

async function markFailed(auditId: string | null, err: unknown): Promise<void> {
  if (auditId) await completeAgentAction(auditId, 'failed', { error: err });
}

async function forwardMessage(
  gmail: gmail_v1.Gmail,
  _userId: string,
  gmailMessageId: string,
  to: string,
): Promise<void> {
  const original = await gmail.users.messages.get({
    userId: 'me',
    id: gmailMessageId,
    format: 'metadata',
    metadataHeaders: ['Subject', 'From'],
  });
  const headers = original.data.payload?.headers ?? [];
  const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '(no subject)';
  const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';

  const raw = [
    `To: ${to}`,
    `Subject: Fwd: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `Forwarded message originally from ${from}.`,
  ].join('\r\n');

  const encoded = Buffer.from(raw, 'utf8').toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}
