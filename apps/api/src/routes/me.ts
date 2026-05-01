import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { readSession } from '../auth/session.js';
import {
  addPendingForwardTarget,
  confirmForwardTarget,
  InvalidForwardTargetError,
  listForwardTargets,
  removeForwardTarget,
} from '../gmail/forward-allowlist.js';
import { recordAgentAction } from '../audit/record.js';
import { getClaudePreflightStatus } from '../claude/preflight.js';

export const meRouter: RouterT = Router();

meRouter.get('/', async (req, res) => {
  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, timezone: true, status: true, createdAt: true },
  });
  if (!user) return res.status(401).json({ error: 'unauthenticated' });

  // Surface CLI health so the UI can render a banner when the Claude
  // CLI is missing/wedged. Without this signal a missing binary fails
  // silently per-rule and the user just sees "rules don't fire".
  res.json({ ...user, claudeCli: getClaudePreflightStatus() });
});

// `forward` action allowlist. The classifier and inbox-cleanup wizard
// can propose `forward` actions; `applyAction` refuses to send to any
// address not in this list with `verified=true`. Pending rows show up
// in Settings as "confirm to allow forwarding to X".
meRouter.get('/forward-allowlist', async (req, res) => {
  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const items = await listForwardTargets(userId);
  res.json({ items });
});

const addSchema = z.object({ address: z.string().min(3).max(254) });
meRouter.post('/forward-allowlist', async (req, res) => {
  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_address', details: parsed.error.format() });
  }
  try {
    const row = await addPendingForwardTarget(userId, parsed.data.address);
    await recordAgentAction({
      userId,
      source: 'chat',
      sourceId: null,
      targetType: 'rule',
      targetId: row.id,
      toolName: 'forwardAllowlist.addPending',
      toolInputJson: JSON.stringify({ address: row.address }),
      reasoning: 'user added forward target pending confirmation',
    });
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof InvalidForwardTargetError) {
      return res.status(400).json({ error: 'invalid_address' });
    }
    throw err;
  }
});

meRouter.post('/forward-allowlist/:id/confirm', async (req, res) => {
  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const row = await confirmForwardTarget(userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  await recordAgentAction({
    userId,
    source: 'chat',
    sourceId: null,
    targetType: 'rule',
    targetId: row.id,
    toolName: 'forwardAllowlist.confirm',
    toolInputJson: JSON.stringify({ address: row.address }),
    reasoning: 'user confirmed forward target',
  });
  res.json(row);
});

meRouter.delete('/forward-allowlist/:id', async (req, res) => {
  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const ok = await removeForwardTarget(userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.status(204).send();
});
