import type { gmail_v1 } from 'googleapis';
import { prisma } from '../db/client.js';
import { gmailForUser } from './client.js';
import { pMapLimit } from '../util/concurrency.js';
import { logger } from '../logger.js';

export type SyncProgressSink = {
  event?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
};

export type SyncResult = {
  inboxSize: number;
  fetched: number;
  removed: number;
};

const FETCH_CONCURRENCY = 5;
const LIST_PAGE_SIZE = 500;

/**
 * Pull the current Gmail inbox into the local InboxMessage cache.
 *
 * Strategy: list all message IDs currently matching `in:inbox`, diff against
 * the cache, then:
 *   - fetch full content for IDs we've never seen (parallel, bounded),
 *   - update labelIds for already-cached messages,
 *   - delete rows for messages that have left the inbox.
 *
 * After this runs, classification reads message bodies from SQLite and does
 * not touch the Gmail API per message, which is the hot path that was slow.
 */
export async function syncInbox(
  userId: string,
  opts: { sink?: SyncProgressSink; maxMessages?: number } = {},
): Promise<SyncResult> {
  const emit = (msg: string, level: 'info' | 'warn' | 'error' = 'info') =>
    opts.sink?.event?.(msg, level);
  const maxMessages = opts.maxMessages ?? 1000;

  const gmail = await gmailForUser(userId);

  emit('Listing current Gmail inbox…');
  const currentIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:inbox',
      maxResults: Math.min(LIST_PAGE_SIZE, maxMessages - currentIds.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) {
      if (m.id) currentIds.push(m.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && currentIds.length < maxMessages);

  const currentSet = new Set(currentIds);
  const cachedRows = await prisma.inboxMessage.findMany({
    where: { userId },
    select: { id: true, gmailMessageId: true },
  });
  const cachedSet = new Set(cachedRows.map((r) => r.gmailMessageId));

  const toFetch = currentIds.filter((id) => !cachedSet.has(id));
  const toRemove = cachedRows.filter((r) => !currentSet.has(r.gmailMessageId));

  emit(
    `Inbox: ${currentIds.length} messages · cached: ${cachedSet.size} · to fetch: ${toFetch.length} · to drop: ${toRemove.length}.`,
  );

  let fetched = 0;
  if (toFetch.length > 0) {
    await pMapLimit(toFetch, FETCH_CONCURRENCY, async (id) => {
      try {
        const full = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        });
        await writeMessageRow(userId, full.data);
        fetched++;
        if (fetched === toFetch.length || fetched % 25 === 0) {
          emit(`Fetched ${fetched}/${toFetch.length}…`);
        }
      } catch (err) {
        logger.warn({ err, userId, id }, 'failed to fetch gmail message');
        emit(`Failed to fetch ${id}: ${String(err).slice(0, 120)}`, 'warn');
      }
    });
  }

  if (toRemove.length > 0) {
    await prisma.inboxMessage.deleteMany({
      where: { id: { in: toRemove.map((r) => r.id) } },
    });
  }

  emit(`Sync done: ${fetched} fetched, ${toRemove.length} dropped.`);
  return { inboxSize: currentIds.length, fetched, removed: toRemove.length };
}

