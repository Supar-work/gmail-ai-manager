import { z } from 'zod';
import { ActionSchema, type Action } from '@gam/shared';
import { runClaudeJson } from './client.js';
import { prisma } from '../db/client.js';

/**
 * Periodic / on-demand audit of the user's AI-rule list. Claude looks
 * at every enabled (and recently-disabled) rule alongside its match
 * history + any reversed actions and recommends edits — merge near-
 * duplicates, sharpen overly-broad rules, simplify hard-to-read NL,
 * convert from:<list-address> predicates to list:<id> for mailing-
 * list mail, disable dead rules, and split conflated intents.
 *
 * The user reviews recommendations one-by-one in Settings → Rule
 * maintenance and applies them individually. Each apply writes to
 * the AgentAction audit log with source='maintenance'.
 */

const MODEL = 'claude-haiku-4-5-20251001';
// Cold-start spawn from the api context plus a context-heavy prompt
// (every rule + samples + reversal counts) means the analyze call
// regularly takes >90s on larger inboxes. 240s gives generous
// headroom; the only downside is the user waits longer when something
// genuinely goes wrong.
const TIMEOUT_MS = 240_000;
const DECISIONS_LOOKBACK_DAYS = 30;
const SAMPLES_PER_RULE = 3;
/** Hard cap on total sample messages we'll fetch + serialise into the
 *  prompt — keeps payload + Claude latency bounded on rule-heavy
 *  inboxes. Prefers most-recent decisions. */
const MAX_TOTAL_SAMPLES = 80;

export const RecommendationKindSchema = z.enum([
  'merge',
  'sharpen',
  'simplify',
  'list_aware',
  'disable',
  'split',
]);
export type RecommendationKind = z.infer<typeof RecommendationKindSchema>;

const ProposedRuleSchema = z.object({
  naturalLanguage: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
});
export type ProposedRule = z.infer<typeof ProposedRuleSchema>;

