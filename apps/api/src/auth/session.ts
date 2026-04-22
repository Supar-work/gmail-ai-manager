import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../env.js';

const COOKIE_NAME = 'gaf_sid';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function sign(userId: string): string {
  const mac = createHmac('sha256', env.SESSION_SECRET).update(userId).digest('base64url');
  return `${userId}.${mac}`;
}

function verify(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const userId = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = createHmac('sha256', env.SESSION_SECRET).update(userId).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}

export function setSession(res: Response, userId: string): void {
  res.cookie(COOKIE_NAME, sign(userId), {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function readSession(req: Request): string | null {
  const raw = req.cookies?.[COOKIE_NAME];
  if (typeof raw !== 'string') return null;
  return verify(raw);
}
