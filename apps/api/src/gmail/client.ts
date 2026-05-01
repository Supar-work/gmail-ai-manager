import { google, type gmail_v1 } from 'googleapis';
import { oauthClient } from '../auth/google.js';
import { decrypt, encrypt } from '../auth/crypto.js';
import { prisma } from '../db/client.js';
import { logger } from '../logger.js';

export class GoogleTokenError extends Error {
  constructor(
    message: string,
    public readonly needsReauth: boolean,
  ) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

export async function clientForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      encAccessToken: true,
      encRefreshToken: true,
      tokenExpiresAt: true,
      tokenScope: true,
    },
  });
  if (!user || !user.encAccessToken) {
    throw new GoogleTokenError('missing_tokens', true);
  }

  const accessToken = decrypt(Buffer.from(user.encAccessToken));
  const refreshToken = user.encRefreshToken ? decrypt(Buffer.from(user.encRefreshToken)) : undefined;

  const auth = oauthClient();
  auth.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: user.tokenExpiresAt?.getTime(),
    scope: user.tokenScope ?? undefined,
  });

  // Persist refreshed tokens
  auth.on('tokens', (tokens) => {
    void (async () => {
      try {
        const update: {
          encAccessToken?: Buffer;
          encRefreshToken?: Buffer;
          tokenExpiresAt?: Date | null;
          tokenScope?: string | null;
        } = {};
        if (tokens.access_token) update.encAccessToken = encrypt(tokens.access_token);
        if (tokens.refresh_token) update.encRefreshToken = encrypt(tokens.refresh_token);
        if (tokens.expiry_date) update.tokenExpiresAt = new Date(tokens.expiry_date);
        if (tokens.scope) update.tokenScope = tokens.scope;
        if (Object.keys(update).length > 0) {
          await prisma.user.update({ where: { id: userId }, data: update });
        }
      } catch (err) {
        logger.error({ err, userId }, 'failed to persist refreshed tokens');
      }
    })();
  });

  return auth;
}

export async function gmailForUser(userId: string): Promise<gmail_v1.Gmail> {
  const auth = await clientForUser(userId);
  return google.gmail({ version: 'v1', auth });
}

export function isInvalidGrant(err: unknown): boolean {
  const e = err as
    | {
        response?: { data?: { error?: string } };
        message?: string;
        code?: string | number;
      }
    | null
    | undefined;
  if (!e) return false;
  if (e.response?.data?.error === 'invalid_grant') return true;
  // googleapis sometimes throws a plain Error('invalid_grant') with no
  // .response payload — this happens on token refresh failures inside
  // GoogleAuth#getAccessToken. Match the message so we still flip the
  // user to needsReauth instead of streaming "poll failed" warnings
  // forever.
  if (typeof e.message === 'string' && e.message.toLowerCase().includes('invalid_grant')) {
    return true;
  }
  return false;
}

export async function markNeedsReauth(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { status: 'needsReauth' },
  });
}
