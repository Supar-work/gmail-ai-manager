import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { ActionSchema } from '@gam/shared';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import {
  disableGmailFilter,
  enableGmailFilter,
  syncGmailFilters,
} from '../gmail/filter-mirror.js';
import { GoogleTokenError, isInvalidGrant, markNeedsReauth } from '../gmail/client.js';
import type { Action } from '@gam/shared';
import type { GmailFilter } from '../gmail/filters.js';
import { translateFilters } from '../claude/translator.js';
import {
  recommendCanonicalLabel,
  type LabelRecommendation,
} from '../gmail/label-recommend.js';
import { migrateLabel } from '../gmail/label-migrate.js';
import { CANONICAL_LABELS } from '../canonical-labels.js';
import { TtlCache } from '../util/ttl-cache.js';
import { logger } from '../logger.js';
import { safeJson } from '../util/safe-json.js';
import { handleGmailError } from '../gmail/error.js';

// 12-hour caches so repeating the wizard for the same inbox doesn't re-spawn
// Claude for every row. Keys are `${userId}:${mirrorId}:${signature}` — the
// signature bits invalidate when the underlying Gmail filter changes.
const TTL_12H = 12 * 60 * 60 * 1000;
type CachedTranslation = { naturalLanguage: string; actions: Action[] };
const translateCache = new TtlCache<CachedTranslation>(TTL_12H);
const recommendCache = new TtlCache<LabelRecommendation>(TTL_12H);

function cacheKey(userId: string, mirrorId: string, signature: string): string {
  return `${userId}:${mirrorId}:${signature}`;
}

export const gmailFiltersRouter: RouterT = Router();

gmailFiltersRouter.use(requireUser);

function hydrate(row: {
  id: string;
  currentGmailId: string | null;
  criteriaJson: string;
  actionJson: string;
  labelMap: string;
  naturalLanguage: string | null;
  enabled: boolean;
  signature: string;
  syncedAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    currentGmailId: row.currentGmailId,
    criteria: safeJson<Record<string, unknown>>(row.criteriaJson, {}),
    action: safeJson<Record<string, unknown>>(row.actionJson, {}),
    labelMap: safeJson<Record<string, string>>(row.labelMap, {}),
    naturalLanguage: row.naturalLanguage,
    enabled: row.enabled,
    signature: row.signature,
    syncedAt: row.syncedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

gmailFiltersRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const rows = await prisma.gmailFilter.findMany({
    where: { userId },
    orderBy: [{ enabled: 'desc' }, { updatedAt: 'desc' }],
  });
  res.json({ filters: rows.map(hydrate) });
});

gmailFiltersRouter.post('/sync', async (req, res) => {
  const userId = getUserId(req);
  try {
    const summary = await syncGmailFilters(userId);
    res.json(summary);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId }, 'gmail filter sync failed');
    res.status(500).json({ error: 'sync_failed', message: err instanceof Error ? err.message : String(err) });
  }
});

