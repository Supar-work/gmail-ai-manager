import { z } from 'zod';
import { ActionSchema, type Action, type CleanupSample, type RefineAudit } from '@gam/shared';
import { runClaudeJson } from './client.js';
import { logger } from '../logger.js';

/**
 * Propose an AI rule for a single inbox email, then evaluate the proposal
 * against the rule's match set and refine if Claude thinks the group is
 * incoherent. Capped at 2 refine iterations to bound Claude cost.
 *
 * The whole loop is server-side so the frontend sees a single
 * `POST /propose` call that returns a fully-evaluated proposal.
 */

const MODEL = 'claude-haiku-4-5-20251001';
const PROPOSE_TIMEOUT_MS = 45_000;
const EVAL_TIMEOUT_MS = 30_000;
const MAX_REFINE_ITERATIONS = 2;

/** Input email as the propose prompt sees it. */
export type EmailForProposal = {
  messageId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  labels: string[];
  date: string | null;
};

const ProposeResponseSchema = z.object({
  naturalLanguage: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
  gmailQuery: z.string().min(1),
  groupDescription: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
});
export type ProposeResponse = z.infer<typeof ProposeResponseSchema>;

const EvaluateResponseSchema = z.object({
  verdict: z.enum(['good', 'refine']),
  // Make optional so runClaudeJson's generic inference doesn't collide
  // with zod's transform input/output types; normalize at the callsite.
  note: z.string().optional(),
});
export type EvaluateResponse = {
  verdict: 'good' | 'refine';
  note: string;
};

/**
 * Translate an edited natural-language rule into a Gmail `q:` search
 * query. Used by the preview-matches endpoint when the user edits the
 * rule text in the wizard — we can't just reuse the old query.
 */
const QueryOnlySchema = z.object({
  gmailQuery: z.string().min(1),
});
export type QueryOnlyResponse = z.infer<typeof QueryOnlySchema>;

// ── Prompts ────────────────────────────────────────────────────────────────

const COMMON_ACTION_GUIDANCE = `Action shape (discriminated by "type", zero or more per rule):
  { type:"addLabel",       labelName:"Parent/Child", runAt?:<RunAt> }
  { type:"removeLabel",    labelName:"X",            runAt?:<RunAt> }
  { type:"archive",        runAt?:<RunAt> }
  { type:"markRead",       runAt?:<RunAt> }
  { type:"star",           runAt?:<RunAt> }
  { type:"markImportant",  runAt?:<RunAt> }
  { type:"forward", to:"addr@example.com", runAt?:<RunAt> }

RunAt variants (all optional — omitting means immediate):
  { kind:"immediate" }
  { kind:"endOfDay" }
  { kind:"endOfNextBusinessDay" }
  { kind:"relative", minutes?:N, hours?:N, days?:N }     // N ≥ 0
  { kind:"atTime", iso:"YYYY-MM-DDTHH:MM:SSZ" }          // UTC
  { kind:"contentDerived", hint:"when OTP expires" }

NEVER emit { type:"trash" }. Archive is the strongest allowed action.

Snooze pattern — when the rule should hide an email until a specific future
time and bring it back to the inbox:
  [
    { type:"addLabel",    labelName:"snooze/<iso>",             runAt:{ kind:"immediate" } },
    { type:"archive",                                           runAt:{ kind:"immediate" } },
    { type:"addLabel",    labelName:"INBOX",                    runAt:{ kind:"atTime", iso:"<iso>" } },
    { type:"removeLabel", labelName:"snooze/<iso>",             runAt:{ kind:"atTime", iso:"<iso>" } }
  ]
<iso> is the wake-up moment in UTC ISO-8601 (no milliseconds, Z suffix).

Gmail query — the "gmailQuery" field must be a valid Gmail search
expression ("from:", "to:", "subject:", "list:", "has:", "newer_than:",
"-label:", parens, OR). Prefer precise predicates (exact sender address,
exact list-id, narrow subject) over broad ones so we don't sweep up
unrelated mail. Do NOT include "in:inbox" — the caller adds scope itself.

Labels — prefer canonical two-level paths like
  Newsletters/<Brand>
  Receipts/<Vendor>
  Subscriptions/<Service>
  Work/<Company>
  Notifications/<Source>
  Finance/<Institution>
  Shopping/<Retailer>
  Travel/<Destination>
  Family/<Person>
Use title case for the sub-category.`;

