import { randomBytes } from 'node:crypto';
import { Router, type Router as RouterT } from 'express';
import { env } from '../env.js';
import { prisma } from '../db/client.js';
import { buildAuthUrl, exchangeCode, fetchUserInfo } from '../auth/google.js';
import { decrypt, encrypt } from '../auth/crypto.js';
import { clearSession, readSession, setSession } from '../auth/session.js';
import { logger } from '../logger.js';

export const authRouter: RouterT = Router();

const STATE_COOKIE = 'gaf_oauth_state';
const TZ_COOKIE = 'gaf_tz';

authRouter.get('/google/start', (req, res) => {
  const state = randomBytes(16).toString('base64url');
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });
  const tz = typeof req.query.tz === 'string' ? req.query.tz : 'UTC';
  res.cookie(TZ_COOKIE, tz, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });
  res.redirect(buildAuthUrl(state));
});

// In production the web UI is served from the same origin, so redirects can
// be path-only. In dev, Vite serves the UI on a different port.
const webBase = () => (env.NODE_ENV === 'production' ? '' : env.PUBLIC_WEB_URL);

authRouter.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    logger.warn({ error }, 'oauth error from google');
    return res.redirect(`${webBase()}/login?error=${encodeURIComponent(String(error))}`);
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).json({ error: 'missing_code_or_state' });
  }
  const cookieState = req.cookies?.[STATE_COOKIE];
  if (!cookieState || cookieState !== state) {
    return res.status(400).json({ error: 'bad_state' });
  }
  res.clearCookie(STATE_COOKIE, { path: '/' });

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.access_token) {
      return res.status(400).json({ error: 'no_access_token' });
    }
    const info = await fetchUserInfo(tokens.access_token);
    if (!info.id || !info.email) {
      return res.status(400).json({ error: 'no_user_info' });
    }

    const tz = typeof req.cookies?.[TZ_COOKIE] === 'string' ? req.cookies[TZ_COOKIE] : 'UTC';
    res.clearCookie(TZ_COOKIE, { path: '/' });

    const encAccess = encrypt(tokens.access_token);
    const encRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    const user = await prisma.user.upsert({
      where: { googleSub: info.id },
      create: {
        googleSub: info.id,
        email: info.email,
        timezone: tz,
        encAccessToken: encAccess,
        encRefreshToken: encRefresh,
        tokenScope: tokens.scope ?? null,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
      update: {
        email: info.email,
        encAccessToken: encAccess,
        ...(encRefresh ? { encRefreshToken: encRefresh } : {}),
        tokenScope: tokens.scope ?? undefined,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        status: 'active',
      },
    });

    setSession(res, user.id);
    res.redirect(`${webBase()}/`);
  } catch (err) {
    logger.error({ err }, 'oauth callback failed');
    res.redirect(`${webBase()}/login?error=oauth_failed`);
  }
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// Revoke the stored Google tokens + clear local tokens + clear session. The
// web client then redirects to /auth/google/start for a fresh consent. This
// is the "Reconnect Gmail" action — useful when Google's backend has bound
// the current access token to a stale view of the user's settings (e.g. a
// filters.list endpoint that returns 204 despite filters existing).
authRouter.post('/reconnect', async (req, res) => {
  const userId = readSession(req);
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { encAccessToken: true, encRefreshToken: true },
    });
    const tokensToRevoke: string[] = [];
    try {
      if (user?.encAccessToken) tokensToRevoke.push(decrypt(Buffer.from(user.encAccessToken)));
    } catch {
      /* ignore */
    }
    try {
      if (user?.encRefreshToken) tokensToRevoke.push(decrypt(Buffer.from(user.encRefreshToken)));
    } catch {
      /* ignore */
    }
    await Promise.all(
      tokensToRevoke.map((tok) =>
        fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tok }).toString(),
        }).catch((err) => logger.warn({ err }, 'token revoke failed')),
      ),
    );
    await prisma.user.update({
      where: { id: userId },
      data: {
        encAccessToken: null,
        encRefreshToken: null,
        tokenScope: null,
        tokenExpiresAt: null,
        lastHistoryId: null,
        status: 'needsReauth',
      },
    });
  }
  clearSession(res);
  res.json({ ok: true });
});
