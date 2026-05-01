import { z } from 'zod';
import { registerTool } from '../stdio-server.js';
import { isEncoderAvailable } from '../../embeddings/encoder.js';
import { semanticSearch, similar } from '../../embeddings/store.js';

/**
 * Semantic search MCP tools, surfaced to the searcher + triage
 * specialists. They degrade to a "feature_disabled" payload when the
 * embeddings package isn't installed or the index hasn't been built
 * yet — the agent should fall back to `inbox.search` (Gmail q:) in
 * that case.
 */

export function registerSemanticSearchTools(): void {
  registerTool({
    name: 'inbox.semanticSearch',
    description:
      'Find inbox messages whose embeddings are nearest the query. Use for FUZZY intent queries ("emails asking me to do something", "anything about the basis school trip") that Gmail q: operators can\'t express. Falls back to keyword search if the embedding index is empty.',
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    handler: async ({ query, limit }, { userId }) => {
      if (!(await isEncoderAvailable())) {
        return {
          ok: false,
          reason: 'feature_disabled',
          message:
            'Embeddings are not enabled in this build. Use `inbox.search` with Gmail q: operators instead.',
        };
      }
      const hits = await semanticSearch(userId, query, limit ?? 10);
      if (hits.length === 0) {
        return {
          ok: true,
          hits: [],
          message: 'No embedded messages yet (indexer is still backfilling).',
        };
      }
      return { ok: true, hits };
    },
  });

  registerTool({
    name: 'inbox.similar',
    description:
      'Find inbox messages whose embeddings are nearest a source message. Use for "more like this" workflows: cluster newsletters, find duplicate threads, surface similar past correspondence.',
    inputSchema: z.object({
      messageId: z.string().describe('Source Gmail message id.'),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    handler: async ({ messageId, limit }, { userId }) => {
      if (!(await isEncoderAvailable())) {
        return { ok: false, reason: 'feature_disabled' };
      }
      const hits = await similar(userId, messageId, limit ?? 10);
      return { ok: true, hits };
    },
  });
}
