import type { gmail_v1 } from 'googleapis';
import { gmailForUser } from './client.js';

export type GmailFilter = gmail_v1.Schema$Filter;

export async function listFilters(userId: string): Promise<GmailFilter[]> {
  const gmail = await gmailForUser(userId);
  const res = await gmail.users.settings.filters.list({ userId: 'me' });
  return res.data.filter ?? [];
}

export async function listLabels(userId: string): Promise<gmail_v1.Schema$Label[]> {
  const gmail = await gmailForUser(userId);
  const res = await gmail.users.labels.list({ userId: 'me' });
  return res.data.labels ?? [];
}

export async function deleteFilter(userId: string, filterId: string): Promise<void> {
  const gmail = await gmailForUser(userId);
  await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });
}
