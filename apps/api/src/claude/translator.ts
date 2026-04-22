import { z } from 'zod';
import type { Action } from '@gaf/shared';
import type { GmailFilter } from '../gmail/filters.js';
import { SYSTEM_LABEL_NAME } from './labels.js';
import { runClaudeJson } from './client.js';

export function deriveActions(filter: GmailFilter, labelMap: Record<string, string>): Action[] {
  const out: Action[] = [];
  const a = filter.action ?? {};
  for (const id of a.addLabelIds ?? []) {
    // Gmail's "delete" (TRASH) and "send to spam" (SPAM) both downgrade to
    // archive on import — this app is deliberately non-destructive.
    if (id === 'TRASH' || id === 'SPAM') out.push({ type: 'archive' });
    else if (id === 'STARRED') out.push({ type: 'star' });
    else if (id === 'IMPORTANT') out.push({ type: 'markImportant' });
    else out.push({ type: 'addLabel', labelName: SYSTEM_LABEL_NAME[id] ?? labelMap[id] ?? id });
  }
  for (const id of a.removeLabelIds ?? []) {
    if (id === 'INBOX') out.push({ type: 'archive' });
    else if (id === 'UNREAD') out.push({ type: 'markRead' });
    else out.push({ type: 'removeLabel', labelName: SYSTEM_LABEL_NAME[id] ?? labelMap[id] ?? id });
  }
  if (a.forward) out.push({ type: 'forward', to: a.forward });
  return out;
}

const BatchItemSchema = z.object({
  id: z.string(),
  naturalLanguage: z.string().min(1),
});
const BatchResponseSchema = z.object({
  translations: z.array(BatchItemSchema),
});

const INSTRUCTIONS = `You translate Gmail filter rules into short, human-friendly sentences.
The user will delete their Gmail filter and rely on your description, so be precise.

Rules for each translation:
- One sentence, ≤ 20 words, present tense.
- Start with the condition. e.g. "When an email is from X, archive it."
- Use "from", "to", "subject contains", "body contains" phrasing.
- If the filter has no condition, start with "For every incoming email,".
- Do NOT invent conditions or actions. Only describe what is in the input.
- If actions look like archive / mark-read / star, say exactly that.

Respond with one JSON object, no code fences, no prose:
{"translations":[{"id":"<filter-id>","naturalLanguage":"..."}, ...]}
One entry per input filter, in the same order.`;

type FilterPayload = {
  id: string;
  criteria: Record<string, unknown>;
  action: { addLabels: string[]; removeLabels: string[]; forward: string | null };
};

function toPayload(f: GmailFilter, labelMap: Record<string, string>): FilterPayload {
  return {
    id: f.id!,
    criteria: (f.criteria ?? {}) as Record<string, unknown>,
    action: {
      addLabels: (f.action?.addLabelIds ?? []).map((id) => labelMap[id] ?? SYSTEM_LABEL_NAME[id] ?? id),
      removeLabels: (f.action?.removeLabelIds ?? []).map(
        (id) => labelMap[id] ?? SYSTEM_LABEL_NAME[id] ?? id,
      ),
      forward: f.action?.forward ?? null,
    },
  };
}

export type TranslateOptions = {
  /** Model passed to `claude -p --model`. Defaults to fast/cheap Haiku. */
  model?: string;
  /** Per-call timeout in ms. Default 120s — large batches need headroom. */
  timeoutMs?: number;
  /** Max filters per CLI call. Batches run sequentially. Default 15. */
  batchSize?: number;
};

const DEFAULT_TRANSLATE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Translate filters in bounded batches so a big migration doesn't hinge on a
 * single 60+ second Claude call. Defaults to Haiku (this is a bulk paraphrase
 * task — cost and latency dominate, quality is already high enough).
 */
export async function translateFilters(
  filters: GmailFilter[],
  labelMap: Record<string, string>,
  opts: TranslateOptions = {},
): Promise<Array<{ id: string; naturalLanguage: string; actions: Action[] }>> {
  if (filters.length === 0) return [];

  const model = opts.model ?? DEFAULT_TRANSLATE_MODEL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const batchSize = opts.batchSize ?? 15;

  const byIdOut = new Map<string, string>();
  for (let i = 0; i < filters.length; i += batchSize) {
    const chunk = filters.slice(i, i + batchSize);
    const payload = chunk.map((f) => toPayload(f, labelMap));
    const prompt = `${INSTRUCTIONS}\n\nFILTERS:\n${JSON.stringify(payload)}`;
    const result = await runClaudeJson(prompt, BatchResponseSchema, {
      model,
      timeoutMs,
    });
    for (const t of result.translations) byIdOut.set(t.id, t.naturalLanguage);
  }

  return filters.map((f) => ({
    id: f.id!,
    naturalLanguage: byIdOut.get(f.id!) ?? fallbackDescription(f, labelMap),
    actions: deriveActions(f, labelMap),
  }));
}

function fallbackDescription(f: GmailFilter, labelMap: Record<string, string>): string {
  const c = f.criteria ?? {};
  const parts: string[] = [];
  if (c.from) parts.push(`from ${c.from}`);
  if (c.to) parts.push(`to ${c.to}`);
  if (c.subject) parts.push(`subject contains "${c.subject}"`);
  if (c.query) parts.push(`matching "${c.query}"`);
  if (c.hasAttachment) parts.push('with an attachment');
  const condition = parts.length > 0 ? `When email is ${parts.join(' and ')}` : 'For every incoming email';
  const acts = deriveActions(f, labelMap).map(describeAction).join(', then ');
  return `${condition}, ${acts || 'do nothing'}.`;
}

function describeAction(a: Action): string {
  switch (a.type) {
    case 'addLabel':
      return `add label "${a.labelName}"`;
    case 'removeLabel':
      return `remove label "${a.labelName}"`;
    case 'archive':
      return 'archive it';
    case 'markRead':
      return 'mark as read';
    case 'star':
      return 'star it';
    case 'markImportant':
      return 'mark as important';
    case 'trash':
      return 'move to trash';
    case 'forward':
      return `forward to ${a.to}`;
  }
}