function buildProposePrompt(args: {
  email: EmailForProposal;
  nowIso: string;
  timezone: string;
  previousAttempt?: {
    rule: string;
    gmailQuery: string;
    evaluatorNote: string;
    sampleSummary: string;
  };
}): string {
  const { email, nowIso, timezone, previousAttempt } = args;

  const emailBlock = JSON.stringify(
    {
      from: email.from,
      to: email.to,
      subject: email.subject,
      labels: email.labels,
      date: email.date,
      bodyExcerpt: (email.body ?? email.snippet ?? '').slice(0, 1200),
    },
    null,
    2,
  );

  const refineBlock = previousAttempt
    ? `
Your previous proposal was rejected by the evaluator. Produce a new one.
Previous rule:  ${JSON.stringify(previousAttempt.rule)}
Previous query: ${JSON.stringify(previousAttempt.gmailQuery)}
Evaluator note: ${JSON.stringify(previousAttempt.evaluatorNote)}
Sample matches it swept up:
${previousAttempt.sampleSummary}

Adjust the query so it captures only the coherent group (tighten, broaden,
or rename as needed). If no coherent group can be defined for this email,
return a more specific rule that at least matches this one email correctly.
`
    : '';

  return `You are drafting an AI rule for an email-automation product that is
helping the user clean up their Gmail inbox one email at a time. For this
single inbox email, produce:
  1. a short natural-language rule (one sentence) describing the class of
     emails this rule handles and what to do with them,
  2. a list of Gmail actions (schema below),
  3. a Gmail search query that should match the same class of emails,
  4. a one-phrase group description (e.g. "Substack weekly digests"),
  5. a confidence between 0 and 1.

Current time (UTC): ${nowIso}
User timezone:      ${timezone}

${COMMON_ACTION_GUIDANCE}
${refineBlock}
THE EMAIL:
${emailBlock}

Respond with ONE JSON object, no code fences, no prose:
{
  "naturalLanguage": "<rule in plain English, max ~160 chars>",
  "actions": [ ...ActionSchema... ],
  "gmailQuery": "<Gmail search q:>",
  "groupDescription": "<short label for this group>",
  "confidence": <0..1>,
  "reasoning": "<one short sentence: why these actions + this query>"
}`;
}

function buildEvaluatePrompt(args: {
  rule: string;
  gmailQuery: string;
  samples: CleanupSample[];
  totals: { inbox: number; allMail: number };
  sourceEmail: EmailForProposal;
}): string {
  const { rule, gmailQuery, samples, totals, sourceEmail } = args;
  const sampleLines =
    samples.length === 0
      ? '(no matches at all — the query is probably too narrow or wrong)'
      : samples
          .slice(0, 15)
          .map(
            (s, i) =>
              `${i + 1}. ${s.inInbox ? '●' : '○'} From: ${s.from ?? '?'}\n   Subject: ${
                s.subject ?? '?'
              }\n   Snippet: ${(s.snippet ?? '').slice(0, 140)}`,
          )
          .join('\n');

  return `You are the evaluator step in an iterative rule-refinement loop. A
Claude instance just proposed a rule and a Gmail search query from a
single inbox email. You look at the match set the query produced and
decide whether the group is coherent enough to ship to the user.

Source email the rule was proposed from:
  From:    ${sourceEmail.from ?? '?'}
  Subject: ${sourceEmail.subject ?? '?'}
  Snippet: ${(sourceEmail.snippet ?? '').slice(0, 200)}

Proposed rule:    ${JSON.stringify(rule)}
Proposed query:   ${JSON.stringify(gmailQuery)}
Match counts:     in-inbox=${totals.inbox}  all-mail=${totals.allMail}

Up-to-15 samples (● in-inbox, ○ archived/elsewhere):
${sampleLines}

Return ONE JSON object, no fences, no prose:
  { "verdict": "good" | "refine", "note": "<short reason, <= 200 chars>" }

Use "good" when:
  - The samples clearly all belong to the same class as the source email,
    and the rule's description matches them, OR
  - The match set is small and tightly focused (even 1-2 matches is fine
    if they are obviously the same class).

Use "refine" when:
  - The samples span multiple unrelated classes (query too broad), OR
  - The query returns 0 matches or misses obvious siblings, OR
  - The source email itself would not match the query, OR
  - The group is hard to describe in one sentence.

Prefer "good" when in doubt — we only get two refine attempts.`;
}

// ── Public entry points ────────────────────────────────────────────────────

export type ProposeAndRefineArgs = {
  email: EmailForProposal;
  nowIso: string;
  timezone: string;
  /**
   * Called to execute the Gmail query after each proposal iteration.
   * The caller owns the Gmail client; we don't import it here so this
   * module stays easy to unit-test with stubs.
   */
  searchMatches: (gmailQuery: string) => Promise<{
    samples: CleanupSample[];
    totals: { inbox: number; allMail: number };
  }>;
  model?: string;
};

