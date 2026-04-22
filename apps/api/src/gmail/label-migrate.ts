import type { gmail_v1 } from 'googleapis';
import { gmailForUser } from './client.js';
import { listLabels } from './filters.js';
import { logger } from '../logger.js';

const BATCH_MODIFY_LIMIT = 500;

export type MigrateResult = {
  labelId: string;
  moved: number;
  errors: string[];
};

/**
 * Create the target label (if missing) and move every message currently
 * carrying the old label to the new one. Supports nested label paths like
 * `Marketing/Nike` — Gmail auto-creates parents.
 *
 * If `oldLabelName` is not provided, we only ensure the new label exists
 * without moving anything.
 */
export async function migrateLabel(
  userId: string,
  params: { newLabelPath: string; oldLabelName?: string | null },
): Promise<MigrateResult> {
  const gmail = await gmailForUser(userId);

  const newLabelId = await ensureLabelPath(gmail, params.newLabelPath);
  if (!params.oldLabelName || params.oldLabelName === params.newLabelPath) {
    return { labelId: newLabelId, moved: 0, errors: [] };
  }

  const labels = await listLabels(userId);
  const oldLabel = labels.find((l) => l.name === params.oldLabelName);
  if (!oldLabel?.id) {
    // Nothing to migrate from.
    return { labelId: newLabelId, moved: 0, errors: [] };
  }
  const oldLabelId = oldLabel.id;

  let moved = 0;
  const errors: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `label:${JSON.stringify(params.oldLabelName)}`,
      maxResults: BATCH_MODIFY_LIMIT,
      pageToken,
    });
    const ids = (res.data.messages ?? []).map((m) => m.id).filter((x): x is string => !!x);
    if (ids.length > 0) {
      try {
        await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids,
            addLabelIds: [newLabelId],
            removeLabelIds: [oldLabelId],
          },
        });
        moved += ids.length;
      } catch (err) {
        logger.error({ err, userId }, 'batchModify failed during label migration');
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { labelId: newLabelId, moved, errors };
}

async function ensureLabelPath(gmail: gmail_v1.Gmail, path: string): Promise<string> {
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const byName = new Map<string, string>();
  for (const l of existing.data.labels ?? []) {
    if (l.name && l.id) byName.set(l.name, l.id);
  }
  const already = byName.get(path);
  if (already) return already;
  // Gmail accepts nested names directly (Parent/Child); it creates missing
  // parents automatically. Use labelShow / show so the path is visible in
  // the sidebar and the message list.
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: path,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  if (!created.data.id) throw new Error('label_create_no_id');
  return created.data.id;
}
