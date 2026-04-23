import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { buildGmailFilterXml } from '../gmail/filter-xml-export.js';
import type { GmailFilter } from '../gmail/filters.js';
import { logger } from '../logger.js';

export const backupsRouter: RouterT = Router();

backupsRouter.use(requireUser);

// ── Full-data export / import (AI rules + Gmail filter mirrors + settings)
//
// This mirrors what scripts/backup.sh writes on disk, so users who want
// GUI-only flows never have to open a terminal. The exported JSON round-
// trips cleanly back in via POST /import — we run it through the same
// zod shape, and upsert by primary key under a transaction.
//
// FilterBackup / /:id/download / /:id/export.xml below are kept for
// back-compat with the old Gmail-filter migration-rollback flow.

const EXPORT_VERSION = 1;

const RuleExportSchema = z.object({
  id: z.string(),
  userId: z.string(),
  naturalLanguage: z.string(),
  actionsJson: z.string(),
  originalFilterJson: z.string().nullable().optional(),
  position: z.number().int(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const GmailFilterExportSchema = z.object({
  id: z.string(),
  userId: z.string(),
  currentGmailId: z.string().nullable().optional(),
  criteriaJson: z.string(),
  actionJson: z.string(),
  labelMap: z.string(),
  naturalLanguage: z.string().nullable().optional(),
  enabled: z.boolean(),
  signature: z.string(),
  syncedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const UserExportSchema = z.object({
  id: z.string(),
  email: z.string(),
  timezone: z.string(),
  status: z.string(),
  pollIntervalSec: z.number().int(),
  claudeModel: z.string().nullable().optional(),
});

const ImportPayloadSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  data: z.object({
    users: z.array(UserExportSchema).optional().default([]),
    rules: z.array(RuleExportSchema),
    gmailFilters: z.array(GmailFilterExportSchema),
  }),
});

const ImportBodySchema = z.object({
  payload: ImportPayloadSchema,
  mode: z.enum(['merge', 'replace']).default('merge'),
});

/**
 * Download every user-editable row as a single JSON document. Excludes
 * inbox cache / classify history / scheduled actions — those are
 * regenerable and would bloat the file. Matches the shape the CLI
 * `scripts/backup.sh` writes under data.db + rules.json + gmail-filters.json.
 */
backupsRouter.get('/export', async (req, res) => {
  const userId = getUserId(req);
  const [user, rules, gmailFilters] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        timezone: true,
        status: true,
        pollIntervalSec: true,
        claudeModel: true,
      },
    }),
    prisma.rule.findMany({ where: { userId }, orderBy: { position: 'asc' } }),
    prisma.gmailFilter.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
  ]);

  const payload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      users: [user],
      rules: rules.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      gmailFilters: gmailFilters.map((g) => ({
        ...g,
        syncedAt: g.syncedAt.toISOString(),
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
      })),
    },
  };

  const filename = `gmail-ai-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(payload, null, 2));
});

/**
 * Restore from an uploaded JSON payload.
 *
 *   mode=merge   — upsert rules + gmailFilters by id, leave other rows alone.
 *   mode=replace — delete all of the current user's rules + gmailFilters,
 *                  then insert the payload's rows. User settings are
 *                  always merged (never deleted) regardless of mode.
 *
 * Every row from the payload is rewritten with the CURRENT session's
 * userId — we never trust a userId from a file a user uploaded,
 * since that would let a bad JSON impersonate someone else in a
 * multi-user install.
 */
backupsRouter.post('/import', async (req, res) => {
  const userId = getUserId(req);
  const parsed = ImportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'bad_payload',
      details: parsed.error.flatten(),
    });
    return;
  }
  const { payload, mode } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      if (mode === 'replace') {
        await tx.gmailFilter.deleteMany({ where: { userId } });
        await tx.rule.deleteMany({ where: { userId } });
      }

      let rulesTouched = 0;
      for (const r of payload.data.rules) {
        await tx.rule.upsert({
          where: { id: r.id },
          create: {
            id: r.id,
            userId, // always the current session's user, never trusted from payload
            naturalLanguage: r.naturalLanguage,
            actionsJson: r.actionsJson,
            originalFilterJson: r.originalFilterJson ?? null,
            position: r.position,
            enabled: r.enabled,
            createdAt: new Date(r.createdAt),
            updatedAt: new Date(r.updatedAt),
          },
          update: {
            userId,
            naturalLanguage: r.naturalLanguage,
            actionsJson: r.actionsJson,
            originalFilterJson: r.originalFilterJson ?? null,
            position: r.position,
            enabled: r.enabled,
            updatedAt: new Date(r.updatedAt),
          },
        });
        rulesTouched++;
      }

      let filtersTouched = 0;
      for (const g of payload.data.gmailFilters) {
        await tx.gmailFilter.upsert({
          where: { id: g.id },
          create: {
            id: g.id,
            userId,
            currentGmailId: g.currentGmailId ?? null,
            criteriaJson: g.criteriaJson,
            actionJson: g.actionJson,
            labelMap: g.labelMap,
            naturalLanguage: g.naturalLanguage ?? null,
            enabled: g.enabled,
            signature: g.signature,
            syncedAt: new Date(g.syncedAt),
            createdAt: new Date(g.createdAt),
            updatedAt: new Date(g.updatedAt),
          },
          update: {
            userId,
            currentGmailId: g.currentGmailId ?? null,
            criteriaJson: g.criteriaJson,
            actionJson: g.actionJson,
            labelMap: g.labelMap,
            naturalLanguage: g.naturalLanguage ?? null,
            enabled: g.enabled,
            signature: g.signature,
            syncedAt: new Date(g.syncedAt),
            updatedAt: new Date(g.updatedAt),
          },
        });
        filtersTouched++;
      }

      // User settings — opt-in merge. We never overwrite email / googleSub
      // (identity) and never delete the row.
      const importedSelf = payload.data.users.find((u) => u.email); // prefer any row
      if (importedSelf) {
        await tx.user.update({
          where: { id: userId },
          data: {
            timezone: importedSelf.timezone,
            pollIntervalSec: importedSelf.pollIntervalSec,
            claudeModel: importedSelf.claudeModel ?? null,
          },
        });
      }

      return { rulesTouched, filtersTouched };
    });

    res.json({
      mode,
      rulesImported: result.rulesTouched,
      gmailFiltersImported: result.filtersTouched,
    });
  } catch (err) {
    logger.error({ err, userId }, 'backup import failed');
    res.status(500).json({
      error: 'import_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

backupsRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const backups = await prisma.filterBackup.findMany({
    where: { userId },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ backups });
});

backupsRouter.get('/:id/download', async (req, res) => {
  const userId = getUserId(req);
  const backup = await prisma.filterBackup.findFirst({
    where: { id: req.params.id, userId },
  });
  if (!backup) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.setHeader(
    'content-disposition',
    `attachment; filename="gmail-filters-backup-${backup.createdAt.toISOString().slice(0, 10)}.json"`,
  );
  res.send(backup.snapshotJson);
});

// Gmail-importable XML — drop this file into Gmail Settings → Filters →
// Import filters to restore the originals. This is what the wizard offers
// as the "undo" path before deleting filters from Gmail.
backupsRouter.get('/:id/export.xml', async (req, res) => {
  const userId = getUserId(req);
  const backup = await prisma.filterBackup.findFirst({
    where: { id: req.params.id, userId },
  });
  if (!backup) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  let parsed: { filters: GmailFilter[]; labelMap: Record<string, string> };
  try {
    parsed = JSON.parse(backup.snapshotJson);
  } catch {
    res.status(500).json({ error: 'backup_parse_failed' });
    return;
  }
  const xml = buildGmailFilterXml(parsed.filters ?? [], parsed.labelMap ?? {});
  res.setHeader('content-type', 'application/xml; charset=utf-8');
  res.setHeader(
    'content-disposition',
    `attachment; filename="mailFilters-${backup.createdAt.toISOString().slice(0, 10)}.xml"`,
  );
  res.send(xml);
});
