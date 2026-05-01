import { prisma } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Daily SQLite pruner. Without this, three tables grow unbounded on a
 * heavy-user install:
 *
 *   - `EmailDecision`  — classifier result cache; only useful within a
 *                        few weeks of the message arriving. Keep 30d.
 *   - `AgentAction`    — audit log. Keep 90d, but never prune the
 *                        `failed`/`pending` rows so investigations have
 *                        evidence regardless of age.
 *   - `ClassifyRun`    — run history shown in Settings. Keep 30d. The
 *                        in-memory registry already evicts after 1h;
 *                        this caps the persisted side.
 *
 * Run frequency: once an hour, but each table only actually deletes
 * once a day (cheap to run hourly because no rows match the predicate
 * the rest of the time).
 */

const TICK_MS = 60 * 60 * 1000;             // run every hour
const DAY = 24 * 60 * 60 * 1000;
const DECISION_KEEP_MS  = 30 * DAY;
const AUDIT_KEEP_MS     = 90 * DAY;
const RUN_HISTORY_KEEP  = 30 * DAY;

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startPruner(): void {
  if (started) return;
  started = true;
  // Start the first prune 5 minutes after boot so we don't pile onto
  // the rest of the boot path.
  setTimeout(() => void tick(), 5 * 60 * 1000);
  timer = setInterval(() => void tick(), TICK_MS);
  logger.info('sqlite pruner started');
}

export function stopPruner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export async function tick(): Promise<{
  decisions: number;
  audits: number;
  runs: number;
}> {
  const now = Date.now();

  const decisionCutoff = new Date(now - DECISION_KEEP_MS);
  const auditCutoff    = new Date(now - AUDIT_KEEP_MS);
  const runCutoff      = new Date(now - RUN_HISTORY_KEEP);

  let decisions = 0;
  let audits = 0;
  let runs = 0;

  try {
    const r1 = await prisma.emailDecision.deleteMany({
      where: { createdAt: { lt: decisionCutoff } },
    });
    decisions = r1.count;
  } catch (err) {
    logger.warn({ err }, 'pruner: decision delete failed');
  }

  try {
    // Keep `failed` / `pending` rows regardless of age — they are
    // forensic evidence for "what did the agent try?". Only sweep
    // applied audits and reversed audits (the user-facing log shows
    // the reversal, the original isn't load-bearing past 90 days).
    const r2 = await prisma.agentAction.deleteMany({
      where: {
        createdAt: { lt: auditCutoff },
        status: 'applied',
      },
    });
    audits = r2.count;
  } catch (err) {
    logger.warn({ err }, 'pruner: audit delete failed');
  }

  try {
    const r3 = await prisma.classifyRun.deleteMany({
      where: { startedAt: { lt: runCutoff }, status: { not: 'running' } },
    });
    runs = r3.count;
  } catch (err) {
    logger.warn({ err }, 'pruner: classify-run delete failed');
  }

  if (decisions + audits + runs > 0) {
    logger.info({ decisions, audits, runs }, 'pruner deleted old rows');
  }
  return { decisions, audits, runs };
}
