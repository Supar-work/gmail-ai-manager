import { z } from 'zod';
import { runClaudeJson } from './client.js';

export type ClassifyRule = {
  id: string;
  naturalLanguage: string;
};

export type ClassifyEmail = {
  id: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  labels: string[];
  date: string | null;
  /**
   * Mailing-list metadata. When present, the visible `from` is the
   * list address (often rewritten by Google Groups / Mailman / etc.)
   * and the real sender is in `originalFrom`. The classifier uses
   * this to match list-aware rules correctly — a rule like
   * `list:zelig.zelig.me` is matched by `listId`, not `from`.
   */
  listId?: string | null;
  listPost?: string | null;
  originalFrom?: string | null;
  precedence?: string | null;
};

export type ClassifyContext = {
  now: string;
  timezone: string;
  rules: ClassifyRule[];
  email: ClassifyEmail;
  /** Override CLI default (e.g. "claude-haiku-4-5-20251001"). */
  model?: string;
};

// `trash` is intentionally excluded — this app never deletes mail. If Claude
// tries to emit it, zod validation will fail and the run either retries or
// the action is dropped. A safety downgrade also exists in gmail/actions.ts.
const ClassifierActionSchema = z.object({
  type: z.enum(['addLabel', 'removeLabel', 'archive', 'markRead', 'star', 'markImportant', 'forward']),
  labelName: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  // Claude often omits this entirely for immediate actions instead of
  // emitting null. Treat missing and null the same.
  resolvedRunAtIso: z.string().nullable().optional(),
});

const MatchSchema = z.object({
  ruleId: z.string(),
  reasoning: z.string(),
  actions: z.array(ClassifierActionSchema),
});

export const ClassifierResultSchema = z.object({
  matches: z.array(MatchSchema),
});
export type ClassifierResult = z.infer<typeof ClassifierResultSchema>;

const INSTRUCTIONS = `You are the classifier for an email automation product.
You are given a list of natural-language rules the user wrote and a single
incoming email. For each rule that applies to the email, decide what
actions to take. Everything — matching criteria, action types, action
parameters, and timing — comes from the rule's plain-English text.

Output rules:
- Respond with ONE JSON object matching this shape exactly, no code fences, no prose:
  {"matches":[{"ruleId":"<id>","reasoning":"<one short sentence>","actions":[{"type":"...","labelName":"...","to":"...","resolvedRunAtIso":"..."}]}]}
- Allowed action types: addLabel, removeLabel, archive, markRead, star, markImportant, forward.
- NEVER emit "trash". This app does not delete mail. If a rule's text says to
  delete, trash, or remove a message, emit "archive" instead — that is the
  strongest action the system supports.
- labelName is required for addLabel / removeLabel. to is required for forward.
- Output one action object per discrete action the rule describes (a rule may imply multiple).
- Timing — always resolve to a concrete UTC ISO 8601 timestamp in resolvedRunAtIso:
    * immediate (default, no timing mentioned) → null
    * "at end of day" → 23:59:59 in the supplied timezone, converted to UTC
    * "end of next business day" → next weekday 23:59:59 in timezone → UTC
    * "in N minutes/hours/days" → now + delta → UTC
    * "at <specific time>" or derived from email body (e.g. "when the OTP expires") →
      parse from the provided "now" + email body → UTC
- If no rule matches, return {"matches":[]}.
- Only emit ruleIds from the provided list. Do not invent rules or actions
  that aren't described by the rule text.
- MAILING-LIST AWARENESS: when the email block has "listId" set (and/or
  "originalFrom" is non-null), the visible "from" is the LIST address
  rewritten by Google Groups / Mailman / etc. — NOT the original sender.
  When matching against rule text:
    * a sender predicate like "from foo@bar.com" should match if EITHER
      the visible "from" OR "originalFrom" is foo@bar.com.
    * a list predicate like "via list:zelig.zelig.me" should match the
      "listId" field, not "from".
    * brand-name conditions ("Apple", "Substack") apply to the
      original sender's brand domain (originalFrom) when it differs
      from the rewritten From.`;

function compactRule(r: ClassifyRule) {
  return { id: r.id, nl: r.naturalLanguage };
}

function compactEmail(e: ClassifyEmail) {
  const body = (e.body ?? e.snippet ?? '').slice(0, 4000);
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    labels: e.labels,
    date: e.date,
    body,
    listId: e.listId ?? null,
    listPost: e.listPost ?? null,
    // Real sender behind a list rewrite. When non-null, `from` is the
    // list address; rules that key off the list should use `list:<id>`,
    // and rules that key off the actual brand should compare to
    // `originalFrom`, NOT `from`.
    originalFrom: e.originalFrom ?? null,
    precedence: e.precedence ?? null,
  };
}

export async function classifyEmail(ctx: ClassifyContext): Promise<ClassifierResult> {
  const payload = {
    now: ctx.now,
    timezone: ctx.timezone,
    rules: ctx.rules.map(compactRule),
    email: compactEmail(ctx.email),
  };
  const prompt = `${INSTRUCTIONS}\n\nCONTEXT:\n${JSON.stringify(payload)}`;
  return runClaudeJson(prompt, ClassifierResultSchema, ctx.model ? { model: ctx.model } : undefined);
}
