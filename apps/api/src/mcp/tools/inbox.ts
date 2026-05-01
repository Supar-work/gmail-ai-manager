import { z } from 'zod';
import { registerTool } from '../stdio-server.js';
import { searchMatchesForRule } from '../../gmail/inbox-rule-search.js';
import { gmailForUser } from '../../gmail/client.js';
import { prisma } from '../../db/client.js';
import { safeJson } from '../../util/safe-json.js';

export function registerInboxReadTools(): void {
  registerTool({
    name: 'inbox.search',
    description:
      'Search Gmail using `q:` operators. Returns up to N most-recent matches with from/subject/snippet/inInbox flags. Use this for "find emails about X" or "everything from sender Y".',
    inputSchema: z.object({
      query: z.string().min(1).describe('Gmail search query string (operators allowed).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max samples to return (default 10).'),
    }),
    handler: async ({ query, limit }, { userId }) => {
      const res = await searchMatchesForRule(userId, query, { maxSamples: limit ?? 10 });
      return {
        gmailQuery: query,
        totals: res.totals,
        samples: res.samples,
      };
    },
  });

  registerTool({
    name: 'inbox.fetch',
    description:
      'Fetch full body of a single Gmail message by id. Use sparingly — body extraction is slow. Returns from/to/subject/labels/bodyText/internalDate.',
    inputSchema: z.object({
      messageId: z.string().describe('Gmail message id (e.g. "19dbad5f873f460d").'),
    }),
    handler: async ({ messageId }, { userId }) => {
      // Try local mirror first — most messages are cached.
      const cached = await prisma.inboxMessage.findFirst({
        where: { userId, gmailMessageId: messageId },
      });
      if (cached) {
        return {
          messageId: cached.gmailMessageId,
          from: cached.fromHeader,
          to: cached.toHeader,
          subject: cached.subject,
          snippet: cached.snippet,
          bodyText: (cached.bodyText ?? '').slice(0, 4000),
          labels: safeJson<string[]>(cached.labelIds, []),
          date: cached.dateHeader,
          source: 'cache',
        };
      }
      // Fall back to Gmail API.
      const gmail = await gmailForUser(userId);
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const headers = res.data.payload?.headers ?? [];
      const h = (n: string) =>
        headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? null;
      return {
        messageId: res.data.id,
        from: h('From'),
        to: h('To'),
        subject: h('Subject'),
        snippet: res.data.snippet ?? null,
        // Skip body extraction here for simplicity — `inbox.fetch` for
        // an uncached message returns header-only; chat agent should
        // sync first if it needs the body.
        bodyText: null,
        labels: res.data.labelIds ?? [],
        date: h('Date'),
        source: 'gmail',
      };
    },
  });
}
