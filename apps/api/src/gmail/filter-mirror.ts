import { createHash } from 'node:crypto';
import type { gmail_v1 } from 'googleapis';
import { prisma } from '../db/client.js';
import { gmailForUser } from './client.js';
import { listFilters, listLabels } from './filters.js';
import { logger } from '../logger.js';

export type Criteria = gmail_v1.Schema$FilterCriteria;
export type FilterAction = gmail_v1.Schema$FilterAction;

export type SyncResult = {
  seen: number;
  created: number;
  updated: number;
  deactivated: number;
};

/**
 * Canonical shape of a filter for hashing. We sort label id arrays so two
 * equivalent filters in Gmail don't create duplicate mirror rows.
 */
export function signatureFor(criteria: Criteria | null | undefined, action: FilterAction | null | undefined): string {
  const c = criteria ?? {};
  const a = action ?? {};
  const canonical = {
    from: c.from ?? null,
    to: c.to ?? null,
    subject: c.subject ?? null,
    query: c.query ?? null,
    negatedQuery: c.negatedQuery ?? null,
    hasAttachment: c.hasAttachment ?? null,
    excludeChats: c.excludeChats ?? null,
    size: c.size ?? null,
    sizeComparison: c.sizeComparison ?? null,
    addLabelIds: [...(a.addLabelIds ?? [])].sort(),
    removeLabelIds: [...(a.removeLabelIds ?? [])].sort(),
    forward: a.forward ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/**
 * Sync the local mirror with Gmail's live filter set.
 *
 * Disabled rows are treated as frozen backups — sync never reads, updates,
 * or removes them. Only the enabled subset is reconciled against Gmail:
 *   - Gmail filter with a signature NOT in the enabled mirror → new row
 *     created with enabled=true.
 *   - Gmail filter matching an existing enabled row → row refreshed.
 *   - Enabled row not present in Gmail anymore → flipped to disabled (kept
 *     as a backup).
 *
 * If the user previously disabled a filter and then re-creates the same
 * criteria manually in Gmail, sync creates a brand-new enabled row — the
 * disabled backup stays untouched. (This is why the unique(userId,signature)
 * constraint was dropped.)
 */
export async function syncGmailFilters(userId: string): Promise<SyncResult> {
  const [filters, labels] = await Promise.all([listFilters(userId), listLabels(userId)]);
  const labelMap: Record<string, string> = {};
  for (const l of labels) if (l.id && l.name) labelMap[l.id] = l.name;

  const enabledMirror = await prisma.gmailFilter.findMany({
    where: { userId, enabled: true },
  });
  const bySig = new Map(enabledMirror.map((r) => [r.signature, r] as const));
  const seenSignatures = new Set<string>();

  let created = 0;
  let updated = 0;

  for (const f of filters) {
    const sig = signatureFor(f.criteria, f.action);
    seenSignatures.add(sig);
    const existing = bySig.get(sig);
    if (existing) {
      await prisma.gmailFilter.update({
        where: { id: existing.id },
        data: {
          currentGmailId: f.id ?? null,
          criteriaJson: JSON.stringify(f.criteria ?? {}),
          actionJson: JSON.stringify(f.action ?? {}),
          labelMap: JSON.stringify(labelMap),
          syncedAt: new Date(),
        },
      });
      updated++;
    } else {
      await prisma.gmailFilter.create({
        data: {
          userId,
          currentGmailId: f.id ?? null,
          criteriaJson: JSON.stringify(f.criteria ?? {}),
          actionJson: JSON.stringify(f.action ?? {}),
          labelMap: JSON.stringify(labelMap),
          enabled: true,
          signature: sig,
          syncedAt: new Date(),
        },
      });
      created++;
    }
  }

  let deactivated = 0;
  for (const r of enabledMirror) {
    if (!seenSignatures.has(r.signature)) {
      await prisma.gmailFilter.update({
        where: { id: r.id },
        data: { enabled: false, currentGmailId: null, syncedAt: new Date() },
      });
      deactivated++;
    }
  }

  return { seen: filters.length, created, updated, deactivated };
}

/**
 * Re-create a stored filter in Gmail. Labels are re-resolved: system labels
 * (INBOX, STARRED…) keep their fixed IDs; user-label names are looked up via
 * the current Gmail labels list, creating any that no longer exist.
 */
export async function enableGmailFilter(
  userId: string,
  mirrorId: string,
): Promise<{ newGmailId: string }> {
  const row = await prisma.gmailFilter.findFirst({ where: { id: mirrorId, userId } });
  if (!row) throw new Error('not_found');

  const criteria = JSON.parse(row.criteriaJson) as Criteria;
  const action = JSON.parse(row.actionJson) as FilterAction;
  const oldLabelMap = JSON.parse(row.labelMap) as Record<string, string>;

  const gmail = await gmailForUser(userId);

  const currentLabels = await listLabels(userId);
  const byName = new Map<string, string>();
  for (const l of currentLabels) if (l.id && l.name) byName.set(l.name, l.id);

  async function resolveLabelIds(ids: string[] | null | undefined): Promise<string[]> {
    if (!ids) return [];
    const out: string[] = [];
    for (const id of ids) {
      // System label IDs (INBOX, STARRED, TRASH, UNREAD, etc.) are stable.
      if (/^[A-Z_]+$/.test(id)) {
        out.push(id);
        continue;
      }
      // Look up original name; find current id by name; create if missing.
      const name = oldLabelMap[id];
      if (!name) {
        logger.warn({ userId, id }, 'label id has no name mapping — skipping');
        continue;
      }
      let resolved = byName.get(name);
      if (!resolved) {
        const created = await gmail.users.labels.create({
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        });
        resolved = created.data.id ?? undefined;
        if (resolved) byName.set(name, resolved);
      }
      if (resolved) out.push(resolved);
    }
    return out;
  }

  const addLabelIds = await resolveLabelIds(action.addLabelIds);
  const removeLabelIds = await resolveLabelIds(action.removeLabelIds);

  const body: gmail_v1.Schema$Filter = {
    criteria,
    action: {
      ...(addLabelIds.length ? { addLabelIds } : {}),
      ...(removeLabelIds.length ? { removeLabelIds } : {}),
      ...(action.forward ? { forward: action.forward } : {}),
    },
  };

  const created = await gmail.users.settings.filters.create({ userId: 'me', requestBody: body });
  const newId = created.data.id;
  if (!newId) throw new Error('gmail_create_returned_no_id');

  // Refresh our label-name map so a later round-trip still resolves correctly.
  const refreshedLabelMap: Record<string, string> = {};
  for (const [name, id] of byName) refreshedLabelMap[id] = name;

  await prisma.gmailFilter.update({
    where: { id: row.id },
    data: {
      currentGmailId: newId,
      enabled: true,
      labelMap: JSON.stringify(refreshedLabelMap),
      syncedAt: new Date(),
    },
  });

  return { newGmailId: newId };
}

/**
 * Remove the filter from Gmail but KEEP the mirror row — the user can
 * re-enable any time.
 */
export async function disableGmailFilter(userId: string, mirrorId: string): Promise<void> {
  const row = await prisma.gmailFilter.findFirst({ where: { id: mirrorId, userId } });
  if (!row) throw new Error('not_found');

  if (row.currentGmailId) {
    const gmail = await gmailForUser(userId);
    try {
      await gmail.users.settings.filters.delete({ userId: 'me', id: row.currentGmailId });
    } catch (err) {
      // 404 → already gone from Gmail; still mark disabled.
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 404) throw err;
    }
  }

  await prisma.gmailFilter.update({
    where: { id: row.id },
    data: { enabled: false, currentGmailId: null, syncedAt: new Date() },
  });
}