export const RecommendationSchema = z.object({
  kind: RecommendationKindSchema,
  /**
   * Rule.id values touched by this recommendation. Cardinality:
   *   merge       — 2 or more inputs (collapsed into proposed[0])
   *   sharpen     — exactly 1 (replaced by proposed[0])
   *   simplify    — exactly 1 (replaced by proposed[0])
   *   list_aware  — exactly 1 (replaced by proposed[0])
   *   disable     — 1 or more (each set enabled=false; proposed empty)
   *   split       — exactly 1 (deleted, replaced by proposed[*])
   */
  affectedRuleIds: z.array(z.string().min(1)).min(1),
  /** Human-readable rationale shown next to the Apply button. */
  rationale: z.string().min(1),
  /** 0–1 confidence used to sort recommendations and grey out low-confidence ones. */
  confidence: z.number().min(0).max(1),
  /** Empty for 'disable'. Length 1 for everything except 'split'. */
  proposed: z.array(ProposedRuleSchema).optional(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const AnalysisSchema = z.object({
  recommendations: z.array(RecommendationSchema),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ── Analyze ─────────────────────────────────────────────────────────

export type AnalyzeArgs = {
  userId: string;
  /** Override claude-p model (e.g. user.claudeModel). Falls back to MODEL. */
  model?: string;
};

export async function analyzeRules(args: AnalyzeArgs): Promise<Analysis> {
  const { userId } = args;
  const model = args.model ?? MODEL;

  const rules = await prisma.rule.findMany({
    where: { userId },
    orderBy: { position: 'asc' },
  });
  if (rules.length === 0) {
    return { recommendations: [] };
  }

  const since = new Date(Date.now() - DECISIONS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Pull matched decisions in the lookback window. We only need the
  // matchedRuleIds + a tiny per-message sample (from/subject/listId)
  // so Claude can see what the rule's been firing on.
  const decisions = await prisma.emailDecision.findMany({
    where: { userId, createdAt: { gt: since } },
    orderBy: { createdAt: 'desc' },
    select: {
      matchedRuleIds: true,
      gmailMessageId: true,
    },
    take: 2000,
  });

  // Pull sample messages for each rule, plus stats.
  const decisionsByRule = new Map<string, { count: number; sampleIds: string[] }>();
  for (const d of decisions) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(d.matchedRuleIds) as unknown;
      if (Array.isArray(parsed)) {
        ids = parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      /* skip malformed */
    }
    for (const id of ids) {
      const acc = decisionsByRule.get(id) ?? { count: 0, sampleIds: [] };
      acc.count++;
      if (acc.sampleIds.length < SAMPLES_PER_RULE) acc.sampleIds.push(d.gmailMessageId);
      decisionsByRule.set(id, acc);
    }
  }

  // Collapse to a global cap so rule-heavy inboxes don't blow up the
  // prompt size + latency. We give each rule its share fairly: walk
  // the rules round-robin, taking one sample per rule per pass until
  // we hit MAX_TOTAL_SAMPLES.
  const allSampleIds: string[] = [];
  const ruleIdsList = Array.from(decisionsByRule.keys());
  for (
    let pass = 0;
    pass < SAMPLES_PER_RULE && allSampleIds.length < MAX_TOTAL_SAMPLES;
    pass++
  ) {
    for (const rid of ruleIdsList) {
      if (allSampleIds.length >= MAX_TOTAL_SAMPLES) break;
      const ids = decisionsByRule.get(rid)?.sampleIds;
      if (ids && ids[pass] && !allSampleIds.includes(ids[pass]!)) {
        allSampleIds.push(ids[pass]!);
      }
    }
  }
  const sampleMessages = allSampleIds.length
    ? await prisma.inboxMessage.findMany({
        where: { userId, gmailMessageId: { in: allSampleIds } },
        select: {
          gmailMessageId: true,
          fromHeader: true,
          subject: true,
          listId: true,
          originalFromHeader: true,
        },
      })
    : [];
  const sampleById = new Map(sampleMessages.map((m) => [m.gmailMessageId, m]));

  // Reversal stats — when the user undoes a rule's action via the
  // audit log, it's a strong signal the rule misfired.
  const reversals = await prisma.agentAction.findMany({
    where: {
      userId,
      source: 'rule',
      reversedAt: { not: null, gt: since },
    },
    select: { sourceId: true },
  });
  const reversalsByRule = new Map<string, number>();
  for (const r of reversals) {
    if (!r.sourceId) continue;
    reversalsByRule.set(r.sourceId, (reversalsByRule.get(r.sourceId) ?? 0) + 1);
  }

  const ruleBlocks = rules.map((r) => {
    const stats = decisionsByRule.get(r.id) ?? { count: 0, sampleIds: [] };
    // Keep at most SAMPLES_PER_RULE per rule, AND skip messages that
    // didn't make the global cap (sampleById will be missing them).
    const samples = stats.sampleIds.slice(0, SAMPLES_PER_RULE).flatMap((mid) => {
      const m = sampleById.get(mid);
      if (!m) return [];
      // Trim subject + drop snippet; the from + listId + subject is
      // enough signal for "is this rule firing on the right class".
      return [
        {
          from: (m.fromHeader ?? '').slice(0, 120),
          subject: (m.subject ?? '').slice(0, 120),
          listId: m.listId,
          originalFrom: m.originalFromHeader,
        },
      ];
    });
    return {
      id: r.id,
      enabled: r.enabled,
      position: r.position,
      naturalLanguage: r.naturalLanguage,
      actions: safeJson<unknown>(r.actionsJson, []),
      stats: {
        matchedInLast30Days: stats.count,
        reversedInLast30Days: reversalsByRule.get(r.id) ?? 0,
      },
      sampleEmails: samples,
    };
  });

  const prompt = buildPrompt(ruleBlocks);
  return runClaudeJson(prompt, AnalysisSchema, { model, timeoutMs: TIMEOUT_MS });
}

function buildPrompt(rules: unknown[]): string {
  return `You are the rule-maintenance auditor for a personal Gmail
automation tool. The user has a list of natural-language rules; each
matches incoming email through a per-message Claude classifier call.
Your job: review the rules, their match history, and any reversed
actions, and recommend edits that make the rule list cheaper to run
and easier to read.

Recommendation kinds:
  • merge       — two or more rules describe the same class of email;
                  collapse into one (proposed[0]). Cardinality of
                  affectedRuleIds: ≥ 2.
  • sharpen     — one rule fires too broadly (look at the sample
                  emails — do they share a coherent class? if not,
                  the rule needs a tighter predicate). Replace its
                  NL with proposed[0]. affectedRuleIds: exactly 1.
  • simplify    — one rule's NL is hard to read but the predicate is
                  fine. Rewrite proposed[0] in clearer English without
                  changing meaning. affectedRuleIds: exactly 1.
  • list_aware  — one rule keys off a sender address (\`from:foo@…\`)
                  that's actually a mailing-list / Google-Group
                  forwarding alias. Sample emails will have a
                  non-null \`listId\`. Replace with a \`list:<listId>\`
                  predicate (much faster, no per-email Claude needed
                  to interpret semantic intent). affectedRuleIds: 1.
  • disable     — one or more rules haven't matched anything in the
                  last 30 days, or their action set is empty/no-op.
                  Set enabled=false. proposed empty. affectedRuleIds: 1+.
  • split       — one rule conflates two distinct intents (samples
                  show two clearly different classes). Replace with
                  proposed[0..N]. affectedRuleIds: exactly 1.

Output rules:
  • Up to ~12 recommendations. Quality > quantity. Skip when nothing
    obvious applies.
  • For mailing-list awareness: when sample emails have \`listId\` set
    AND \`originalFrom\` differs from \`from\`, that's the canonical
    "rewrite via list" case — switch the rule from \`from:<list>\` to
    \`list:<listId>\` and use the \`originalFrom\`'s brand in the NL
    + label.
  • Confidence: 0.85+ = clearly safe, 0.6 = worth showing, < 0.5 =
    don't emit.
  • rationale: ONE short sentence the user will see ("Both rules
    catch GitHub OAuth notifications — merge into one.").
  • naturalLanguage in proposed entries should follow the same style
    as existing rules: "When email is from X, do Y, and do Z."

Action shape (subset of the larger schema — emit only these fields):
  { "type": "addLabel",      "labelName": "Foo/Bar" }
  { "type": "removeLabel",   "labelName": "INBOX" }
  { "type": "archive" }
  { "type": "markRead" }
  { "type": "star" }
  { "type": "markImportant" }
  { "type": "forward",       "to": "addr@example.com" }
NEVER emit { "type": "trash" } — this app does not delete mail.

CONTEXT (rules + last-30-day stats + sample emails):
${JSON.stringify(rules, null, 2)}

Respond with ONE JSON object, no fences, no prose:
{
  "recommendations": [
    {
      "kind": "<one of: merge|sharpen|simplify|list_aware|disable|split>",
      "affectedRuleIds": ["<Rule.id>", ...],
      "rationale": "<one short sentence>",
      "confidence": <0..1>,
      "proposed": [
        { "naturalLanguage": "<...>", "actions": [...] }
      ]
    },
    ...
  ]
}`;
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ── Apply ───────────────────────────────────────────────────────────

export type ApplyResult = {
  applied: boolean;
  /** Rule.id values that were created or updated. */
  newRuleIds: string[];
  /** Rule.id values that were deleted or disabled. */
  removedRuleIds: string[];
  message: string;
};

/**
 * Persist a single recommendation. Idempotency / concurrency are the
 * caller's problem — the route serialises by recommendation id.
 *
 * Doesn't write the AgentAction audit row — the route does that with
 * the right sourceId so the audit log surface stays consistent.
 */
export async function applyRecommendation(
  userId: string,
  rec: Recommendation,
): Promise<ApplyResult> {
  // Validate that all affected rules belong to this user. Defence-
  // in-depth — the route already filters but safer to recheck.
  const affected = await prisma.rule.findMany({
    where: { userId, id: { in: rec.affectedRuleIds } },
  });
  if (affected.length !== rec.affectedRuleIds.length) {
    return {
      applied: false,
      newRuleIds: [],
      removedRuleIds: [],
      message: 'one or more rules not found',
    };
  }

  const proposed = rec.proposed ?? [];

  switch (rec.kind) {
    case 'sharpen':
    case 'simplify':
    case 'list_aware': {
      if (proposed.length !== 1 || affected.length !== 1) {
        return {
          applied: false,
          newRuleIds: [],
          removedRuleIds: [],
          message: 'invalid cardinality for in-place rewrite',
        };
      }
      const target = affected[0]!;
      const next = proposed[0]!;
      const updated = await prisma.rule.update({
        where: { id: target.id },
        data: {
          naturalLanguage: next.naturalLanguage,
          actionsJson: JSON.stringify(next.actions as Action[]),
        },
      });
      return {
        applied: true,
        newRuleIds: [updated.id],
        removedRuleIds: [],
        message: `rule ${target.id} updated`,
      };
    }

    case 'merge': {
      if (proposed.length !== 1 || affected.length < 2) {
        return {
          applied: false,
          newRuleIds: [],
          removedRuleIds: [],
          message: 'invalid cardinality for merge',
        };
      }
      const keep = affected[0]!;
      const drop = affected.slice(1);
      const next = proposed[0]!;
      await prisma.$transaction(async (tx) => {
        await tx.rule.update({
          where: { id: keep.id },
          data: {
            naturalLanguage: next.naturalLanguage,
            actionsJson: JSON.stringify(next.actions as Action[]),
          },
        });
        await tx.rule.deleteMany({
          where: { id: { in: drop.map((r) => r.id) } },
        });
      });
      return {
        applied: true,
        newRuleIds: [keep.id],
        removedRuleIds: drop.map((r) => r.id),
        message: `merged ${affected.length} rules into ${keep.id}`,
      };
    }

    case 'split': {
      if (proposed.length < 2 || affected.length !== 1) {
        return {
          applied: false,
          newRuleIds: [],
          removedRuleIds: [],
          message: 'invalid cardinality for split',
        };
      }
      const source = affected[0]!;
      const created: string[] = [];
      await prisma.$transaction(async (tx) => {
        const max = await tx.rule.aggregate({
          where: { userId },
          _max: { position: true },
        });
        let pos = (max._max.position ?? source.position) + 1;
        for (const p of proposed) {
          const r = await tx.rule.create({
            data: {
              userId,
              naturalLanguage: p.naturalLanguage,
              actionsJson: JSON.stringify(p.actions as Action[]),
              position: pos++,
              enabled: source.enabled,
            },
          });
          created.push(r.id);
        }
        await tx.rule.delete({ where: { id: source.id } });
      });
      return {
        applied: true,
        newRuleIds: created,
        removedRuleIds: [source.id],
        message: `split ${source.id} into ${created.length} rules`,
      };
    }

    case 'disable': {
      const updated = await prisma.rule.updateMany({
        where: { id: { in: affected.map((r) => r.id) } },
        data: { enabled: false },
      });
      return {
        applied: true,
        newRuleIds: [],
        removedRuleIds: affected.map((r) => r.id),
        message: `disabled ${updated.count} rule${updated.count === 1 ? '' : 's'}`,
      };
    }
  }
}
