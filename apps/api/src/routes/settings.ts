import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { DEFAULT_AI_GUIDANCE, effectiveGuidance } from '../claude/ai-guidance.js';
import { consolidateForUser } from '../jobs/memory-consolidator.js';
import { logger } from '../logger.js';

export const settingsRouter: RouterT = Router();

settingsRouter.use(requireUser);

const SELECT = {
  pollIntervalSec: true,
  timezone: true,
  claudeModel: true,
  aiGuidance: true,
  learnedMemory: true,
  learnedMemoryAt: true,
} as const;

settingsRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: SELECT });
  if (!user) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Surface both the user's override (so the textarea can show their
  // edits) and the effective text (what the proposer actually sees).
  // The default is exposed separately so the UI can offer "reset to
  // default" without making a round-trip.
  res.json({
    ...user,
    learnedMemoryAt: user.learnedMemoryAt?.toISOString() ?? null,
    aiGuidanceEffective: effectiveGuidance(user.aiGuidance),
    aiGuidanceDefault: DEFAULT_AI_GUIDANCE.trim(),
  });
});

const UpdateSchema = z.object({
  pollIntervalSec: z.number().int().min(60).max(3600).optional(),
  // Null clears the override and falls back to the CLI default. A non-empty
  // string is the model id passed to `claude -p --model`.
  claudeModel: z.union([z.string().min(1), z.null()]).optional(),
  // Null clears the override and the proposer falls back to
  // DEFAULT_AI_GUIDANCE. Non-empty string overrides verbatim.
  aiGuidance: z.union([z.string(), z.null()]).optional(),
});

settingsRouter.put('/', async (req, res) => {
  const userId = getUserId(req);
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }
  const user = await prisma.user.update({
    where: { id: userId },
    data: parsed.data,
    select: SELECT,
  });
  res.json({
    ...user,
    learnedMemoryAt: user.learnedMemoryAt?.toISOString() ?? null,
    aiGuidanceEffective: effectiveGuidance(user.aiGuidance),
    aiGuidanceDefault: DEFAULT_AI_GUIDANCE.trim(),
  });
});

/**
 * POST /api/settings/consolidate-memory — manually trigger the memory
 * consolidator for the current user. Bypasses the rate-limit so it
 * runs even right after the last automatic pass; useful for testing
 * and the "Refresh now" button in Settings → AI guidance.
 */
settingsRouter.post('/consolidate-memory', async (req, res) => {
  const userId = getUserId(req);
  try {
    const result = await consolidateForUser(userId, { force: true });
    res.json(result);
  } catch (err) {
    logger.error({ err, userId }, 'manual memory consolidation failed');
    res.status(500).json({
      error: 'consolidate_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
