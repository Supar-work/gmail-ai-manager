import { Router, type Router as RouterT } from 'express';
import { z } from 'zod';
import { ActionSchema } from '@gam/shared';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { runClaudeJson } from '../claude/client.js';
import { logger } from '../logger.js';
import { safeParseArray } from '../util/safe-json.js';

export const rulesRouter: RouterT = Router();

rulesRouter.use(requireUser);

function hydrateRule(r: {
  id: string;
  naturalLanguage: string;
  actionsJson: string;
  enabled: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    naturalLanguage: r.naturalLanguage,
    actionsJson: safeParseArray(r.actionsJson),
    enabled: r.enabled,
    position: r.position,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

rulesRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const rules = await prisma.rule.findMany({
    where: { userId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  res.json({ rules: rules.map(hydrateRule) });
});

const UpsertSchema = z.object({
  naturalLanguage: z.string().min(1).max(1000),
  // Structured actions are optional now. The classifier derives actions from
  // the NL text + email body at evaluation time. Accepted here only so the
  // Gmail-filter import path (which already has structured actions) can
  // still populate the legacy column.
  actions: z.array(ActionSchema).optional(),
  enabled: z.boolean().optional(),
});

rulesRouter.post('/', async (req, res) => {
  const userId = getUserId(req);
  const parsed = UpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }
  const count = await prisma.rule.count({ where: { userId } });
  const rule = await prisma.rule.create({
    data: {
      userId,
      naturalLanguage: parsed.data.naturalLanguage,
      actionsJson: JSON.stringify(parsed.data.actions ?? []),
      enabled: parsed.data.enabled ?? true,
      position: count,
    },
  });
  res.json({ rule: hydrateRule(rule) });
});

rulesRouter.put('/:id', async (req, res) => {
  const userId = getUserId(req);
  const parsed = UpsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.rule.findFirst({ where: { id: req.params.id, userId } });
  if (!existing) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const rule = await prisma.rule.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.naturalLanguage != null
        ? { naturalLanguage: parsed.data.naturalLanguage }
        : {}),
      ...(parsed.data.actions ? { actionsJson: JSON.stringify(parsed.data.actions) } : {}),
      ...(parsed.data.enabled != null ? { enabled: parsed.data.enabled } : {}),
    },
  });
  res.json({ rule: hydrateRule(rule) });
});

rulesRouter.delete('/:id', async (req, res) => {
  const userId = getUserId(req);
  const existing = await prisma.rule.findFirst({ where: { id: req.params.id, userId } });
  if (!existing) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await prisma.$transaction([
    prisma.scheduledAction.updateMany({
      where: { ruleId: existing.id, status: 'pending' },
      data: { status: 'cancelled', lastError: 'rule_deleted' },
    }),
    prisma.rule.delete({ where: { id: existing.id } }),
  ]);
  res.json({ ok: true });
});

// ── rule analyzer ─────────────────────────────────────────────────────────
// Quick-feedback endpoint used by the editor. Given the NL draft, ask Claude
// what actions it thinks the rule describes and surface any ambiguities so
// the user can fix the text before saving. Not authoritative — runs against
// the text only, no email context.

// `trash` excluded by design — this app never deletes mail. See classifier.ts.
const AnalyzeActionSchema = z.object({
  type: z.enum([
    'addLabel',
    'removeLabel',
    'archive',
    'markRead',
    'star',
    'markImportant',
    'forward',
  ]),
  labelName: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  // Claude often returns `null` for immediate — accept null, string, or missing.
  timing: z.string().nullable().optional(),
});

const AnalyzeResponseSchema = z.object({
  summary: z.string(),
  actions: z.array(AnalyzeActionSchema),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()).optional(),
  // Optional one-shot rephrase of the rule. Populated only when the user's
  // phrasing has typos, is ambiguous, or could be meaningfully clearer while
  // preserving exact intent. Null when the current text is already good.
  suggestedRewrite: z.string().nullable().optional(),
});

const ANALYZE_PROMPT = `You review natural-language rules a user wrote for an email-automation product
and report back what the rule would do. You are NOT given an email — only the
rule text. Output predictions based on the text alone.

Rules produce zero or more actions. Allowed action types:
  addLabel, removeLabel, archive, markRead, star, markImportant, forward.

IMPORTANT: this app never deletes mail. Do NOT emit "trash". If a rule
mentions deleting/trashing, translate it to "archive" in the output and add
a warning that the user's phrasing was interpreted as archive for safety.

Respond with ONE JSON object, no code fences, no prose:
{
  "summary": "<one-sentence plain-English description of what the rule does>",
  "actions": [
    { "type": "<type>", "labelName": "<only for addLabel/removeLabel>",
      "to": "<only for forward>", "timing": "<immediate | end-of-day | ... | null>" }
  ],
  "warnings": ["<human-readable issues: missing/ambiguous condition, typo'd email,
    conflicting actions, etc.>"],
  "suggestions": ["<optional tweaks to make the rule clearer>"],
  "suggestedRewrite": "<optional cleaner version of the rule, preserving the
    SAME intent — or null if the current wording is already good>"
}

Guidance:
- "timing": short human label (e.g. "immediate", "end of day", "in 2 hours",
  "when the OTP in the email expires"). Do NOT resolve to a specific timestamp
  here — that's done later with an email.
- If the rule has no clear matching condition (what mail it applies to), add a
  warning.
- If the forward target doesn't look like a valid email, add a warning.
- If no action is describable, return actions: [] and surface a warning.
- suggestedRewrite: ONLY populate when the rewrite is meaningfully better
  (fixes a typo, resolves ambiguity, or clearly tightens the phrasing). If
  the user's text is already clear or the change would be cosmetic (punctuation,
  minor word order), return null. Preserve intent exactly — never change which
  emails match or which actions run; if you aren't sure, return null.`;

