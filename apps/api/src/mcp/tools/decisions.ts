import { z } from 'zod';
import { registerTool } from '../stdio-server.js';
import { prisma } from '../../db/client.js';

export function registerDecisionsReadTools(): void {
  registerTool({
    name: 'decisions.recent',
    description:
      'List recent classifier decisions: per Gmail message, which rule(s) matched, what reasoning the classifier gave, what actions were applied or scheduled. Use to answer "why was this email archived?" or "what did the rules engine do this morning?".',
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max rows to return, newest first (default 50).'),
    }),
    handler: async ({ limit }, { userId }) => {
      const rows = await prisma.emailDecision.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
      return {
        decisions: rows.map((r) => ({
          id: r.id,
          gmailMessageId: r.gmailMessageId,
          matchedRuleIds: safeJson<string[]>(r.matchedRuleIds, []),
          reasoning: safeJson<unknown>(r.reasoning, []),
          actionsApplied: safeJson<unknown>(r.actionsApplied, []),
          actionsScheduled: safeJson<unknown>(r.actionsScheduled, []),
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  });
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
