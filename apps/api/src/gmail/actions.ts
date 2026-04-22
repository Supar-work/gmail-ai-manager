import type { Action } from '@gaf/shared';
import type { gmail_v1 } from 'googleapis';
import { gmailForUser } from './client.js';
import { logger } from '../logger.js';

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

export async function applyAction(
  userId: string,
  gmailMessageId: string,
  action: Action,
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
    await gmail.users.messages.modify({
      userId: 'me',
      id: gmailMessageId,
      requestBody: { removeLabelIds: ['INBOX'] },
    });
    return;
  }
  if (action.type === 'forward') {
    await forwardMessage(gmail, userId, gmailMessageId, action.to);
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
      addLabelIds.push(); // no-op
      removeLabelIds.push(await ensureLabel(userId, action.labelName));
      break;
  }

  if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;

  await gmail.users.messages.modify({
    userId: 'me',
    id: gmailMessageId,
    requestBody: { addLabelIds, removeLabelIds },
  });
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
