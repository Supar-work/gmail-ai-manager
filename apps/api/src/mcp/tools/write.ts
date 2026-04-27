import { z } from 'zod';
import { ActionSchema } from '@gam/shared';
import { registerTool } from '../stdio-server.js';
import { applyAction } from '../../gmail/actions.js';
import { gmailForUser } from '../../gmail/client.js';
import { recordAgentAction } from '../../audit/record.js';
import { prisma } from '../../db/client.js';
import { logger } from '../../logger.js';

/**
 * Mutating MCP tools — every tool here goes through the audit-log
 * recorder so chat-driven changes show up in Settings → Audit log
 * alongside rule + cleanup mutations.
 *
 * Source convention: chat agent invocations carry `source = "chat"`,
 * with `sourceId` set to the ChatMessage.id so the audit-log row links
 * back to the user's prompt that produced it. The chat agent runner
 * passes ChatMessage.id via the `GAM_CHAT_MESSAGE_ID` env var.
 */

function chatSourceId(): string | null {
  return process.env.GAM_CHAT_MESSAGE_ID ?? null;
}

export function registerInboxWriteTools(): void {
  registerTool({
    name: 'inbox.apply',
    description:
      'Apply a single Action to a Gmail message: add/remove a label, archive (remove INBOX), markRead, star, markImportant, or forward. NEVER allowed to trash. Always logged to the audit trail with a reversible inverse where one exists.',
    inputSchema: z.object({
      messageId: z.string(),
      action: ActionSchema,
      reasoning: z
        .string()
        .optional()
        .describe('Free-form rationale shown in the audit log (e.g. "matches the OTP pattern").'),
    }),
    handler: async ({ messageId, action, reasoning }, { userId }) => {
      if (action.type === 'trash') {
        return {
          ok: false,
          error: 'trash is permanently disallowed; use archive instead',
        };
      }
      try {
        await applyAction(userId, messageId, action, {
          source: 'chat',
          sourceId: chatSourceId(),
          reasoning: reasoning ?? null,
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export function registerRulesWriteTools(): void {
  registerTool({
    name: 'rules.create',
    description:
      'Create a new AI rule the user can later edit / disable. Provide the natural-language description and the action list (zod ActionSchema). Returns the new rule id.',
    inputSchema: z.object({
      naturalLanguage: z.string().min(1),
      actions: z.array(ActionSchema).min(1),
      enabled: z.boolean().optional(),
    }),
    handler: async ({ naturalLanguage, actions, enabled }, { userId }) => {
      const existingCount = await prisma.rule.count({ where: { userId } });
      const created = await prisma.rule.create({
        data: {
          userId,
          naturalLanguage,
          actionsJson: JSON.stringify(actions),
          position: existingCount,
          enabled: enabled ?? true,
        },
      });
      await recordAgentAction({
        userId,
        source: 'chat',
        sourceId: chatSourceId(),
        targetType: 'rule',
        targetId: created.id,
        toolName: 'rules.create',
        toolInputJson: JSON.stringify({ naturalLanguage, actions, enabled }),
      });
      return { id: created.id };
    },
  });
}

export function registerScheduleWriteTools(): void {
  registerTool({
    name: 'schedule.add',
    description:
      'Schedule a single Action to fire at a specific UTC time on a Gmail message. Use for snooze, deferred archive, "do this tomorrow morning". Returns the ScheduledAction id; the existing scheduler picks it up at runAt.',
    inputSchema: z.object({
      messageId: z.string(),
      action: ActionSchema,
      runAtIso: z.string().datetime().describe('ISO-8601 UTC timestamp when the action fires.'),
      ruleId: z
        .string()
        .optional()
        .describe('Optional Rule id to attribute this scheduling to (defaults to chat).'),
    }),
    handler: async ({ messageId, action, runAtIso, ruleId }, { userId }) => {
      // The Rule schema requires a ruleId on ScheduledAction (FK), so chat
      // schedules attach to a synthetic per-user "chat" rule. Create it
      // lazily the first time a chat user schedules something.
      const synthetic = await prisma.rule.upsert({
        where: {
          // Composite uniqueness via originalFilterJson sentinel; not a real
          // unique index, so do find-or-create manually.
          id: ruleId ?? '__nonexistent__',
        },
        update: {},
        create: {
          id: ruleId ?? `chat-${userId}`,
          userId,
          naturalLanguage: '(chat-initiated schedules)',
          actionsJson: '[]',
          originalFilterJson: JSON.stringify({ source: 'chat-synthetic' }),
          position: 0,
          enabled: false, // never auto-runs against incoming mail
        },
      }).catch(async () => {
        // Race or pre-existing — just look it up.
        return prisma.rule.findFirst({ where: { id: ruleId ?? `chat-${userId}` } });
      });
      if (!synthetic) {
        throw new Error('failed to create or find schedule-attribution rule');
      }
      const sched = await prisma.scheduledAction.create({
        data: {
          userId,
          ruleId: synthetic.id,
          gmailMessageId: messageId,
          action: JSON.stringify(action),
          runAt: new Date(runAtIso),
          status: 'pending',
        },
      });
      await recordAgentAction({
        userId,
        source: 'chat',
        sourceId: chatSourceId(),
        targetType: 'scheduledAction',
        targetId: sched.id,
        toolName: 'schedule.add',
        toolInputJson: JSON.stringify({ messageId, action, runAt: runAtIso }),
      });
      return { id: sched.id, runAt: sched.runAt.toISOString() };
    },
  });

  registerTool({
    name: 'schedule.cancel',
    description:
      'Cancel a pending ScheduledAction so it never fires. Use to undo a snooze that the user changed their mind about.',
    inputSchema: z.object({
      scheduledActionId: z.string(),
    }),
    handler: async ({ scheduledActionId }, { userId }) => {
      const row = await prisma.scheduledAction.findFirst({
        where: { id: scheduledActionId, userId },
      });
      if (!row) return { ok: false, error: 'not_found' };
      if (row.status !== 'pending') return { ok: false, error: `already ${row.status}` };
      await prisma.scheduledAction.update({
        where: { id: scheduledActionId },
        data: { status: 'cancelled' },
      });
      await recordAgentAction({
        userId,
        source: 'chat',
        sourceId: chatSourceId(),
        targetType: 'scheduledAction',
        targetId: scheduledActionId,
        toolName: 'schedule.cancel',
        toolInputJson: JSON.stringify({ scheduledActionId }),
      });
      return { ok: true };
    },
  });
}

export function registerDraftsWriteTools(): void {
  registerTool({
    name: 'drafts.create',
    description:
      'Create a Gmail draft (does NOT send). Use to compose a reply or new message; the user reviews + sends from Gmail. `inReplyToMessageId` makes it a reply on the original thread when provided.',
    inputSchema: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      inReplyToMessageId: z.string().optional(),
    }),
    handler: async ({ to, subject, body, inReplyToMessageId }, { userId }) => {
      const gmail = await gmailForUser(userId);

      // RFC2822-ish raw message. Gmail will fix headers up; we keep it
      // minimal so the user can edit in Gmail before sending.
      let threadId: string | undefined;
      const headers = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=UTF-8',
      ];
      if (inReplyToMessageId) {
        try {
          const orig = await gmail.users.messages.get({
            userId: 'me',
            id: inReplyToMessageId,
            format: 'metadata',
            metadataHeaders: ['Message-ID'],
          });
          const msgId = orig.data.payload?.headers?.find(
            (h) => h.name?.toLowerCase() === 'message-id',
          )?.value;
          if (msgId) {
            headers.push(`In-Reply-To: ${msgId}`);
            headers.push(`References: ${msgId}`);
          }
          threadId = orig.data.threadId ?? undefined;
        } catch (err) {
          logger.warn(
            { err, inReplyToMessageId },
            'in-reply-to lookup failed; creating standalone draft',
          );
        }
      }

      const raw = headers.join('\r\n') + '\r\n\r\n' + body;
      const encoded = Buffer.from(raw, 'utf8').toString('base64url');
      const created = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encoded,
            threadId,
          },
        },
      });

      const draftId = created.data.id ?? '';
      const messageId = created.data.message?.id ?? '';

      await recordAgentAction({
        userId,
        source: 'chat',
        sourceId: chatSourceId(),
        targetType: 'gmailMessage',
        targetId: messageId || draftId,
        toolName: 'drafts.create',
        toolInputJson: JSON.stringify({ to, subject, inReplyToMessageId }),
        toolResultJson: JSON.stringify({ draftId, messageId, threadId }),
        // Drafts CAN be reversed by deleting them; we don't auto-undo
        // here because the user typically wants to see the draft first.
      });

      return { draftId, messageId, threadId, openInGmail: 'https://mail.google.com/mail/u/0/#drafts' };
    },
  });
}

export function registerAllWriteTools(): void {
  registerInboxWriteTools();
  registerRulesWriteTools();
  registerScheduleWriteTools();
  registerDraftsWriteTools();
}
