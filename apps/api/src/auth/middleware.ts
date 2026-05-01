import type { Request, RequestHandler } from 'express';
import { readSession } from './session.js';

// `Request.userId` is declaration-merged in apps/api/src/types/express.d.ts
// so we can assign and read it as a typed property rather than smuggling
// it through a symbol-keyed cast. The runtime check in `getUserId` still
// catches "route forgot the middleware".

export const requireUser: RequestHandler = (req, res, next) => {
  const userId = readSession(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  req.userId = userId;
  next();
};

export function getUserId(req: Request): string {
  if (!req.userId) {
    throw new Error('getUserId called without requireUser middleware');
  }
  return req.userId;
}
