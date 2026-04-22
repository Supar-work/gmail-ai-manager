import { z } from 'zod';
import { prisma } from '../db/client.js';
import { gmailForUser } from './client.js';
import { listLabels } from './filters.js';
import { runClaudeJson } from '../claude/client.js';
import { CANONICAL_LABELS, canonicalBySlug, type CanonicalLabel } from '../canonical-labels.js';
import { pMapLimit } from '../util/concurrency.js';
import { logger } from '../logger.js';

const RECOMMEND_MODEL = 'claude-haiku-4-5-20251001';
const SAMPLE_LIMIT = 8;

export type LabelSample = {
  from: string | null;
  subject: string | null;
  snippet: string | null;
};

export type LabelRecommendation = {
  slug: string;
  canonicalLabel: string;
  labelPath: string;
  disposition: 'inbox' | 'archive';
  placeholderFilled: string | null;
  confidence: number;
  reasoning: string;
  samples: LabelSample[];
  /** Original Gmail label the filter currently adds, if any. */
  currentLabel: string | null;
};

const RecommendSchema = z.object({
  slug: z.string().min(1),
  placeholderFilled: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().min(1),
});

/**
 * Pick the canonical label for a Gmail filter.
 *   1. Find the Gmail label the filter adds (if any).
 *   2. Pull up to 8 sample emails from that label (or the filter's criteria
 *      if no label is applied).
 *   3. Ask Claude to match the samples to a slug from the taxonomy and fill
 *      any <Placeholder> in the default label path with a specific brand /
 *      vendor inferred from the samples.
 */
export async function recommendCanonicalLabel(
  userId: string,
  mirrorId: string,
): Promise<LabelRecommendation> {
  const row = await prisma.gmailFilter.findFirst({ where: { id: mirrorId, userId } });
  if (!row) throw new Error('not_found');

  const criteria = safeJson<Record<string, unknown>>(row.criteriaJson, {});
  const action = safeJson<{ addLabelIds?: string[] }>(row.actionJson, {});
  const labelMap = safeJson<Record<string, string>>(row.labelMap, {});

  const currentLabel = resolveCurrentLabel(action.addLabelIds, labelMap);
  const samples = await fetchSamples(userId, currentLabel, criteria);

  const taxonomyText = CANONICAL_LABELS.map(
    (c) =>
      `- ${c.slug}: ${c.label} → ${c.defaultLabelPath || '(no label)'}` +
      (c.placeholder ? ` [fill ${c.placeholder}]` : '') +
      ` · ${c.disposition}`,
  ).join('\n');

  const prompt = buildPrompt({
    taxonomyText,
    currentLabel,
    criteria,
    samples,
  });

  const raw = await runClaudeJson(prompt, RecommendSchema, {
    model: RECOMMEND_MODEL,
    timeoutMs: 45_000,
  });

  const canonical = canonicalBySlug(raw.slug) ?? canonicalBySlug('skip')!;
  const labelPath = materializeLabelPath(canonical, raw.placeholderFilled);

  return {
    slug: canonical.slug,
    canonicalLabel: canonical.label,
    labelPath,
    disposition: canonical.disposition,
    placeholderFilled: raw.placeholderFilled ?? null,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.6,
    reasoning: raw.reasoning,
    samples,
    currentLabel,
  };
}

function resolveCurrentLabel(
  addLabelIds: string[] | undefined,
  labelMap: Record<string, string>,
): string | null {
  if (!addLabelIds) return null;
  for (const id of addLabelIds) {
    // System labels (STARRED, IMPORTANT, INBOX) don't correspond to a folder.
    if (/^[A-Z_]+$/.test(id)) continue;
    const name = labelMap[id];
    if (name) return name;
  }
  return null;
}

async function fetchSamples(
  userId: string,
  currentLabel: string | null,
  criteria: Record<string, unknown>,
): Promise<LabelSample[]> {
  const gmail = await gmailForUser(userId);

  const q = currentLabel
    ? `label:${JSON.stringify(currentLabel)}`
    : buildCriteriaQuery(criteria);
  if (!q) return [];

  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: SAMPLE_LIMIT,
    });
    const ids = (listRes.data.messages ?? []).map((m) => m.id).filter((x): x is string => !!x);
    if (ids.length === 0) return [];

    return await pMapLimit(ids, 4, async (id) => {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
      });
      const headers = res.data.payload?.headers ?? [];
      const h = (name: string) =>
        headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
      return {
        from: h('From'),
        subject: h('Subject'),
        snippet: res.data.snippet ?? null,
      };
    });
  } catch (err) {
    logger.warn({ err, userId, q }, 'sample fetch failed');
    return [];
  }
}

function buildCriteriaQuery(c: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof c.from === 'string') parts.push(`from:${JSON.stringify(c.from)}`);
  if (typeof c.to === 'string') parts.push(`to:${JSON.stringify(c.to)}`);
  if (typeof c.subject === 'string') parts.push(`subject:${JSON.stringify(c.subject)}`);
  if (typeof c.query === 'string') parts.push(c.query);
  return parts.join(' ');
}

function materializeLabelPath(
  canonical: CanonicalLabel,
  placeholderFilled: string | null | undefined,
): string {
  if (!canonical.placeholder) return canonical.defaultLabelPath;
  if (!placeholderFilled || !placeholderFilled.trim()) {
    // Drop the placeholder segment if the model declined to fill it.
    return canonical.defaultLabelPath.split('/').slice(0, -1).join('/');
  }
  return canonical.defaultLabelPath.replace(canonical.placeholder, placeholderFilled.trim());
}

function buildPrompt({
  taxonomyText,
  currentLabel,
  criteria,
  samples,
}: {
  taxonomyText: string;
  currentLabel: string | null;
  criteria: Record<string, unknown>;
  samples: LabelSample[];
}): string {
  const samplesText =
    samples.length === 0
      ? '(no samples available)'
      : samples
          .slice(0, SAMPLE_LIMIT)
          .map(
            (s, i) =>
              `${i + 1}. From: ${s.from ?? '?'}\n   Subject: ${s.subject ?? '?'}\n   Snippet: ${(s.snippet ?? '').slice(0, 160)}`,
          )
          .join('\n');

  return `You're categorizing a Gmail filter into a canonical label taxonomy for a mail-cleanup tool.

TAXONOMY (pick exactly one slug):
${taxonomyText}

FILTER INFO:
Current Gmail label: ${currentLabel ?? '(none — filter applies labels like Starred/Important only, or just archives)'}
Filter criteria: ${JSON.stringify(criteria)}

SAMPLE EMAILS (up to ${SAMPLE_LIMIT}):
${samplesText}

Respond with ONE JSON object, no code fences, no prose:
{
  "slug": "<exact slug from taxonomy>",
  "placeholderFilled": "<specific brand/service/vendor/source/retailer/institution, or null if the slug has no placeholder or samples don't justify a single one>",
  "confidence": <0..1 — how confident this is the right slug>,
  "reasoning": "<one short sentence: why this slug fits>"
}

Rules:
- Prefer a 2-level label. Fill the placeholder with the specific sub-category
  inferred from the samples (brand, school, employer, service name, etc.) in
  title-case, e.g. "Nike", "Basis", "Stripe", "Delta", "Mary".
- Only return null for placeholderFilled if the samples clearly span many
  unrelated sub-categories — never as a lazy default.
- If the current Gmail label already names a sub-category (e.g. "Basis",
  "Nike"), reuse that name as placeholderFilled unless the samples clearly
  contradict it.
- "skip" is for filters where no category cleanly applies.
- Only use slugs listed above. Do NOT invent new slugs.`;
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export { listLabels };
