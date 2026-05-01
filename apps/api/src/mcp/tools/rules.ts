import { z } from 'zod';
import { registerTool } from '../stdio-server.js';
import { prisma } from '../../db/client.js';
import { safeJson } from '../../util/safe-json.js';

export function registerRulesReadTools(): void {
  registerTool({
    name: 'rules.list',
    description:
      'List the user\'s AI rules with id, natural-language text, action list, enabled flag, and order. Use this when the user asks "what rules do I have" or before suggesting a new rule (so duplicates can be avoided).',
    inputSchema: z.object({
      includeDisabled: z
        .boolean()
        .optional()
        .describe('Include rules whose enabled flag is false (default true).'),
    }),
    handler: async ({ includeDisabled }, { userId }) => {
      const where: Record<string, unknown> = { userId };
      if (includeDisabled === false) where.enabled = true;
      const rows = await prisma.rule.findMany({
        where,
        orderBy: { position: 'asc' },
      });
      return {
        rules: rows.map((r) => ({
          id: r.id,
          naturalLanguage: r.naturalLanguage,
          actions: safeJson(r.actionsJson, [] as unknown[]),
          enabled: r.enabled,
          position: r.position,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  });
}
