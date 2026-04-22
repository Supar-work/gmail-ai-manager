import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { ActionSchema } from '@gaf/shared';
import { requireUser, getUserId } from '../auth/middleware.js';
import { deleteFilter, listFilters, listLabels, type GmailFilter } from '../gmail/filters.js';
import { GoogleTokenError, isInvalidGrant, markNeedsReauth } from '../gmail/client.js';
import { logger } from '../logger.js';
import { prisma } from '../db/client.js';
import { translateFilters } from '../claude/translator.js';

export const filtersRouter: RouterT = Router();

filtersRouter.use(requireUser);

async function fetchFiltersAndLabels(userId: string) {
  const [filters, labels] = await Promise.all([listFilters(userId), listLabels(userId)]);
  const labelMap: Record<string, string> = {};
  for (const l of labels) {
    if (l.id && l.name) labelMap[l.id] = l.name;
  }
  return { filters, labelMap };
}

function handleGmailError(err: unknown, userId: string, res: import('express').Response) {
  if (err instanceof GoogleTokenError || isInvalidGrant(err)) {
    void markNeedsReauth(userId);
    res.status(401).json({ error: 'needs_reauth' });
    return true;
  }
  return false;
}

filtersRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { filters, labelMap } = await fetchFiltersAndLabels(userId);
    res.json({ filters, labelMap });
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId }, 'failed to list filters');
    res.status(500).json({ error: 'gmail_failed' });
  }
});

// Step 1 — snapshot the current Gmail filter set into a FilterBackup row.
// The backup stores both the JSON filters and the resolved label-id map so
// the XML export (/api/backups/:id/export.xml) can round-trip cleanly.
filtersRouter.post('/backup', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { filters, labelMap } = await fetchFiltersAndLabels(userId);
    if (filters.length === 0) {
      res.status(400).json({ error: 'no_filters_to_backup' });
      return;
    }
    const backup = await prisma.filterBackup.create({
      data: {
        userId,
        snapshotJson: JSON.stringify({
          filters,
          labelMap,
          exportedAt: new Date().toISOString(),
        }),
      },
    });
    res.json({
      backupId: backup.id,
      filterIds: filters.map((f) => f.id!).filter(Boolean),
      filterCount: filters.length,
    });
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId }, 'failed to back up filters');
    res.status(500).json({ error: 'backup_failed' });
  }
});

// Preview translation without mutating anything — used by the wizard's
// step 2 to show Claude's translations for review before they become rules.
filtersRouter.post('/translate', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { filters, labelMap } = await fetchFiltersAndLabels(userId);
    if (filters.length === 0) {
      res.json({ previews: [], translated: false });
      return;
    }
    const previews = await translateFilters(filters, labelMap);
    res.json({ previews, translated: true });
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId }, 'failed to translate filters');
    res.status(500).json({ error: 'translate_failed' });
  }
});

// Step 2 — materialise the reviewed translations as Rule rows. At this point
// Gmail filters are still active; the user can opt out of the delete step.
const CreateRulesBodySchema = z.object({
  rules: z
    .array(
      z.object({
        filterId: z.string(),
        naturalLanguage: z.string().min(1),
        actions: z.array(ActionSchema).min(1),
      }),
    )
    .min(1),
});

filtersRouter.post('/create-rules', async (req, res) => {
  const userId = getUserId(req);
  const parsed = CreateRulesBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }

  try {
    const { filters } = await fetchFiltersAndLabels(userId);
    const byId = new Map(filters.map((f) => [f.id!, f] as const));
    const selected = parsed.data.rules
      .map((r) => ({ ...r, filter: byId.get(r.filterId) }))
      .filter((v): v is typeof v & { filter: GmailFilter } => v.filter != null);

    if (selected.length === 0) {
      res.status(400).json({ error: 'no_matching_filters' });
      return;
    }

    const existing = await prisma.rule.count({ where: { userId } });
    const ruleIds: string[] = [];
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < selected.length; i++) {
        const s = selected[i]!;
        const rule = await tx.rule.create({
          data: {
            userId,
            naturalLanguage: s.naturalLanguage,
            actionsJson: JSON.stringify(s.actions),
            originalFilterJson: JSON.stringify(s.filter),
            position: existing + i,
            enabled: true,
          },
        });
        ruleIds.push(rule.id);
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { migratedAt: new Date() },
    });

    res.json({ ruleIds });
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId }, 'failed to create rules');
    res.status(500).json({ error: 'create_rules_failed' });
  }
});

// Step 3 — optional cleanup. Deletes the original filters from Gmail so the
// local rules are the only thing acting on incoming mail.
const DeleteBodySchema = z.object({
  filterIds: z.array(z.string()).min(1),
});

filtersRouter.post('/delete-from-gmail', async (req, res) => {
  const userId = getUserId(req);
  const parsed = DeleteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }

  const deletionErrors: Array<{ filterId: string; error: string }> = [];
  let deleted = 0;
  for (const id of parsed.data.filterIds) {
    try {
      await deleteFilter(userId, id);
      deleted++;
    } catch (err) {
      if (handleGmailError(err, userId, res)) return;
      logger.warn({ err, userId, filterId: id }, 'failed to delete gmail filter');
      deletionErrors.push({ filterId: id, error: String(err) });
    }
  }
  res.json({ deleted, deletionErrors });
});

export type { GmailFilter };