gmailFiltersRouter.post('/:id/enable', async (req, res) => {
  const userId = getUserId(req);
  try {
    const result = await enableGmailFilter(userId, req.params.id);
    res.json(result);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    if (err instanceof Error && err.message === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    logger.error({ err, userId, id: req.params.id }, 'gmail filter enable failed');
    res.status(500).json({ error: 'enable_failed', message: err instanceof Error ? err.message : String(err) });
  }
});

// ── translate to AI rule(s) ────────────────────────────────────────────
//
// Two endpoints power the translate-wizard UX:
//   POST /translate    → claude-powered preview for N mirror rows
//   POST /materialize  → commit previews as Rule rows; optionally disable
//                         the source Gmail filters at the same time.

const TranslateBody = z.object({ mirrorIds: z.array(z.string()).min(1).max(200) });

gmailFiltersRouter.post('/translate', async (req, res) => {
  const userId = getUserId(req);
  const parsed = TranslateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  const rows = await prisma.gmailFilter.findMany({
    where: { id: { in: parsed.data.mirrorIds }, userId },
  });
  if (rows.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Merge label maps from all selected rows so the translator can resolve
  // any label id referenced in the criteria/action.
  const labelMap: Record<string, string> = {};
  for (const r of rows) {
    try {
      const m = JSON.parse(r.labelMap) as Record<string, string>;
      Object.assign(labelMap, m);
    } catch {
      /* ignore malformed */
    }
  }

  // Split rows into cache-hits (return immediately) and misses (send to Claude).
  const hits = new Map<string, CachedTranslation>();
  const misses: typeof rows = [];
  for (const r of rows) {
    const cached = translateCache.get(cacheKey(userId, r.id, r.signature));
    if (cached) hits.set(r.id, cached);
    else misses.push(r);
  }

  const fakeFilters: GmailFilter[] = misses.map((r) => ({
    id: r.id,
    criteria: safeJson(r.criteriaJson, {}),
    action: safeJson(r.actionJson, {}),
  }));

  try {
    const translations = misses.length > 0 ? await translateFilters(fakeFilters, labelMap) : [];
    const byId = new Map(translations.map((t) => [t.id, t] as const));
    for (const r of misses) {
      const t = byId.get(r.id);
      if (t) {
        const entry: CachedTranslation = {
          naturalLanguage: t.naturalLanguage,
          actions: t.actions,
        };
        translateCache.set(cacheKey(userId, r.id, r.signature), entry);
      }
    }
    const previews = rows.map((r) => {
      const fromCache = hits.get(r.id);
      if (fromCache) return { mirrorId: r.id, ...fromCache };
      const t = byId.get(r.id);
      return {
        mirrorId: r.id,
        naturalLanguage: t?.naturalLanguage ?? '',
        actions: t?.actions ?? [],
      };
    });
    res.json({
      previews,
      cached: hits.size,
      translated: misses.length,
    });
  } catch (err) {
    logger.error({ err, userId }, 'translate mirror rows failed');
    res.status(500).json({
      error: 'translate_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

const MaterializeBody = z.object({
  items: z
    .array(
      z.object({
        mirrorId: z.string(),
        naturalLanguage: z.string().min(1),
        actions: z.array(ActionSchema).optional(),
      }),
    )
    .min(1),
  disableSources: z.boolean().default(false),
});

gmailFiltersRouter.post('/materialize', async (req, res) => {
  const userId = getUserId(req);
  const parsed = MaterializeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }

  const ids = parsed.data.items.map((i) => i.mirrorId);
  const rows = await prisma.gmailFilter.findMany({
    where: { id: { in: ids }, userId },
  });
  const rowById = new Map(rows.map((r) => [r.id, r] as const));

  const ruleIds: string[] = [];
  const existingRuleCount = await prisma.rule.count({ where: { userId } });

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < parsed.data.items.length; i++) {
      const item = parsed.data.items[i]!;
      const sourceRow = rowById.get(item.mirrorId);
      if (!sourceRow) continue;
      const created = await tx.rule.create({
        data: {
          userId,
          naturalLanguage: item.naturalLanguage,
          actionsJson: JSON.stringify(item.actions ?? []),
          originalFilterJson: JSON.stringify({
            mirrorId: item.mirrorId,
            criteria: safeJson(sourceRow.criteriaJson, {}),
            action: safeJson(sourceRow.actionJson, {}),
          }),
          position: existingRuleCount + i,
          enabled: true,
        },
      });
      ruleIds.push(created.id);
    }
  });

  let disabledCount = 0;
  const disableErrors: Array<{ mirrorId: string; error: string }> = [];
  if (parsed.data.disableSources) {
    for (const item of parsed.data.items) {
      try {
        await disableGmailFilter(userId, item.mirrorId);
        disabledCount++;
      } catch (err) {
        if (err instanceof GoogleTokenError || isInvalidGrant(err)) {
          void markNeedsReauth(userId);
          break;
        }
        logger.warn({ err, userId, mirrorId: item.mirrorId }, 'disable during materialize failed');
        disableErrors.push({
          mirrorId: item.mirrorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // First-run marker so the landing page stops nagging.
  await prisma.user.update({
    where: { id: userId },
    data: { migratedAt: new Date() },
  });

  res.json({ ruleIds, disabledCount, disableErrors });
});

// Exposed for the wizard UI so it knows the full slug list + display info.
gmailFiltersRouter.get('/taxonomy', (_req, res) => {
  res.json({ labels: CANONICAL_LABELS });
});

gmailFiltersRouter.get('/:id/label-recommendation', async (req, res) => {
  const userId = getUserId(req);
  try {
    const row = await prisma.gmailFilter.findFirst({
      where: { id: req.params.id, userId },
      select: { signature: true },
    });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ckey = cacheKey(userId, req.params.id, row.signature);
    const cached = recommendCache.get(ckey);
    if (cached) {
      res.json(cached);
      return;
    }
    const rec = await recommendCanonicalLabel(userId, req.params.id);
    recommendCache.set(ckey, rec);
    res.json(rec);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    if (err instanceof Error && err.message === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    logger.error({ err, userId, mirrorId: req.params.id }, 'label recommendation failed');
    res.status(500).json({
      error: 'recommendation_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

const MigrateBody = z.object({
  newLabelPath: z.string().min(1).max(200),
  oldLabelName: z.string().max(200).nullable().optional(),
});

gmailFiltersRouter.post('/:id/migrate-label', async (req, res) => {
  const userId = getUserId(req);
  const parsed = MigrateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  try {
    const result = await migrateLabel(userId, {
      newLabelPath: parsed.data.newLabelPath,
      oldLabelName: parsed.data.oldLabelName ?? null,
    });
    res.json(result);
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    logger.error({ err, userId, mirrorId: req.params.id }, 'label migration failed');
    res.status(500).json({
      error: 'migrate_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

gmailFiltersRouter.post('/:id/disable', async (req, res) => {
  const userId = getUserId(req);
  try {
    await disableGmailFilter(userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (handleGmailError(err, userId, res)) return;
    if (err instanceof Error && err.message === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    logger.error({ err, userId, id: req.params.id }, 'gmail filter disable failed');
    res.status(500).json({ error: 'disable_failed', message: err instanceof Error ? err.message : String(err) });
  }
});
