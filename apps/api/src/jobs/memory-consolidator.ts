import { z } from 'zod';
import { prisma } from '../db/client.js';
import { runClaudeJson } from '../claude/client.js';
import { logger } from '../logger.js';

/**
 * Periodic job that distils observed user behaviour (recent
 * AgentActions, Rule edits, EmailDecisions) into a compact
 * bullet-list memo on User.learnedMemory. The proposer + chat agent
 * read that memo via `effectiveGuidanceWithMemory` so future proposals
 * pick up patterns the user has demonstrated without being asked.
 *
 * Runs hourly via the existing scheduler-interval pattern (see
 * apps/api/src/jobs/scheduler.ts). One Claude Haiku call per user per
 * day at most — the run is cheap-skipped when no new audit rows have
 * landed since the last consolidation.
 */

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 30_000;
const INTERVAL_MS = 60 * 60 * 1000; // hourly check
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // re-consolidate at most once a day
const MIN_NEW_ROWS = 5; // skip when fewer than this many new rows

let started = false;
let timer: NodeJS.Timeout | null = null;

const ConsolidatedSchema = z.object({
  memo: z.string().min(1),
  patternsCount: z.number().int().min(0),
});

export function startMemoryConsolidator(): void {
  if (started) return;
  started = true;
  // Don't fire immediately on boot — give the rest of the system a
  // moment, and avoid running before any data has been collected.
  setTimeout(() => void tickAll(), 60_000);
  timer = setInterval(() => void tickAll(), INTERVAL_MS);
  logger.info({ intervalSec: INTERVAL_MS / 1000 }, 'memory consolidator started');
}

export function stopMemoryConsolidator(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export async function tickAll(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      timezone: true,
      learnedMemoryAt: true,
    },
  });
  for (const u of users) {
    try {
      await consolidateForUser(u.id);
    } catch (err) {
      logger.warn({ err, userId: u.id }, 'memory consolidator failed for user');
    }
  }
}

export type ConsolidationResult =
  | { ran: true; patternsCount: number; memo: string }
  | { ran: false; reason: string };

export async function consolidateForUser(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<ConsolidationResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, timezone: true, learnedMemoryAt: true, claudeModel: true },
  });
  if (!user) return { ran: false, reason: 'no_user' };

  const since = user.learnedMemoryAt ?? new Date(0);
  const sinceMs = Date.now() - since.getTime();
  if (!opts.force && sinceMs < MIN_INTERVAL_MS) {
    return { ran: false, reason: 'rate_limited' };
  }

  // Pull the recent activity that informs memory:
  //   - AgentActions: what the system actually did to mail
  //   - Rules: what the user has written + enabled
  //   - EmailDecisions: which rules matched what (samples)
  const [actions, rules, decisions] = await Promise.all([
    prisma.agentAction.findMany({
      where: { userId, createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.rule.findMany({
      where: { userId, enabled: true },
      orderBy: { position: 'asc' },
    }),
    prisma.emailDecision.findMany({
      where: { userId, createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  if (!opts.force && actions.length + decisions.length < MIN_NEW_ROWS) {
    return { ran: false, reason: 'insufficient_new_data' };
  }

  // Compact the inputs so the prompt fits comfortably under context.
  const actionsCompact = actions.map((a) => ({
    source: a.source,
    tool: a.toolName,
    target: a.targetType,
    targetId: a.targetId.slice(0, 12),
    reasoning: a.reasoning?.slice(0, 120) ?? null,
    reversed: a.reversedAt != null,
    at: a.createdAt.toISOString(),
  }));
  const rulesCompact = rules.map((r) => ({
    id: r.id.slice(0, 8),
    nl: r.naturalLanguage.slice(0, 200),
    actions: safeJson(r.actionsJson, []),
  }));
  const decisionsCompact = decisions.map((d) => ({
    matchedRules: safeJson<string[]>(d.matchedRuleIds, []).map((s) => s.slice(0, 8)),
    actionsApplied: safeJson(d.actionsApplied, []),
    reasoning: safeJson<unknown>(d.reasoning, []),
  }));

  const prompt = `You are the memory consolidator for an email automation product. Your
job is to look at what actions the system has actually taken on the
user's behalf and write a SHORT, CONCISE bullet list of patterns the
proposer should remember when drafting future rules.

Output rules:
  - Maximum 12 bullets. Aim for 6-8.
  - Each bullet describes a real behaviour pattern (e.g. "User
    consistently archives Substack newsletters within 1 hour", "User
    has reversed every snooze longer than 3 days").
  - Skip patterns that appear only once.
  - If the user has been REVERSING a pattern, NOTE it as a
    counter-preference ("User does NOT want X to happen automatically").
  - Don't enumerate the action data verbatim — distil it.
  - One short sentence per bullet. No nested structure.

User timezone: ${user.timezone}
Now: ${new Date().toISOString()}
Last consolidated: ${user.learnedMemoryAt?.toISOString() ?? 'never'}

Recent agent actions (max 200, newest first):
${JSON.stringify(actionsCompact)}

Active rules:
${JSON.stringify(rulesCompact)}

Recent classifier decisions (max 100, newest first):
${JSON.stringify(decisionsCompact)}

Respond with ONE JSON object, no fences, no prose:
  {
    "memo": "<bullet list, one per line, prefixed with '- '>",
    "patternsCount": <integer count of bullets in memo>
  }`;

  const result = await runClaudeJson(prompt, ConsolidatedSchema, {
    model: user.claudeModel ?? MODEL,
    timeoutMs: TIMEOUT_MS,
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      learnedMemory: result.memo.trim(),
      learnedMemoryAt: new Date(),
    },
  });

  return {
    ran: true,
    patternsCount: result.patternsCount,
    memo: result.memo.trim(),
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
