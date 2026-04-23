import type { CleanupSample } from '@gam/shared';
import { gmailForUser } from './client.js';
import { pMapLimit } from '../util/concurrency.js';
import { logger } from '../logger.js';

/**
 * Execute a Gmail search query for the cleanup wizard: return the inbox
 * vs all-mail counts plus up-to-N sample message metadata.
 *
 * Implementation:
 *   1. `users.messages.list(q + " in:inbox")` for the inbox subset,
 *      bounded by `maxCountProbe` — we only need an estimate plus a
 *      set of ids to mark samples as in-inbox.
 *   2. `users.messages.list(q)` for all-mail, pulling `maxSamples` ids.
 *   3. `users.messages.get(format:'metadata')` in parallel for the
 *      all-mail ids, building out the sample cards.
 */

const MAX_SAMPLES = 10;
const MAX_COUNT_PROBE = 200;
const FETCH_CONCURRENCY = 4;

export type SearchResult = {
  samples: CleanupSample[];
  totals: { inbox: number; allMail: number };
};

export async function searchMatchesForRule(
  userId: string,
  gmailQuery: string,
  opts: { maxSamples?: number } = {},
): Promise<SearchResult> {
  const maxSamples = Math.min(opts.maxSamples ?? MAX_SAMPLES, 25);
  const gmail = await gmailForUser(userId);

  if (!gmailQuery || !gmailQuery.trim()) {
    return { samples: [], totals: { inbox: 0, allMail: 0 } };
  }

  // ── inbox subset: ids + count ────────────────────────────────────────
  const inboxQuery = `${gmailQuery} in:inbox`;
  const inboxIds: string[] = [];
  let inboxCount = 0;
  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: inboxQuery,
      maxResults: MAX_COUNT_PROBE,
    });
    for (const m of res.data.messages ?? []) if (m.id) inboxIds.push(m.id);
    inboxCount = res.data.resultSizeEstimate ?? inboxIds.length;
  } catch (err) {
    logger.warn({ err, userId, q: inboxQuery }, 'inbox list failed');
  }
  const inboxIdSet = new Set(inboxIds);

  // ── all-mail subset: ids + count + sample fetch ────────────────────
  let allMailCount = 0;
  let sampleIds: string[] = [];
  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: gmailQuery,
      maxResults: Math.max(maxSamples, 20),
    });
    sampleIds = (res.data.messages ?? [])
      .map((m) => m.id)
      .filter((x): x is string => !!x)
      .slice(0, maxSamples);
    allMailCount = res.data.resultSizeEstimate ?? sampleIds.length;
  } catch (err) {
    logger.warn({ err, userId, q: gmailQuery }, 'all-mail list failed');
  }

  if (sampleIds.length === 0) {
    return { samples: [], totals: { inbox: inboxCount, allMail: allMailCount } };
  }

  const samples = await pMapLimit(sampleIds, FETCH_CONCURRENCY, async (id): Promise<CleanupSample | null> => {
    try {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
      });
      const headers = res.data.payload?.headers ?? [];
      const h = (name: string) =>
        headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
      const labels = res.data.labelIds ?? [];
      const inInbox = inboxIdSet.has(id) || labels.includes('INBOX');
      return {
        messageId: id,
        from: h('From'),
        subject: h('Subject'),
        snippet: res.data.snippet ?? null,
        inInbox,
      };
    } catch (err) {
      logger.warn({ err, userId, id }, 'sample metadata fetch failed');
      return null;
    }
  });

  return {
    samples: samples.filter((s): s is CleanupSample => s !== null),
    totals: { inbox: inboxCount, allMail: allMailCount },
  };
}

/**
 * Return just the ids of inbox messages matching a query. Used by the
 * apply step to compute which currently-in-inbox messages should be
 * marked "covered" in the wizard session.
 */
export async function listInboxIdsForQuery(
  userId: string,
  gmailQuery: string,
  max = 500,
): Promise<string[]> {
  if (!gmailQuery.trim()) return [];
  const gmail = await gmailForUser(userId);
  const q = `${gmailQuery} in:inbox`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(500, max - ids.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  return ids;
}

/**
 * Return all message ids matching a query across the user's entire
 * mail, bounded by `max`. Used by the "apply to all mail" scope.
 */
export async function listAllMailIdsForQuery(
  userId: string,
  gmailQuery: string,
  max = 2000,
): Promise<string[]> {
  if (!gmailQuery.trim()) return [];
  const gmail = await gmailForUser(userId);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: gmailQuery,
      maxResults: Math.min(500, max - ids.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  return ids;
}
