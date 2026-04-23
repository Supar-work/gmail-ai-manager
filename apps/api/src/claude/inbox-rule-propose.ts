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

═══════════════════════════════════════════════════════════════════════
SELF-CONSISTENCY RULE (critical, both directions):

The naturalLanguage and the actions array describe the SAME rule and
must not drift. Specifically:

(a) Every concrete effect in "naturalLanguage" MUST appear in "actions".
    ✗ NL "archive end of day" + actions only [addLabel]
      → add { type:"archive", runAt:{ kind:"endOfDay" } }
    ✗ NL "snooze until Monday" + actions only [addLabel]
      → add the full snooze pattern (below)

(b) Every action in "actions" MUST be described in "naturalLanguage".
    The NL must name every distinct action type that appears (label,
    archive, mark read, star, snooze, …). Don't silently add actions
    the user wouldn't predict from reading the rule.
    ✗ actions [addLabel, markRead, archive] but NL only "archive and label"
      → NL should be "Label as X, mark read, and archive"
    ✗ actions [addLabel "Shopping/Nespresso"] but NL "label as shopping"
      → NL must name the exact label path: "label as Shopping/Nespresso"

(c) NL must reference the EXACT label path from addLabel/removeLabel
    actions — not a paraphrase. If you chose "Shopping/Nespresso", the
    NL must say "Shopping/Nespresso" literally. This is what the user
    will see in Gmail.

(d) NL must state non-immediate timing. If any action has
    runAt { kind:"endOfDay" / "relative" / "atTime" }, the NL must
    say so ("at end of day", "in 2 hours", "tomorrow morning", …).

Template to reach for:
  "<verb> <emails matching X> as <LabelPath>, <other verbs>, and <final verb>[ at <timing>]."
Examples:
  ✓ "Label Nespresso promotional emails as Shopping/Nespresso, mark them read, and archive them."
  ✓ "Label Stripe receipts as Receipts/Stripe and archive at end of day."
  ✓ "Snooze GitHub Actions failure notifications until 9am tomorrow under snooze/<iso>."

If in doubt, rewrite NL to match the actions you're actually shipping.
Prefer accurate + slightly long over short + misleading.
═══════════════════════════════════════════════════════════════════════

SNOOZE PATTERN — reach for it when the rule text combines
"keep visible / leave in inbox / don't archive yet / make sure I see it"
with "archive / out of inbox at <time>" or "come back at <time>".

Those two intents together = snooze. Emit the four-action pattern:
  [
    { type:"addLabel",    labelName:"snooze/<iso>",             runAt:{ kind:"immediate" } },
    { type:"archive",                                           runAt:{ kind:"immediate" } },
    { type:"addLabel",    labelName:"INBOX",                    runAt:{ kind:"atTime", iso:"<iso>" } },
    { type:"removeLabel", labelName:"snooze/<iso>",             runAt:{ kind:"atTime", iso:"<iso>" } }
  ]
<iso> is the wake-up moment in UTC ISO-8601 (no milliseconds, Z suffix).

═══════════════════════════════════════════════════════════════════════
markImportant GUARD:
{ type:"markImportant" } flips Gmail's IMPORTANT bit (the yellow »» flag
in the classic web UI). Use it ONLY when the rule text is EXPLICITLY
about priority, importance, or highlighting in the Important view:
  ✓ "mark as important"
  ✓ "promote to Important so I see it first"

Do NOT use markImportant for vague visibility phrasing like:
  ✗ "keep visible"         → emit no archive action (or snooze if timed)
  ✗ "make sure I see it"   → emit no archive action (or star)
  ✗ "prompt attention"     → emit no archive action (or star)
  ✗ "don't archive yet"    → emit no archive action (snooze if timed)

When in doubt, prefer star over markImportant, or just skip the action.
═══════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════
TODO / ACTION-ITEM DETECTION (critical):

Read the source email body carefully and check whether it contains a
pending action for THE USER (not for the sender). If there's a todo on
the user, the rule MUST NOT archive matching emails — the user needs
them to stay in the inbox until the todo is done.

Signals a pending user action is in the email:
  • Imperatives addressed to the user:
      "please <do>", "could you <do>", "can you <do>", "feel free to
      <do>", "let me know <X>", "reply when you can", "send me <X>"
  • Open questions awaiting the user's answer
  • Verifications or approvals awaiting the user:
      "please confirm", "does this look right?", "do you agree?"
  • Deadlines / time-bound asks: "by Monday", "before EOD"
  • Requests for credentials, documents, or information from the user

When one of these is present:
  ✗ DO NOT emit { type:"archive" }
  ✗ DO NOT emit { type:"markRead" } (the unread badge keeps the todo
     visible — only emit markRead if the rule text literally asks for it)
  ✓ DO emit the label action (so the email is still categorized)
  ✓ Optionally emit { type:"star" } to highlight the todo
  ✓ If the rule should only take action once the todo is resolved,
     describe that behavior in the NL but do not encode it as an action