async function writeMessageRow(userId: string, data: gmail_v1.Schema$Message): Promise<void> {
  if (!data.id) return;
  const headers = data.payload?.headers ?? [];
  const h = (name: string) =>
    headers.find((x: gmail_v1.Schema$MessagePartHeader) => x.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? null;

  const bodyText = extractPlainText(data.payload);
  const internalDate = data.internalDate ? new Date(Number(data.internalDate)) : null;
  const fromHeader = h('From');
  const list = extractListMetadata({
    fromHeader,
    listIdRaw: h('List-ID') ?? h('List-Id'),
    listPostRaw: h('List-Post'),
    listUnsubRaw: h('List-Unsubscribe'),
    replyTo: h('Reply-To'),
    sender: h('Sender'),
    xOriginalFrom: h('X-Original-From') ?? h('X-Google-Original-From'),
    precedence: h('Precedence'),
  });

  await prisma.inboxMessage.upsert({
    where: { userId_gmailMessageId: { userId, gmailMessageId: data.id } },
    create: {
      userId,
      gmailMessageId: data.id,
      threadId: data.threadId ?? null,
      historyId: data.historyId ?? null,
      fromHeader,
      toHeader: h('To'),
      subject: h('Subject'),
      snippet: data.snippet ?? null,
      bodyText,
      labelIds: JSON.stringify(data.labelIds ?? []),
      dateHeader: h('Date'),
      internalDate,
      listId: list.listId,
      listPost: list.listPost,
      listUnsubscribe: list.listUnsubscribe,
      originalFromHeader: list.originalFromHeader,
      precedence: list.precedence,
    },
    update: {
      labelIds: JSON.stringify(data.labelIds ?? []),
      snippet: data.snippet ?? null,
      historyId: data.historyId ?? null,
      // Update list metadata too — newly-discovered headers (e.g.
      // user changed their forwarding setup) should refresh the row.
      listId: list.listId,
      listPost: list.listPost,
      listUnsubscribe: list.listUnsubscribe,
      originalFromHeader: list.originalFromHeader,
      precedence: list.precedence,
    },
  });
}

/**
 * Distil mailing-list / forwarding metadata from raw headers.
 * Centralised here so the sync path AND any future re-extraction
 * over old rows uses the same parsing.
 *
 * Returns:
 *   - listId          — bare List-ID with `<>` stripped, lowercased
 *   - listPost        — `mailto:` from List-Post (or first URL)
 *   - listUnsubscribe — first URL/mailto from List-Unsubscribe
 *   - originalFromHeader — Reply-To / Sender / X-Original-From when
 *                         that disagrees with the visible From
 *                         (Google Groups rewrites From to "X via
 *                         Group <list@…>" — the original sender
 *                         lives in Reply-To). Null when From is
 *                         already the original.
 *   - precedence      — bulk / list / junk / etc. (lowercased)
 */
export function extractListMetadata(args: {
  fromHeader: string | null;
  listIdRaw: string | null;
  listPostRaw: string | null;
  listUnsubRaw: string | null;
  replyTo: string | null;
  sender: string | null;
  xOriginalFrom: string | null;
  precedence: string | null;
}): {
  listId: string | null;
  listPost: string | null;
  listUnsubscribe: string | null;
  originalFromHeader: string | null;
  precedence: string | null;
} {
  const stripAngles = (s: string): string => {
    const m = /<([^>]+)>/.exec(s);
    return (m && m[1] ? m[1] : s).trim();
  };
  const listId = args.listIdRaw ? stripAngles(args.listIdRaw).toLowerCase() : null;
  const listPost = args.listPostRaw ? stripAngles(args.listPostRaw) : null;
  // List-Unsubscribe can have multiple comma-separated values (mailto + URL).
  const listUnsubscribe = args.listUnsubRaw
    ? stripAngles(args.listUnsubRaw.split(',')[0] ?? args.listUnsubRaw)
    : null;

  // Detect when the visible From was REWRITTEN away from the original
  // sender (Google Groups, Mailman with rewrite-from, etc.). Without
  // detection we'd over-attribute "originalFrom" on lists that just
  // forward without rewriting (where Reply-To is the list itself,
  // not the original sender).
  //
  // Three reliable signals, in order:
  //   1. Explicit X-Original-From / X-Google-Original-From header.
  //   2. The visible From contains Google Groups' canonical "X via
  //      Group" rewrite marker — display name like
  //      `"'Apple' via Zeligs"`.
  //   3. Sender header has a different address than From AND Reply-To
  //      isn't the same as From (rewrites generally show
  //      Sender == list-address, From != original).
  const fromAddr = args.fromHeader ? extractAddress(args.fromHeader) : null;
  const senderAddr = args.sender ? extractAddress(args.sender) : null;
  const replyToAddr = args.replyTo ? extractAddress(args.replyTo) : null;
  const fromIsViaRewrite = args.fromHeader ? / via \S/.test(args.fromHeader) : false;
  const senderDiffersFromFrom = !!(
    senderAddr &&
    fromAddr &&
    senderAddr.toLowerCase() !== fromAddr.toLowerCase()
  );

  let originalFromHeader: string | null = null;
  if (args.xOriginalFrom) {
    originalFromHeader = args.xOriginalFrom.trim();
  } else if (fromIsViaRewrite || senderDiffersFromFrom) {
    // From was rewritten. Reply-To is the canonical recovery vector
    // (Google Groups sets Reply-To to the original sender on rewrite).
    if (
      replyToAddr &&
      fromAddr &&
      replyToAddr.toLowerCase() !== fromAddr.toLowerCase()
    ) {
      originalFromHeader = (args.replyTo ?? '').trim() || null;
    }
  }

  return {
    listId,
    listPost,
    listUnsubscribe,
    originalFromHeader,
    precedence: args.precedence ? args.precedence.trim().toLowerCase() : null,
  };
}

function extractAddress(headerValue: string): string | null {
  const m = /<([^>]+)>/.exec(headerValue);
  if (m && m[1]) return m[1].trim();
  const t = headerValue.trim();
  return /@/.test(t) ? t : null;
}

function extractPlainText(
  payload:
    | {
        mimeType?: string | null;
        body?: { data?: string | null } | null;
        parts?: Array<{
          mimeType?: string | null;
          body?: { data?: string | null } | null;
          parts?: unknown;
        }> | null;
      }
    | null
    | undefined,
): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part as Parameters<typeof extractPlainText>[0]);
    if (text) return text;
  }
  return '';
}
