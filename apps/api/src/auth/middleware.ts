import type { Request, RequestHandler } from 'express';
import { readSession } from './session.js';

const USER_ID_KEY = Symbol.for('gaf.userId');

export const requireUser: RequestHandler = (req, res, next) => {
  const userId = readSession(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  (req as unknown as Record<symbol, string>)[USER_ID_KEY] = userId;
  next();
};

export function getUserId(req: Request): string {
  const v = (req as unknown as Record<symbol, string>)[USER_ID_KEY];
  if (!v) throw new Error('getUserId called without requireUser middleware');
  return v;
}