NL phrasing when there's a pending todo:
  ✓ "Label emails from UpWest as Work/UpWest and keep them in the inbox."
  ✓ "Label replies from Gil at UpWest as Work/UpWest; leave them in inbox
     so I can act on the todo."

Example — the wrong call and the right call:
  Email: "Hi, please feel free to cancel the hotel room as well."
  ✗ actions [addLabel "Work/UpWest", markRead, archive]
    NL "Archive brief response emails from work contacts…"
    (archives an email with a pending "cancel the hotel room" todo)
  ✓ actions [addLabel "Work/UpWest"]
    NL "Label emails from UpWest contacts as Work/UpWest and keep them
     in the inbox while a response or follow-up is pending."

If the email is purely an acknowledgement with no todo
("Thanks!", "got it", "perfect"), archive is fine.
═══════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════
SPECIFICITY RULE — gmailQuery generalization:

When turning one email into a class-matching Gmail query, prefer
predicates the user can understand and trust at a glance:

  ✓ from:someone@domain.com           (specific sender)
  ✓ from:*@domain.com                 (all from a domain)
  ✓ from:Nespresso@email.nespresso.com subject:"promo"
  ✓ list:digest.substack.com          (mailing-list header)

Avoid content heuristics that match too much or require reading the
body:

  ✗ subject:"brief"        (matches unrelated things)
  ✗ subject:"confirmation" (very broad)
  ✗ "work contacts"        (not a Gmail operator at all)
  ✗ queries that combine many OR'd terms trying to match "tone"

When the email is from a personal sender (a human, not a bot/service),
default to from:their-address or from:*@their-domain. Do NOT try to
build rules off the body content of one-off human replies — those
rarely generalize.

If the only viable predicate is too broad, narrow the rule so it at
least matches this one email correctly; the user can loosen it later.
═══════════════════════════════════════════════════════════════════════

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
Use title case for the sub-category. Keep the label path consistent:
once you've picked a two-level path, use that same path in both actions
and NL (do not shorten it to just the child in the NL).`;

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

Before emitting actions:
  (a) Read the body carefully and apply the TODO DETECTION rule below.
      If the email has a pending action for the user, DO NOT archive.
  (b) Decide on the predicate that generalizes this email — see the
      SPECIFICITY RULE below. Prefer sender / domain over body content
      for human replies.

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

/**
 * Re-derive actions + query from an EDITED rule text. Used by
 * preview-matches when the user has tweaked the NL in the wizard — the
 * original proposer's actions no longer match, so we ask Claude to redo
 * the action extraction using the same self-consistency rules as the
 * initial propose step.
 *
 * Cheaper than proposeAndRefine (no evaluate-refine loop): the user is
 * driving now, so we trust their text and only need a fresh translation
 * of it into actions + query.
 */
const ReproposeResponseSchema = z.object({
  naturalLanguage: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
  gmailQuery: z.string().min(1),
});
export type ReproposeResponse = z.infer<typeof ReproposeResponseSchema>;

export async function reproposeForEditedRule(args: {
  email: EmailForProposal;
  editedNaturalLanguage: string;
  nowIso: string;
  timezone: string;
  model?: string;
}): Promise<ReproposeResponse> {
  const { email, editedNaturalLanguage, nowIso, timezone } = args;
  const model = args.model ?? MODEL;

  const emailBlock = JSON.stringify(
    {
      from: email.from,
      to: email.to,
      subject: email.subject,
      labels: email.labels,
      date: email.date,
      bodyExcerpt: (email.body ?? email.snippet ?? '').slice(0, 800),
    },
    null,
    2,
  );

  const prompt = `The user has edited a rule text. Re-derive the action list and Gmail
search query to match the EDITED text exactly (self-consistency rule
below). The source email is supplied for context but the edited rule is
the authoritative source of truth for both actions and semantics.

Current time (UTC): ${nowIso}
User timezone:      ${timezone}

${COMMON_ACTION_GUIDANCE}

EDITED RULE: ${JSON.stringify(editedNaturalLanguage)}

SOURCE EMAIL (context only — don't let it override what the rule says):
${emailBlock}

Respond with ONE JSON object, no fences, no prose:
{
  "naturalLanguage": "<copy the edited rule verbatim — OR tidy minor typos; do not change meaning>",
  "actions": [ ...ActionSchema... ],
  "gmailQuery": "<Gmail search q:>"
}`;

  return runClaudeJson(prompt, ReproposeResponseSchema, {
    model,
    timeoutMs: PROPOSE_TIMEOUT_MS,
  });
}

// Re-export types the caller needs.
export type { Action };
