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
// Tauri sidecar strips CLAUDE_CODE_OAUTH_TOKEN to force keychain auth, so
// every propose call pays the cold-start cost (~30-50s per claude spawn
// in production vs <2s when invoked from a warm shell). Give the call a
// generous ceiling so the wizard doesn't bail mid-prompt; runClaudeJson
// retries on transient errors so the bound is per attempt, not total.
const PROPOSE_TIMEOUT_MS = 120_000;
const EVAL_TIMEOUT_MS = 90_000;
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
  /**
   * Mailing-list metadata captured at sync time. When the email
   * arrived via a list / Google Group / forwarding alias, the visible
   * From is often rewritten — the proposer needs both to write the
   * right Gmail q: predicate (`list:<id>` is sharper than `from:`).
   */
  listId?: string | null;
  listPost?: string | null;
  /** Real sender behind the list rewrite (Reply-To / Sender / X-Original-From). */
  originalFrom?: string | null;
  precedence?: string | null;
};

/**
 * Enforced at schema-validation time so runClaudeJson retries if Claude
 * keeps slipping: every label an action applies or removes must appear
 * LITERALLY in the naturalLanguage. Skips system labels and generated
 * snooze/<iso> labels (which the user would never paraphrase).
 *
 * The error message deliberately names the missing label so that the
 * improved retry nudge in runClaudeJson can pass it back to Claude.
 */
function refineLabelsAreNamedInNL(
  data: { naturalLanguage: string; actions: Action[] },
  ctx: z.RefinementCtx,
): void {
  const nl = data.naturalLanguage.toLowerCase();
  for (const action of data.actions) {
    if (action.type !== 'addLabel' && action.type !== 'removeLabel') continue;
    const label = action.labelName;
    // System / synthetic label names that don't need to appear in the NL —
    // the user wouldn't expect to see "INBOX" or the generated ISO-bearing
    // snooze label in a human-readable rule sentence.
    if (
      label === 'INBOX' ||
      label === 'STARRED' ||
      label === 'IMPORTANT' ||
      label === 'UNREAD' ||
      label.startsWith('snooze/')
    ) {
      continue;
    }
    if (!nl.includes(label.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `naturalLanguage must literally include the exact label path "${label}". Add it to the NL (e.g. "... as ${label} ...") — paraphrases like "LinkedIn notifications" are not accepted.`,
        path: ['naturalLanguage'],
      });
    }
  }
}

const RuleTokenChipApiSchema = z.object({
  kind: z.literal('chip'),
  semantic: z.string().min(1),
  label: z.string(),
  value: z.string().min(1),
  options: z.array(z.string()).optional(),
});
const RuleTokenTextApiSchema = z.object({
  kind: z.literal('text'),
  value: z.string(),
});
const RuleTokenApiSchema = z.discriminatedUnion('kind', [
  RuleTokenChipApiSchema,
  RuleTokenTextApiSchema,
]);

/**
 * "Covered" outcome — Claude decided this email is already handled by
 * an existing enabled rule, so we skip the propose / evaluate / refine
 * loop and the wizard renders an "Already handled" card.
 */
const CoveredResponseSchema = z.object({
  outcome: z.literal('covered'),
  ruleId: z.string().min(1),
  ruleNL: z.string().min(1),
  reasoning: z.string().min(1),
});

const ProposeOnlyBaseSchema = z.object({
  outcome: z.literal('propose'),
  naturalLanguage: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
  gmailQuery: z.string().min(1),
  groupDescription: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  ruleTokens: z.array(RuleTokenApiSchema).optional(),
});
const ProposeOnlySchema = ProposeOnlyBaseSchema.superRefine((d, ctx) =>
  refineLabelsAreNamedInNL(d, ctx),
);

// z.discriminatedUnion can't take ZodEffects (superRefine output), so
// use z.union — zod still narrows on the literal `outcome` field.
const ProposeResponseSchema = z.union([CoveredResponseSchema, ProposeOnlySchema]);
export type ProposeResponse = z.infer<typeof ProposeResponseSchema>;
export type ProposeOnlyResponse = z.infer<typeof ProposeOnlyBaseSchema>;

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

═══════════════════════════════════════════════════════════════════════
MAILING-LIST RULE (CRITICAL — applies whenever the email block has
"listId" set):

