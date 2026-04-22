import { Router, type Router as RouterT } from 'express';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { getRun, setControl, type RunEvent } from '../classify/registry.js';

export const runsRouter: RouterT = Router();

runsRouter.use(requireUser);

runsRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const rows = await prisma.classifyRun.findMany({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      trigger: true,
      status: true,
      scanned: true,
      matched: true,
      applied: true,
      scheduled: true,
      skipped: true,
      errorMsg: true,
    },
  });
  res.json({ runs: rows });
});

runsRouter.get('/:id', async (req, res) => {
  const userId = getUserId(req);
  const runId = req.params.id;
  const live = getRun(runId);
  if (live && live.userId === userId) {
    res.json({
      id: live.id,
      status: live.status,
      control: live.control,
      startedAt: new Date(live.startedAt).toISOString(),
      finishedAt: live.finishedAt ? new Date(live.finishedAt).toISOString() : null,
      scanned: live.scanned,
      matched: live.matched,
      applied: live.applied,
      scheduled: live.scheduled,
      skipped: live.skipped,
      errorMsg: live.errorMsg ?? null,
      events: live.events,
      actions: live.actions,
    });
    return;
  }
  const row = await prisma.classifyRun.findFirst({ where: { id: runId, userId } });
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  let events: RunEvent[] = [];
  try {
    events = JSON.parse(row.logJson) as RunEvent[];
  } catch {
    /* ignore */
  }
  res.json({
    id: row.id,
    status: row.status,
    control: 'running',
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    scanned: row.scanned,
    matched: row.matched,
    applied: row.applied,
    scheduled: row.scheduled,
    skipped: row.skipped,
    errorMsg: row.errorMsg,
    events,
    actions: [],
  });
});

// Control endpoints — flip the registry's control flag. Workers check the
// flag between messages, so transitions aren't instantaneous on long tasks
// but typically take <3s to take effect (one Claude call per worker).

runsRouter.post('/:id/pause', (req, res) => {
  const userId = getUserId(req);
  const live = getRun(req.params.id);
  if (!live || live.userId !== userId) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const ok = setControl(req.params.id, 'paused');
  if (!ok) {
    res.status(409).json({ error: 'not_running' });
    return;
  }
  res.json({ ok: true });
});

runsRouter.post('/:id/resume', (req, res) => {
  const userId = getUserId(req);
  const live = getRun(req.params.id);
  if (!live || live.userId !== userId) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const ok = setControl(req.params.id, 'running');
  if (!ok) {
    res.status(409).json({ error: 'not_running' });
    return;
  }
  res.json({ ok: true });
});

runsRouter.post('/:id/stop', (req, res) => {
  const userId = getUserId(req);
  const live = getRun(req.params.id);
  if (!live || live.userId !== userId) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const ok = setControl(req.params.id, 'stopping');
  if (!ok) {
    res.status(409).json({ error: 'not_running' });
    return;
  }
  res.json({ ok: true });
});
