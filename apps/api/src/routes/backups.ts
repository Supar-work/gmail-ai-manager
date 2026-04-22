import { Router, type Router as RouterT } from 'express';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { buildGmailFilterXml } from '../gmail/filter-xml-export.js';
import type { GmailFilter } from '../gmail/filters.js';

export const backupsRouter: RouterT = Router();

backupsRouter.use(requireUser);

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