Mailing lists, Google Groups, and forwarding aliases REWRITE the
visible From header. The address you see in "from" is the LIST, not
the original sender. The actual sender lives in "originalFrom" (and
sometimes "listPost" identifies the list address). Examples:

  from:           "'Apple' via Zeligs <zelig@zelig.me>"
  originalFrom:   Apple <News@insideapple.apple.com>
  listId:         zelig.zelig.me

Rules driven off "from:zelig@zelig.me" would catch EVERY email routed
through that list — including non-Apple mail. That's almost never
what the user wants.

When listId is set:
  (a) The gmailQuery MUST use list:<listId> as its primary predicate,
      not from:<list-address>. e.g. list:zelig.zelig.me
  (b) If the user's intent narrows further to a specific original
      sender, ADD a content predicate based on originalFrom:
        list:zelig.zelig.me from:News@insideapple.apple.com
      (Gmail's from: matches the visible From, not Reply-To, but in
      practice list-distributed mail keeps the brand domain in the
      visible From OR the body — Claude can decide whether the body
      mention is reliable enough; if not, skip the from: clause and
      let the rule sweep the whole list.)
  (c) The naturalLanguage MUST describe the rule in terms the user
      will recognise — name the original brand (Apple, OpenAI),
      not the list address. e.g.
        "Label Apple promotional emails forwarded via my Zeligs
         list as Marketing/Apple and archive."
  (d) Labels should reflect the ORIGINAL sender's brand, not the
      list. So "Marketing/Apple", not "Marketing/Zelig".
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
  /**
   * When the caller has already run the canonical-label recommender
   * against sample emails, pass its verdict here so the proposer uses
   * the exact same label path. Prevents the proposer and recommender
   * from disagreeing (one picking "Shopping/LEGO" while the other
   * picks "Marketing/LEGO" based on different signals).
   */
  preferredLabel?: {
    path: string;
    disposition: 'inbox' | 'archive';
    reasoning: string;
  };
  /**
   * Cross-cutting "always check this" guidance the user maintains in
   * Settings (User.aiGuidance, falling back to DEFAULT_AI_GUIDANCE).
   * Goes ABOVE the per-class action guidance so Claude evaluates these
   * patterns first — e.g., "OTP → archive after 1 hour" wins over the
   * sender's category default.
   */
  aiGuidance?: string;
  /**
   * The user's existing enabled rules. Claude should check this list
   * first — if the source email already matches one of these rules,
   * return outcome:"covered" with the rule's id instead of proposing
   * a duplicate.
   */
  existingRules?: Array<{ id: string; naturalLanguage: string; gmailQuery?: string | null }>;
  previousAttempt?: {
    rule: string;
    gmailQuery: string;
    evaluatorNote: string;
    sampleSummary: string;
  };
}): string {
  const { email, nowIso, timezone, previousAttempt, preferredLabel, aiGuidance, existingRules } = args;

  const emailBlock = JSON.stringify(
    {
      from: email.from,
      to: email.to,
      subject: email.subject,
      labels: email.labels,
      date: email.date,
      bodyExcerpt: (email.body ?? email.snippet ?? '').slice(0, 1200),
      listId: email.listId ?? null,
      listPost: email.listPost ?? null,
      originalFrom: email.originalFrom ?? null,
      precedence: email.precedence ?? null,
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

  const guidanceBlock = aiGuidance && aiGuidance.trim()
    ? `
═══════════════════════════════════════════════════════════════════════
USER AI GUIDANCE (cross-cutting; always check before per-class defaults):

${aiGuidance.trim()}

These patterns OVERRIDE the per-class actions when they apply. Mention
the override in the NL so the user understands why the timing differs
from the sender's class default ("archive 1 hour after arrival" vs
"archive immediately").
═══════════════════════════════════════════════════════════════════════
`
    : '';

  const existingRulesBlock =
    existingRules && existingRules.length > 0
      ? `
═══════════════════════════════════════════════════════════════════════
EXISTING RULES (the user already has these — check FIRST):

${existingRules
  .slice(0, 30)
  .map(
    (r, i) =>
      `  [${i + 1}] id=${r.id}\n      "${r.naturalLanguage.slice(0, 200)}"${
        r.gmailQuery ? `\n      gmailQuery: ${r.gmailQuery.slice(0, 200)}` : ''
      }`,
  )
  .join('\n')}

If the SOURCE EMAIL below clearly matches one of these existing rules,
respond with outcome:"covered" — DO NOT propose a duplicate. Use the
exact id from this list. The user will be told their existing rule
already handles this email and the wizard will skip it.

Only mark as covered when the existing rule clearly applies — when in
doubt, propose a new (more specific) rule instead.
═══════════════════════════════════════════════════════════════════════
`
      : '';

  const preferredLabelBlock = preferredLabel
    ? `
═══════════════════════════════════════════════════════════════════════
PRE-COMPUTED CANONICAL LABEL (authoritative):
A separate taxonomy classifier already looked at sample emails matching
this sender and picked:
  Label path: ${preferredLabel.path}
  Disposition: ${preferredLabel.disposition}
  Reasoning:  ${preferredLabel.reasoning}

If your rule includes an addLabel action for this class of email, USE
this exact label path verbatim (do NOT paraphrase, shorten, or pick a
different top-level). Mention the same label path in naturalLanguage.
Only deviate if this email is so different from the sampled siblings
that the recommended label clearly doesn't fit.
═══════════════════════════════════════════════════════════════════════
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
  (a) Check the USER AI GUIDANCE block first — those cross-cutting
      patterns override per-class defaults when they apply.
  (b) Read the body carefully and apply the TODO DETECTION rule below.
      If the email has a pending action for the user, DO NOT archive.
  (c) Decide on the predicate that generalizes this email — see the
      SPECIFICITY RULE below. Prefer sender / domain over body content
      for human replies.
  (d) If a pre-computed canonical label is provided below, use that
      label path verbatim in any addLabel actions and in the NL. The
      downstream Suggested-label UI panel uses the SAME classifier
      output, so deviating will create a visible disagreement.

Current time (UTC): ${nowIso}
User timezone:      ${timezone}
${existingRulesBlock}${guidanceBlock}${preferredLabelBlock}
${COMMON_ACTION_GUIDANCE}
${refineBlock}
THE EMAIL:
${emailBlock}

Respond with ONE JSON object, no code fences, no prose. The shape
depends on whether you found a covering existing rule.

(A) If the EMAIL is already covered by one of the EXISTING RULES above,
    return ONLY this short shape and stop:
{
  "outcome": "covered",
  "ruleId": "<exact id from the EXISTING RULES list>",
  "ruleNL": "<that rule's naturalLanguage, copied verbatim>",
  "reasoning": "<one short sentence: which fields of the email match the rule>"
}

(B) Otherwise, return the full proposal:
{
  "outcome": "propose",
  "naturalLanguage": "<rule in plain English, max ~160 chars>",
  "actions": [ ...ActionSchema... ],
  "gmailQuery": "<Gmail search q:>",
  "groupDescription": "<short label for this group>",
  "confidence": <0..1>,
  "reasoning": "<one short sentence: why these actions + this query>",
  "ruleTokens": [
    /* Tokenise the rule sentence for the in-line chip editor. The UI
       renders these tokens left-to-right inside the rule textbox.
       Text tokens are plain editable spans; chip tokens are clickable
       chips that pop a small picker.

       Two kinds:
         { "kind":"text", "value":"plain text fragment, including
             punctuation/spaces between chips" }
         { "kind":"chip", "semantic":"sender|subject|list|time|flag|
             action|label|timing|note", "label":"",
             "value":"<just the noun>", "options":["alt1","alt2",…] }

       READABILITY (most important):
         • The rule must read as natural English when the user reads
           text + chip values left-to-right. Use the structure:
              "When email is from X (and …), do Y, and do Z."
           Avoid awkward inlines like "Label X notifications as Y" —
           pull the preposition into the surrounding TEXT
           ("When email is from "), keep the chip value bare
           ("noreply@github.com"). For actions, write
           "label as <label>", "archive", "snooze to <time>".

       FORMAT RULES:
         • Concatenating every token's value (text tokens verbatim,
           chip tokens as their value) MUST reproduce a clean English
           sentence. The naturalLanguage field above should match
           that concatenation closely (modulo whitespace).
         • Leave chip "label" empty (""). The chip is rendered as
           just its value; surrounding text carries the grammar.
         • EVERY meaningful position the user might tweak must be a
           chip. In particular, treat these as MANDATORY chips when
           the rule expresses them:
             - the SENDER (or sender domain, list address)
             - any LABEL PATH the rule applies or removes
             - each DISPOSITION/ACTION the rule performs
                 (label / archive / mark read / star / snooze /
                  forward / KEEP-IN-INBOX). Even when the rule
                  decides NOT to archive ("keep in inbox", "leave
                  in inbox"), wrap that as a disposition chip — the
                  user wants to be able to switch it to archive or
                  snooze with one click.
             - any TIMING modifier ("end of day", "monday morning",
               "after 1 hour")
             - any TIME CONDITION ("sent over the weekend",
               "older than 30 days")
         • For EACH chip provide 2-4 plausible alternative values in
           "options" — including the current value itself. Examples:
             - sender chip → ["noreply@github.com", "*@github.com", "GitHub"]
             - disposition → ["keep in inbox", "archive",
                 "archive end of day", "archive next business day",
                 "archive after 1 day", "snooze to monday morning"]
             - timing → ["immediately", "end of day",
                 "next business day", "in 1 hour", "in 1 day"]
             - label → suggest 1-2 nearby canonical paths.
           Empty array is allowed only when no alternatives make
           sense.
         • Chip values are short, human-readable nouns/phrases —
           never regexes, IDs, or full sentences.
         • Up to ~12 tokens. Quality over quantity.

       Example (good):
         "When email is " | chip(sender,"","noreply@github.com",[…])
         | ", label as " | chip(label,"","Notifications/GitHub",[…])
         | " and " | chip(action,"","archive",[…]) | "."
       Example (bad — awkward English):
         "Label " | chip(sender,"from","noreply@github.com",[…])
         | " notifications as " | chip(label,"","Notifications/GitHub",[…])
         | " and " | chip(action,"","archive",[…]) | " them."
    */
  ]
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
  /**
   * Canonical-label recommendation pre-computed from sample emails.
   * Keeps the proposer's addLabel action aligned with the Suggested-
   * label UI panel (which uses the same classifier). Optional — caller
   * skips it if no recommendation could be produced (e.g. no sender).
   */
  preferredLabel?: {
    path: string;
    disposition: 'inbox' | 'archive';
    reasoning: string;
  };
  /**
   * User-edited cross-cutting guidance (User.aiGuidance, falling back
   * to DEFAULT_AI_GUIDANCE). Pass-through to the prompt; caller is
   * responsible for resolving the default.
   */
  aiGuidance?: string;
  /**
   * The user's existing enabled rules. Passed verbatim into the
   * proposer so Claude can short-circuit when the email is already
   * covered (returns outcome:"covered" with the matched rule id).
   */
  existingRules?: Array<{ id: string; naturalLanguage: string; gmailQuery?: string | null }>;
  model?: string;
};

/** Either a "covered by existing rule" short-circuit, or a fully-
 *  evaluated propose result with samples/totals/refineHistory. */
export type ProposeAndRefineResult =
  | { outcome: 'covered'; ruleId: string; ruleNL: string; reasoning: string }
  | (ProposeOnlyResponse & {
      samples: CleanupSample[];
      totals: { inbox: number; allMail: number };
      refineHistory: RefineAudit[];
    });

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
  let current: ProposeOnlyResponse | null = null;
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
      preferredLabel: args.preferredLabel,
      aiGuidance: args.aiGuidance,
      // Only on the FIRST attempt: include the rule list. After a
      // refine we know we're past the coverage check (Claude already
      // chose to propose), so re-asking is wasted prompt budget.
      existingRules: attempt === 1 ? args.existingRules : undefined,
    });
    const raw = await runClaudeJson(proposePrompt, ProposeResponseSchema, {
      model,
      timeoutMs: PROPOSE_TIMEOUT_MS,
    });
    if (raw.outcome === 'covered') {
      // Short-circuit: skip the propose / evaluate / refine loop. The
      // wizard will render an "Already handled by rule X" card and
      // auto-advance.
      return {
        outcome: 'covered',
        ruleId: raw.ruleId,
        ruleNL: raw.ruleNL,
        reasoning: raw.reasoning,
      };
    }
    current = raw;

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
const ReproposeResponseSchema = z
  .object({
    naturalLanguage: z.string().min(1),
    actions: z.array(ActionSchema).min(1),
    gmailQuery: z.string().min(1),
    ruleTokens: z.array(RuleTokenApiSchema).optional(),
  })
  .superRefine(refineLabelsAreNamedInNL);
export type ReproposeResponse = z.infer<typeof ReproposeResponseSchema>;

export async function reproposeForEditedRule(args: {
  email: EmailForProposal;
  editedNaturalLanguage: string;
  nowIso: string;
  timezone: string;
  /** Same cross-cutting guidance the proposer uses. Even on user
   *  edits, OTP-style overrides should still inform action timing. */
  aiGuidance?: string;
  model?: string;
}): Promise<ReproposeResponse> {
  const { email, editedNaturalLanguage, nowIso, timezone, aiGuidance } = args;
  const model = args.model ?? MODEL;

  const emailBlock = JSON.stringify(
    {
      from: email.from,
      to: email.to,
      subject: email.subject,
      labels: email.labels,
      date: email.date,
      bodyExcerpt: (email.body ?? email.snippet ?? '').slice(0, 800),
      listId: email.listId ?? null,
      listPost: email.listPost ?? null,
      originalFrom: email.originalFrom ?? null,
      precedence: email.precedence ?? null,
    },
    null,
    2,
  );

  const guidanceBlock = aiGuidance && aiGuidance.trim()
    ? `\nUSER AI GUIDANCE (cross-cutting; respect these even on user edits):\n${aiGuidance.trim()}\n`
    : '';

  const prompt = `The user has edited a rule text. Re-derive the action list and Gmail
search query to match the EDITED text exactly (self-consistency rule
below). The source email is supplied for context but the edited rule is
the authoritative source of truth for both actions and semantics.

Current time (UTC): ${nowIso}
User timezone:      ${timezone}
${guidanceBlock}
${COMMON_ACTION_GUIDANCE}

MAILING-LIST RULE: when the source email block has "listId" set, the
visible "from" is the LIST address, not the original sender (the real
sender is in "originalFrom"). The gmailQuery MUST use list:<listId>
as its sender predicate, not from:<list-address>. Labels should
reflect the original brand from "originalFrom", not the list.

EDITED RULE: ${JSON.stringify(editedNaturalLanguage)}

SOURCE EMAIL (context only — don't let it override what the rule says):
${emailBlock}

Respond with ONE JSON object, no fences, no prose:
{
  "naturalLanguage": "<copy the edited rule verbatim — OR tidy minor typos; do not change meaning>",
  "actions": [ ...ActionSchema... ],
  "gmailQuery": "<Gmail search q:>",
  "ruleTokens": [
    /* Tokenise the rule for the in-line chip editor. Two kinds:
         { "kind":"text", "value":"plain fragment" }
         { "kind":"chip", "semantic":"sender|subject|list|time|flag|
             action|label|timing|note", "label":"",
             "value":"<just the noun>", "options":["alt1","alt2",…] }

       Use the structure: "When email is from X (and …), do Y, and
       do Z." Pull prepositions into the surrounding TEXT ("When
       email is from "); keep chip values bare ("noreply@github.com").
       Leave chip "label" empty — the chip is rendered as just its
       value. Concatenating text + chip values must produce natural
       English matching naturalLanguage.

       MANDATORY chips: sender, every label path, every action /
       disposition (label / archive / mark read / star / snooze /
       forward / KEEP-IN-INBOX), any timing modifier, any time
       condition. Even "keep in inbox" must be a disposition chip
       with options like ["keep in inbox", "archive", "archive end
       of day", "snooze to monday morning"] — the user wants to be
       able to flip it without retyping.

       For each chip include 2-4 plausible "options" (current value
       included). Up to ~12 tokens. */
  ]
}`;

  return runClaudeJson(prompt, ReproposeResponseSchema, {
    model,
    timeoutMs: PROPOSE_TIMEOUT_MS,
  });
}

// Re-export types the caller needs.
export type { Action };
