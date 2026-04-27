import { z } from 'zod';
import { registerTool } from '../stdio-server.js';
import { prisma } from '../../db/client.js';

export function registerAgentActionsReadTools(): void {
  registerTool({
    name: 'agentActions.list',
    description:
      'List recent rows from the audit log (every Gmail mutation the system has taken). Filter by source ("rule" / "schedule" / "cleanup" / "chat" / "consolidator") or by target (gmailMessage / rule / scheduledAction). Use to answer "what did the system do today?" or before doing something destructive yourself.',
    inputSchema: z.object({
      source: z
        .enum(['rule', 'schedule', 'cleanup', 'chat', 'consolidator'])
        .optional(),
      targetType: z
        .enum(['gmailMessage', 'gmailLabel', 'rule', 'scheduledAction'])
        .optional(),
      since: z
        .string()
        .optional()
        .describe('ISO-8601 timestamp; only entries newer than this.'),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    handler: async ({ source, targetType, since, limit }, { userId }) => {
      const where: Record<string, unknown> = { userId };
      if (source) where.source = source;
      if (targetType) where.targetType = targetType;
      if (since) where.createdAt = { gt: new Date(since) };
      const rows = await prisma.agentAction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
      return {
        actions: rows.map((r) => ({
          id: r.id,
          source: r.source,
          sourceId: r.sourceId,
          targetType: r.targetType,
          targetId: r.targetId,
          toolName: r.toolName,
          toolInput: safeJson(r.toolInputJson, null),
          reasoning: r.reasoning,
          reversible: r.reversibleAs != null && r.reversedAt == null,
          reversedAt: r.reversedAt?.toISOString() ?? null,
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
