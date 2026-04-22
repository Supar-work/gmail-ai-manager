import { Router, type Router as RouterT } from 'express';
import { prisma } from '../db/client.js';
import { readSession } from '../auth/session.js';

export const meRouter: RouterT = Router();

meRouter.get('/', async (req, res) => {
  const userId = readSession(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, timezone: true, status: true, createdAt: true },
  });
  if (!user) return res.status(401).json({ error: 'unauthenticated' });

  res.json(user);
});
