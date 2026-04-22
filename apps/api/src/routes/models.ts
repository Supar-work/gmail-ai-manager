import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import { logger } from '../logger.js';
import { runClaudeJson } from '../claude/client.js';

export const modelsRouter: RouterT = Router();

modelsRouter.use(requireUser);

export type ModelOption = {
  id: string;
  displayName: string;
  family: 'haiku' | 'sonnet' | 'opus' | 'other';
  hint?: string;
  recommended?: boolean;
};

type ModelsResponse = {
  models: ModelOption[];
  source: 'claude' | 'curated';
};

/**
 * The Anthropic Models API (`/v1/models`) is auth-gated and the Claude Code
 * CLI's OAuth scopes don't grant access to it (verified empirically — every
 * variant of the Bearer + beta header is rejected). Rather than ask users to
 * paste an API key, we just ask `claude -p` itself for the model list. The
 * model has high recall for its sibling IDs and the catalog only changes
 * roughly monthly, so we cache the answer for a day.
 */
const CURATED: ModelOption[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    family: 'haiku',
    recommended: true,
  },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', family: 'sonnet' },
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', family: 'opus' },
];

const ClaudeListSchema = z.object({
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        display_name: z.string().min(1),
        family: z.enum(['haiku', 'sonnet', 'opus']).optional(),
        release: z.string().optional(),
      }),
    )
    .min(1),
});

const PROMPT = `List every Claude model currently available for the Anthropic Messages API.
Respond with ONLY a JSON object, no prose, no code fences:
{"models":[{"id":"<exact api id>","display_name":"<short name>","family":"haiku|sonnet|opus","release":"<YYYY-MM>"}]}
- Include every Claude 4.x and newer model.
- Use the exact API id (e.g. "claude-haiku-4-5-20251001", "claude-sonnet-4-6").
- Do NOT invent models you are not certain exist.
- Order newest first.`;

// 24h for a real list, only 5min for the curated fallback so we retry the
// live fetch frequently when something went wrong.
const TTL_SUCCESS_MS = 24 * 60 * 60 * 1000;
const TTL_FALLBACK_MS = 5 * 60 * 1000;
// Always Haiku — listing siblings is a tiny task and latency matters here
// (users hit this when they open Settings). Doesn't depend on user prefs.
const LIST_MODEL = 'claude-haiku-4-5-20251001';
const LIST_TIMEOUT_MS = 60_000;
let cache: { at: number; data: ModelsResponse } | null = null;

modelsRouter.get('/', async (_req, res) => {
  if (cache) {
    const ttl = cache.data.source === 'claude' ? TTL_SUCCESS_MS : TTL_FALLBACK_MS;
    if (Date.now() - cache.at < ttl) {
      res.json(cache.data);
      return;
    }
  }

  let response: ModelsResponse;
  try {
    const parsed = await runClaudeJson(PROMPT, ClaudeListSchema, {
      model: LIST_MODEL,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const models = parsed.models.map((m) => annotate(m));
    response = { models, source: 'claude' };
  } catch (err) {
    logger.warn({ err }, 'claude model list failed; using curated fallback');
    response = { models: CURATED, source: 'curated' };
  }

  cache = { at: Date.now(), data: response };
  res.json(response);
});

function familyOf(id: string): ModelOption['family'] {
  if (/haiku/i.test(id)) return 'haiku';
  if (/sonnet/i.test(id)) return 'sonnet';
  if (/opus/i.test(id)) return 'opus';
  return 'other';
}

function annotate(m: { id: string; display_name: string; family?: string }): ModelOption {
  const family = (m.family as ModelOption['family']) ?? familyOf(m.id);
  return {
    id: m.id,
    displayName: m.display_name,
    family,
    recommended: family === 'haiku',
    hint:
      family === 'haiku'
        ? 'Fast, cheap — recommended for classification.'
        : family === 'sonnet'
          ? 'Stronger reasoning, slower and costlier.'
          : family === 'opus'
            ? 'Most capable, expensive.'
            : undefined,
  };
}

/** Exposed for tests / manual cache reset. */
export function resetModelsCache(): void {
  cache = null;
}
