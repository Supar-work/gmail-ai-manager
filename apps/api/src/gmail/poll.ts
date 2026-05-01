import { prisma } from '../db/client.js';
import { gmailForUser, GoogleTokenError, isInvalidGrant, markNeedsReauth } from './client.js';
import { classifyRecent } from '../classify/run.js';
import { syncInbox } from './sync.js';
import { logger } from '../logger.js';

let started = false;
let timer: NodeJS.Timeout | null = null;
let polling = false;

const TICK_MS = 30_000;
const lastPolledAt = new Map<string, number>();

export function startPoller(): void {
  if (started) return;
  started = true;
  setTimeout(() => void pollAll(), 5_000);
  timer = setInterval(() => void pollAll(), TICK_MS);
  logger.info({ tickSec: TICK_MS / 1000 }, 'inbox poller started');
}

export function stopPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  polling = false;
  lastPolledAt.clear();
}

// Re-entrancy guard: a slow Gmail tick (throttling, large user)
// shouldn't stack with the next 30s interval. The previous run owns the
// work; the new tick bows out.
export async function pollAll(): Promise<void> {
  if (polling) {
    logger.debug('poll already running; skipping');
    return;
  }
  polling = true;
  try {
    await pollAllInner();
  } finally {
    polling = false;
  }
}

async function pollAllInner(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { status: 'active', migratedAt: { not: null } },
    select: { id: true, pollIntervalSec: true },
  });
  const now = Date.now();
  for (const u of users) {
    const last = lastPolledAt.get(u.id) ?? 0;
    if (now - last < u.pollIntervalSec * 1000) continue;
    lastPolledAt.set(u.id, now);
    try {
      await pollUser(u.id);
    } catch (err) {
      if (err instanceof GoogleTokenError || isInvalidGrant(err)) {
        await markNeedsReauth(u.id);
        logger.warn({ userId: u.id }, 'poll marked user needs reauth');
        continue;
      }
      logger.error({ err, userId: u.id }, 'poll failed');
    }
  }
}

/**
 * Poll one user: sync the inbox cache, then classify any cached messages
 * that don't yet have an EmailDecision. The `classifyRecent` dedup check
 * takes care of only processing new arrivals.
 */
export async function pollUser(userId: string): Promise<{ classified: number }> {
  // Cheap path: a single messages.list to learn if anything changed. If the
  // cached set already matches the inbox head, we can skip classification.
  const gmail = await gmailForUser(userId);
  const headRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox',
    maxResults: 25,
  });
  const headIds = (headRes.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  if (headIds.length === 0) return { classified: 0 };

  const existing = await prisma.inboxMessage.findMany({
    where: { userId, gmailMessageId: { in: headIds } },
    select: { gmailMessageId: true },
  });
  const existingSet = new Set(existing.map((e) => e.gmailMessageId));
  const newIds = headIds.filter((id) => !existingSet.has(id));

  if (newIds.length === 0) return { classified: 0 };

  await syncInbox(userId);
  const result = await classifyRecent(userId, {
    ids: newIds,
    trigger: 'poll',
    maxMessages: newIds.length,
    syncFirst: false, // already synced above
  });
  return { classified: result.scanned - result.skippedAlreadySeen };
}
