import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';

export const settingsRouter: RouterT = Router();

settingsRouter.use(requireUser);

const SELECT = {
  pollIntervalSec: true,
  timezone: true,
  claudeModel: true,
} as const;

settingsRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: SELECT });
  if (!user) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(user);
});

const UpdateSchema = z.object({
  pollIntervalSec: z.number().int().min(60).max(3600).optional(),
  // Null clears the override and falls back to the CLI default. A non-empty
  // string is the model id passed to `claude -p --model`.
  claudeModel: z.union([z.string().min(1), z.null()]).optional(),
});

settingsRouter.put('/', async (req, res) => {
  const userId = getUserId(req);
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }
  const user = await prisma.user.update({
    where: { id: userId },
    data: parsed.data,
    select: SELECT,
  });
  res.json(user);
});
