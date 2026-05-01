import { prisma } from '../db/client.js';
import { logger } from '../logger.js';
import { isEncoderAvailable } from './encoder.js';
import { buildTextFor, indexOne } from './store.js';

/**
 * Background embedding indexer. Scans `InboxMessage` rows for the
 * subset that don't yet have a fresh `MessageEmbedding`, then embeds
 * them at low concurrency to avoid thrashing the user's CPU.
 *
 * Opt-in: only runs when `GAM_ENABLE_EMBEDDINGS=1` (env-driven so the
 * heavy `@xenova/transformers` dep stays optional). When the package
 * isn't installed at all, the encoder reports unavailable and we
 * silently skip every tick.
 *
 * Pacing: 1 minute between ticks; one batch of up to 50 messages per
 * tick; concurrency of 2 within a batch. A 5000-message inbox
 * back-fills in ~5 minutes after the first tick.
 */

const TICK_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 30_000;
const BATCH_SIZE = 50;
const CONCURRENCY = 2;

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startEmbeddingsIndexer(): void {
  if (started) return;
  if (process.env.GAM_ENABLE_EMBEDDINGS !== '1') {
    logger.info('embeddings indexer disabled (set GAM_ENABLE_EMBEDDINGS=1 to enable)');
    return;
  }
  started = true;
  setTimeout(() => void tickAll(), INITIAL_DELAY_MS);
  timer = setInterval(() => void tickAll(), TICK_INTERVAL_MS);
  logger.info({ tickSec: TICK_INTERVAL_MS / 1000 }, 'embeddings indexer started');
}

export function stopEmbeddingsIndexer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

async function tickAll(): Promise<void> {
  if (!(await isEncoderAvailable())) return;

  // Find users with at least one un-embedded inbox message. The naive
  // "all active users" loop is cheap because the inner query short-
  // circuits when the user is fully indexed.
  const users = await prisma.user.findMany({
    where: { status: 'active' },
    select: { id: true },
  });
  for (const u of users) {
    try {
      const n = await tickForUser(u.id);
      if (n > 0) {
        logger.info({ userId: u.id, indexed: n }, 'embeddings indexer batch');
      }
    } catch (err) {
      logger.warn({ err, userId: u.id }, 'embeddings indexer batch failed');
    }
  }
}

/** Visible-for-test: index up to one batch for a single user. */
export async function tickForUser(userId: string): Promise<number> {
  // Pull the most-recent InboxMessages without a fresh embedding row.
  // We don't try to be fancy about contentHash invalidation here — the
  // unique (userId, gmailMessageId) lets us upsert via indexOne which
  // skips when nothing has changed.
  const candidates = await prisma.inboxMessage.findMany({
    where: { userId },
    orderBy: { internalDate: 'desc' },
    take: BATCH_SIZE,
    select: {
      gmailMessageId: true,
      subject: true,
      snippet: true,
      bodyText: true,
      fromHeader: true,
    },
  });
  if (candidates.length === 0) return 0;

  // Filter out ones with a current embedding row.
  const ids = candidates.map((c) => c.gmailMessageId);
  const existing = await prisma.messageEmbedding.findMany({
    where: { userId, gmailMessageId: { in: ids } },
    select: { gmailMessageId: true },
  });
  const haveSet = new Set(existing.map((e) => e.gmailMessageId));
  const todo = candidates.filter((c) => !haveSet.has(c.gmailMessageId));
  if (todo.length === 0) return 0;

  let indexed = 0;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const slice = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map((m) =>
        indexOne({
          userId,
          gmailMessageId: m.gmailMessageId,
          text: buildTextFor(m),
        }),
      ),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && (r.value === 'inserted' || r.value === 'updated')) {
        indexed++;
      }
    }
  }
  return indexed;
}
