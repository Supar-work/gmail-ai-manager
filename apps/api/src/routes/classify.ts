import { randomBytes } from 'node:crypto';
import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { requireUser, getUserId } from '../auth/middleware.js';
import { classifyRecent } from '../classify/run.js';
import {
  createRun,
  getRun,
  pushEvent,
  pushAction,
  updateCounts,
  finishRun,
  shouldContinue,
  sweepOldRuns,
} from '../classify/registry.js';
import { prisma } from '../db/client.js';
import { logger } from '../logger.js';

export const classifyRouter: RouterT = Router();

classifyRouter.use(requireUser);

const RunSchema = z.object({
  maxMessages: z.number().int().min(1).max(5000).optional(),
  ruleIds: z.array(z.string()).optional(),
});

classifyRouter.post('/run', async (req, res) => {
  const userId = getUserId(req);
  const parsed = RunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }

  const runId = randomBytes(12).toString('base64url');
  createRun(runId, userId);
  sweepOldRuns();

  const ruleIdsJson = parsed.data.ruleIds?.length ? JSON.stringify(parsed.data.ruleIds) : null;
  await prisma.classifyRun.create({
    data: {
      id: runId,
      userId,
      trigger: 'manual',
      status: 'running',
      ruleIds: ruleIdsJson,
    },
  });

  res.json({ runId });

  void (async () => {
    let finalStatus: 'done' | 'error' | 'stopped' = 'done';
    let finalError: string | undefined;
    try {
      const result = await classifyRecent(userId, {
        maxMessages: parsed.data.maxMessages,
        ruleIds: parsed.data.ruleIds,
        trigger: 'manual',
        sink: {
          event: (msg, level) => pushEvent(runId, msg, level ?? 'info'),
          counts: (c) =>
            updateCounts(runId, {
              scanned: c.scanned,
              matched: c.matched,
              applied: c.applied,
              scheduled: c.scheduled,
              skipped: c.skippedAlreadySeen,
            }),
          action: (a) => pushAction(runId, a),
          shouldContinue: () => shouldContinue(runId),
        },
      });
      const state = getRun(runId);
      if (state?.control === 'stopping') {
        finalStatus = 'stopped';
      }
      finishRun(runId, finalStatus);
      await prisma.classifyRun.update({
        where: { id: runId },
        data: {
          status: finalStatus,
          finishedAt: new Date(),
          scanned: result.scanned,
          matched: result.matched,
          applied: result.applied,
          scheduled: result.scheduled,
          skipped: result.skippedAlreadySeen,
          logJson: JSON.stringify(getRun(runId)?.events ?? []),
        },
      });
    } catch (err) {
      finalStatus = 'error';
      finalError = err instanceof Error ? err.message : String(err);
      pushEvent(runId, `error: ${finalError}`, 'error');
      finishRun(runId, 'error', finalError);
      logger.error({ err, userId, runId }, 'classify run failed');
      await prisma.classifyRun
        .update({
          where: { id: runId },
          data: {
            status: 'error',
            finishedAt: new Date(),
            errorMsg: finalError,
            logJson: JSON.stringify(getRun(runId)?.events ?? []),
          },
        })
        .catch(() => {});
    }
  })();
});
