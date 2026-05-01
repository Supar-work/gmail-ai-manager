import type { Response } from 'express';
import { GoogleTokenError, isInvalidGrant, markNeedsReauth } from './client.js';

/**
 * Convert a Gmail API failure into a 401 + persisted needs-reauth flag.
 * Returns true when the error was handled and the response was sent;
 * false when the caller should keep handling it (the failure isn't an
 * auth one).
 *
 * Centralised so every Gmail-touching route uses the same heuristic for
 * "this token is dead" instead of three slightly different copies.
 */
export function handleGmailError(
  err: unknown,
  userId: string,
  res: Response,
): boolean {
  if (err instanceof GoogleTokenError || isInvalidGrant(err)) {
    void markNeedsReauth(userId);
    res.status(401).json({ error: 'needs_reauth' });
    return true;
  }
  return false;
}
