import { Router, type Router as RouterT } from 'express';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { deleteFilter, listFilters, listLabels } from '../gmail/filters.js';
import { GoogleTokenError, isInvalidGrant, markNeedsReauth } from '../gmail/client.js';
import { translateFilters } from '../claude/translator.js';
import { logger } from '../logger.js';

export const migrationRouter: RouterT = Router();

migrationRouter.use(requireUser);

// GET /api/migration/status — drives the landing-page decision about whether
// to run the first-run flow or jump straight to the rules page.
migrationRouter.get('/status', async (req, res) => {
  const userId = getUserId(req);
  const [user, ruleCount, backupCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { migratedAt: true } }),
    prisma.rule.count({ where: { userId } }),
    prisma.filterBackup.count({ where: { userId } }),
  ]);
  res.json({
    migratedAt: user?.migratedAt ?? null,
    ruleCount,
    backupCount,
    needsMigration: !user?.migratedAt,
  });
});

/**
 * POST /api/migration/run — the one-shot first-run migration:
 *   1. Pull existing Gmail filters + labels.
 *   2. Write a FilterBackup snapshot (the backup file the user can re-import).
 *   3. Translate each filter into a natural-language rule via claude -p.
 *   4. Create Rule rows.
 *   5. Delete the original filters from Gmail.
 *   6. Stamp User.migratedAt so future loads skip straight to the rules page.
 *
 * Idempotent in the "already migrated" case: if migratedAt is already set,
 * returns early with the current state.
 */
migrationRouter.post('/run', async (req, res) => {
  const userId = getUserId(req);
  try {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { migratedAt: true },
    });
    if (existing?.migratedAt) {
      res.json({ alreadyMigrated: true, migratedAt: existing.migratedAt });
      return;
    }

    const [filters, labels] = await Promise.all([listFilters(userId), listLabels(userId)]);
    const labelMap: Record<string, string> = {};
    for (const l of labels) if (l.id && l.name) labelMap[l.id] = l.name;

    // Always write a backup — even for empty filter sets we want a marker.
    const backup = await prisma.filterBackup.create({
      data: {
        userId,
        snapshotJson: JSON.stringify({
          filters,
          labelMap,
          exportedAt: new Date().toISOString(),
          reason: 'first-run-migration',
        }),
      },
    });

    let createdRules = 0;
    if (filters.length > 0) {
      const translated = await translateFilters(filters, labelMap);
      const startPos = await prisma.rule.count({ where: { userId } });
      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < translated.length; i++) {
          const t = translated[i]!;
          const original = filters.find((f) => f.id === t.id);
          await tx.rule.create({
            data: {
              userId,
              naturalLanguage: t.naturalLanguage,
              actionsJson: JSON.stringify(t.actions),
              originalFilterJson: original ? JSON.stringify(original) : null,
              position: startPos + i,
              enabled: true,
            },
          });
          createdRules++;
        }
      });
    }

    const deletionErrors: Array<{ filterId: string; error: string }> = [];
    for (const f of filters) {
      if (!f.id) continue;
      try {
        await deleteFilter(userId, f.id);
      } catch (err) {
        logger.warn({ err, userId, filterId: f.id }, 'failed to delete gmail filter during migration');
        deletionErrors.push({ filterId: f.id, error: String(err) });
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { migratedAt: new Date() },
      select: { migratedAt: true },
    });

    res.json({
      migratedAt: updated.migratedAt,
      backupId: backup.id,
      filtersSeen: filters.length,
      rulesCreated: createdRules,
      deletionErrors,
    });
  } catch (err) {
    if (err instanceof GoogleTokenError || isInvalidGrant(err)) {
      await markNeedsReauth(userId);
      res.status(401).json({ error: 'needs_reauth' });
      return;
    }
    logger.error({ err, userId }, 'migration failed');
    res.status(500).json({ error: 'migration_failed', message: err instanceof Error ? err.message : String(err) });
  }
});