const AnalyzeBody = z.object({ naturalLanguage: z.string().min(1).max(2000) });

// Always Haiku for the live preview — this is a short interpretation task,
// latency matters (UI waits), and quality is more than sufficient. User's
// configured claudeModel still applies to real classification runs.
const ANALYZE_MODEL = 'claude-haiku-4-5-20251001';
const ANALYZE_TIMEOUT_MS = 60_000;

rulesRouter.post('/analyze', async (req, res) => {
  const parsed = AnalyzeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  const userId = getUserId(req);
  try {
    const prompt = `${ANALYZE_PROMPT}\n\nRULE:\n${parsed.data.naturalLanguage}`;
    const result = await runClaudeJson(prompt, AnalyzeResponseSchema, {
      model: ANALYZE_MODEL,
      timeoutMs: ANALYZE_TIMEOUT_MS,
    });
    // Add a warning for any `forward` action whose target the user
    // hasn't allowlisted yet — saving the rule won't fail, but the
    // first apply will be refused by the allowlist guard. Surfacing
    // this here gives the user a chance to confirm in Settings before
    // hitting the wall.
    const extra = await forwardWarnings(userId, result.actions);
    res.json({ ...result, warnings: [...result.warnings, ...extra] });
  } catch (err) {
    logger.warn({ err, userId }, 'rule analyze failed');
    res.status(500).json({ error: 'analyze_failed', message: err instanceof Error ? err.message : String(err) });
  }
});

async function forwardWarnings(
  userId: string,
  actions: { type: string; to?: string | null }[],
): Promise<string[]> {
  const targets = actions
    .filter((a) => a.type === 'forward' && typeof a.to === 'string')
    .map((a) => (a.to as string).trim().toLowerCase());
  if (targets.length === 0) return [];
  const unique = Array.from(new Set(targets));
  const verified = await prisma.forwardingAddress.findMany({
    where: { userId, address: { in: unique }, verified: true },
    select: { address: true },
  });
  const verifiedSet = new Set(verified.map((v) => v.address));
  const missing = unique.filter((a) => !verifiedSet.has(a));
  return missing.map(
    (a) =>
      `Forward target ${a} is not in your confirmed forwarding addresses — add and confirm it in Settings before this rule will fire.`,
  );
}

// ── rewrite-with-label ────────────────────────────────────────────────────
// When the user accepts a canonical label suggestion in the translate wizard,
// the AI-rule text often still references the old label name. This endpoint
// asks Claude to rewrite the rule against the new label path, preserving
// matching logic and timing. Used in place of naive string substitution.

const RewriteWithLabelBody = z.object({
  naturalLanguage: z.string().min(1).max(2000),
  oldLabelName: z.string().min(1).max(200).nullable().optional(),
  newLabelPath: z.string().min(1).max(200),
});

const RewriteResponseSchema = z.object({
  naturalLanguage: z.string().min(1),
});

const REWRITE_MODEL = 'claude-haiku-4-5-20251001';
const REWRITE_TIMEOUT_MS = 45_000;

rulesRouter.post('/rewrite-with-label', async (req, res) => {
  const parsed = RewriteWithLabelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }
  const { naturalLanguage, oldLabelName, newLabelPath } = parsed.data;
  const userId = getUserId(req);

  const prompt = `You are editing a natural-language email rule for a Gmail automation tool.
Rewrite the rule so it references the NEW label path instead of the OLD label name,
preserving everything else exactly — matching conditions, other actions, timing, tone.

OLD label name: ${oldLabelName ? JSON.stringify(oldLabelName) : '(none — the rule does not currently name a label)'}
NEW label path: ${JSON.stringify(newLabelPath)}

ORIGINAL RULE:
${JSON.stringify(naturalLanguage)}

Rules for the rewrite:
- Change ONLY the label reference. Keep matching conditions (from/to/subject/etc.),
  other actions (archive, mark read, forward, star, …), and any timing identical.
- If the rule didn't explicitly name a label, add a clause like "and label as <new path>"
  in a way that reads naturally.
- Preserve the user's sentence style and punctuation as much as possible.
- Label paths can contain slashes (e.g. "Family/Basis"). Do not modify the path itself.
- One sentence when possible, but keep multi-sentence rules multi-sentence.

Respond with ONE JSON object, no code fences, no prose:
{"naturalLanguage": "<rewritten rule text>"}`;

  try {
    const out = await runClaudeJson(prompt, RewriteResponseSchema, {
      model: REWRITE_MODEL,
      timeoutMs: REWRITE_TIMEOUT_MS,
    });
    res.json(out);
  } catch (err) {
    logger.warn({ err, userId }, 'rewrite-with-label failed');
    res
      .status(500)
      .json({ error: 'rewrite_failed', message: err instanceof Error ? err.message : String(err) });
  }
});

const ReorderSchema = z.object({ orderedIds: z.array(z.string()).min(1) });

rulesRouter.post('/reorder', async (req, res) => {
  const userId = getUserId(req);
  const parsed = ReorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  await prisma.$transaction(
    parsed.data.orderedIds.map((id, i) =>
      prisma.rule.updateMany({ where: { id, userId }, data: { position: i } }),
    ),
  );
  res.json({ ok: true });
});
