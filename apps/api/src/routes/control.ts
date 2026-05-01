import { Router, type Router as RouterT } from 'express';
import { prisma } from '../db/client.js';
import { stopAllRunsForUser, hasActiveRunForUser } from '../classify/registry.js';
import { logger } from '../logger.js';
import { recordAgentAction } from '../audit/record.js';

export const controlRouter: RouterT = Router();

/**
 * Tray-driven controls. The Tauri shell shells out to `curl` against
 * loopback to flip these — there's no cookie session in the tray
 * process, so authentication is positional: only one human owns this
 * Mac, only one active User row exists at any given time. We pick the
 * single non-paused user and operate on them. Multi-user cloud is not
 * a goal of this app; if it ever becomes one, this endpoint goes
 * behind a session-aware middleware.
 *
 * The localOnly middleware mounted in server.ts proves the request
 * came from loopback; that's the trust boundary here.
 */

async function activeUserId(): Promise<string | null> {
  const u = await prisma.user.findFirst({
    where: { migratedAt: { not: null } },
    select: { id: true, status: true, updatedAt: true },
    // Most-recently-updated row wins if there are multiple (shouldn't be).
    orderBy: { updatedAt: 'desc' },
  });
  return u?.id ?? null;
}

controlRouter.get('/state', async (_req, res) => {
  const userId = await activeUserId();
  if (!userId) return res.json({ paused: false, runActive: false });
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  res.json({
    paused: u?.status === 'paused',
    runActive: hasActiveRunForUser(userId),
  });
});

controlRouter.post('/pause', async (_req, res) => {
  const userId = await activeUserId();
  if (!userId) return res.status(404).json({ error: 'no_active_user' });
  await prisma.user.update({ where: { id: userId }, data: { status: 'paused' } });
  await recordAgentAction({
    userId,
    source: 'chat',
    sourceId: null,
    targetType: 'rule',
    targetId: userId,
    toolName: 'control.pause',
    toolInputJson: '{}',
    reasoning: 'tray paused polling',
  });
  logger.info({ userId }, 'polling paused via tray');
  res.json({ ok: true, paused: true });
});

controlRouter.post('/resume', async (_req, res) => {
  const userId = await activeUserId();
  if (!userId) return res.status(404).json({ error: 'no_active_user' });
  await prisma.user.update({ where: { id: userId }, data: { status: 'active' } });
  await recordAgentAction({
    userId,
    source: 'chat',
    sourceId: null,
    targetType: 'rule',
    targetId: userId,
    toolName: 'control.resume',
    toolInputJson: '{}',
    reasoning: 'tray resumed polling',
  });
  logger.info({ userId }, 'polling resumed via tray');
  res.json({ ok: true, paused: false });
});

controlRouter.post('/stop-runs', async (_req, res) => {
  const userId = await activeUserId();
  if (!userId) return res.status(404).json({ error: 'no_active_user' });
  const n = stopAllRunsForUser(userId);
  await recordAgentAction({
    userId,
    source: 'chat',
    sourceId: null,
    targetType: 'rule',
    targetId: userId,
    toolName: 'control.stopRuns',
    toolInputJson: JSON.stringify({ stopped: n }),
    reasoning: 'tray stopped active classify runs',
  });
  logger.info({ userId, stopped: n }, 'classify runs stopped via tray');
  res.json({ ok: true, stopped: n });
});