export type ProposeAndRefineResult = ProposeResponse & {
  samples: CleanupSample[];
  totals: { inbox: number; allMail: number };
  refineHistory: RefineAudit[];
};

/**
 * Propose → search → evaluate → refine loop. Returns the final accepted
 * proposal plus the audit trail of any refinement iterations.
 */
export async function proposeAndRefine(
  args: ProposeAndRefineArgs,
): Promise<ProposeAndRefineResult> {
  const { email, nowIso, timezone, searchMatches } = args;
  const model = args.model ?? MODEL;

  const refineHistory: RefineAudit[] = [];
  let current: ProposeResponse | null = null;
  let currentMatches: {
    samples: CleanupSample[];
    totals: { inbox: number; allMail: number };
  } | null = null;
  let previousAttempt: ProposeAndRefineArgs['email'] extends never
    ? never
    :
        | undefined
        | {
            rule: string;
            gmailQuery: string;
            evaluatorNote: string;
            sampleSummary: string;
          } = undefined;

  for (let attempt = 1; attempt <= MAX_REFINE_ITERATIONS + 1; attempt++) {
    const proposePrompt = buildProposePrompt({
      email,
      nowIso,
      timezone,
      previousAttempt,
    });
    current = await runClaudeJson(proposePrompt, ProposeResponseSchema, {
      model,
      timeoutMs: PROPOSE_TIMEOUT_MS,
    });

    currentMatches = await searchMatches(current.gmailQuery);

    // On the last allowed attempt, accept whatever we got — no more refines.
    if (attempt > MAX_REFINE_ITERATIONS) break;

    const evalPrompt = buildEvaluatePrompt({
      rule: current.naturalLanguage,
      gmailQuery: current.gmailQuery,
      samples: currentMatches.samples,
      totals: currentMatches.totals,
      sourceEmail: email,
    });

    let verdict: EvaluateResponse;
    try {
      const raw = await runClaudeJson(evalPrompt, EvaluateResponseSchema, {
        model,
        timeoutMs: EVAL_TIMEOUT_MS,
      });
      verdict = { verdict: raw.verdict, note: raw.note ?? '' };
    } catch (err) {
      // Fail open — if the evaluator can't be reached, accept this proposal
      // rather than lose all the work. Log so we can see how often.
      logger.warn(
        { err: String(err), messageId: email.messageId, attempt },
        'inbox-cleanup evaluate failed; accepting current proposal',
      );
      break;
    }

    if (verdict.verdict === 'good') break;

    refineHistory.push({
      attempt,
      previousRule: current.naturalLanguage,
      previousQuery: current.gmailQuery,
      verdict: 'refine',
      note: verdict.note,
    });
    previousAttempt = {
      rule: current.naturalLanguage,
      gmailQuery: current.gmailQuery,
      evaluatorNote: verdict.note,
      sampleSummary: buildSampleSummary(currentMatches.samples),
    };
  }

  if (!current || !currentMatches) {
    // Should never happen — runClaudeJson would have thrown.
    throw new Error('inbox_cleanup_propose_produced_nothing');
  }

  return {
    ...current,
    samples: currentMatches.samples,
    totals: currentMatches.totals,
    refineHistory,
  };
}

function buildSampleSummary(samples: CleanupSample[]): string {
  if (samples.length === 0) return '(no matches)';
  return samples
    .slice(0, 10)
    .map(
      (s, i) =>
        `  ${i + 1}. ${s.inInbox ? '●' : '○'} ${s.from ?? '?'} — ${s.subject ?? '?'}`,
    )
    .join('\n');
}

// ── Rule-only → Gmail query for user edits ─────────────────────────────────

export async function proposeQueryFromRule(args: {
  naturalLanguage: string;
  model?: string;
}): Promise<string> {
  const prompt = `Produce a Gmail search query that captures the emails matching this
natural-language rule. Use Gmail search operators (from:, to:, subject:,
list:, has:, newer_than:, -label:, parens, OR). Do NOT include
"in:inbox" — the caller handles scope separately. Return only JSON.

${COMMON_ACTION_GUIDANCE}

Rule: ${JSON.stringify(args.naturalLanguage)}

Respond with ONE JSON object, no fences, no prose:
  { "gmailQuery": "<Gmail search q:>" }`;

  const res = await runClaudeJson(prompt, QueryOnlySchema, {
    model: args.model ?? MODEL,
    timeoutMs: EVAL_TIMEOUT_MS,
  });
  return res.gmailQuery;
}

// Re-export types the caller needs.
export type { Action };
