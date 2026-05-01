import { z } from 'zod';
import { prisma } from '../db/client.js';
import { gmailForUser } from './client.js';
import { listLabels } from './filters.js';
import { runClaudeJson } from '../claude/client.js';
import { CANONICAL_LABELS, canonicalBySlug, type CanonicalLabel } from '../canonical-labels.js';
import { pMapLimit } from '../util/concurrency.js';
import { logger } from '../logger.js';
import { safeJson } from '../util/safe-json.js';

const RECOMMEND_MODEL = 'claude-haiku-4-5-20251001';
const SAMPLE_LIMIT = 8;

export type LabelSample = {
  from: string | null;
  subject: string | null;
  snippet: string | null;
  /** When the email arrived via a mailing list / Google Group, the
   *  visible `from` is the list address (rewritten). The real sender
   *  lives here. The taxonomy classifier prefers `originalFrom`
   *  for clustering when present so list-routed Apple mail clusters
   *  under "Apple", not "the list address". */
  originalFrom?: string | null;
  listId?: string | null;
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
 * Core recommend-a-canonical-label flow, parameterised by samples +
 * current-label instead of a GmailFilter row. Used by both the
 * GmailFilter-translate wizard (via `recommendCanonicalLabel`) and the
 * inbox-cleanup wizard (via the `/api/inbox-cleanup/.../label-recommendation`
 * route) so the UX + label taxonomy stays identical across both.
 */
export async function recommendFromSamples(
  samples: LabelSample[],
  opts: {
    currentLabel?: string | null;
    /** Optional criteria context (e.g. filter criteria JSON) for the prompt. */
    criteria?: Record<string, unknown>;
  } = {},
): Promise<LabelRecommendation> {
  const currentLabel = opts.currentLabel ?? null;
  const criteria = opts.criteria ?? {};

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

/**
 * Pick the canonical label for a Gmail filter.
 *   1. Find the Gmail label the filter adds (if any).
 *   2. Pull up to 8 sample emails from that label (or the filter's criteria
 *      if no label is applied).
 *   3. Delegate to `recommendFromSamples` for prompting + taxonomy mapping.
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

  return recommendFromSamples(samples, { currentLabel, criteria });
}

/**
 * Fetch up to SAMPLE_LIMIT messages matching a Gmail `q:` query and
 * reduce each to (from, subject, snippet). Exposed so the inbox-cleanup
 * route can pull samples using the proposer's gmailQuery without needing
 * access to a `GmailFilter` row.
 */
export async function fetchLabelSamplesForQuery(
  userId: string,
  gmailQuery: string,
): Promise<LabelSample[]> {
  if (!gmailQuery.trim()) return [];
  return fetchSamplesByQuery(userId, gmailQuery);
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
  const q = currentLabel
    ? `label:${JSON.stringify(currentLabel)}`
    : buildCriteriaQuery(criteria);
  if (!q) return [];
  return fetchSamplesByQuery(userId, q);
}

/**
 * Shared sample-fetcher: runs a Gmail search for `q` and returns up to
 * SAMPLE_LIMIT compact metadata rows. Kept as its own function so both
 * the filter-translate flow and the inbox-cleanup flow feed the same
 * prompt context to the taxonomy-picker.
 */
async function fetchSamplesByQuery(userId: string, q: string): Promise<LabelSample[]> {
  const gmail = await gmailForUser(userId);
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
        metadataHeaders: [
          'From',
          'Subject',
          'List-ID',
          'List-Id',
          'Reply-To',
          'Sender',
          'X-Original-From',
          'X-Google-Original-From',
        ],
      });
      const headers = res.data.payload?.headers ?? [];
      const h = (name: string) =>
        headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
      const listIdRaw = h('List-ID') ?? h('List-Id');
      const listId = listIdRaw
        ? (/<([^>]+)>/.exec(listIdRaw)?.[1] ?? listIdRaw).trim().toLowerCase()
        : null;
      const fromHeader = h('From');
      const originalCandidate =
        h('X-Original-From') ?? h('X-Google-Original-From') ?? h('Reply-To') ?? h('Sender');
      const originalFrom =
        originalCandidate &&
        // only meaningful when it differs from the visible From
        (() => {
          const norm = (s: string | null): string | null => {
            if (!s) return null;
            const m = /<([^>]+)>/.exec(s);
            return (m && m[1] ? m[1] : s).trim().toLowerCase();
          };
          return norm(originalCandidate) !== norm(fromHeader);
        })()
          ? originalCandidate
          : null;
      return {
        from: fromHeader,
        subject: h('Subject'),
        snippet: res.data.snippet ?? null,
        originalFrom,
        listId,
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
          .map((s, i) => {
            // When the email arrived via a list / Google Group, the
            // visible From was rewritten (e.g. "'Apple' via Zeligs
            // <list@…>"). Surface the originalFrom + listId so the
            // taxonomy classifier picks the brand from the real
            // sender rather than the list rewrite.
            const lines = [
              `${i + 1}. From: ${s.from ?? '?'}`,
              s.originalFrom ? `   Original sender: ${s.originalFrom}` : null,
              s.listId ? `   Via list: ${s.listId}` : null,
              `   Subject: ${s.subject ?? '?'}`,
              `   Snippet: ${(s.snippet ?? '').slice(0, 160)}`,
            ].filter(Boolean);
            return lines.join('\n');
          })
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
- Only use slugs listed above. Do NOT invent new slugs.
- MAILING LISTS: when a sample includes "Original sender" / "Via list",
  the visible From is the LIST address (rewritten by Google Groups /
  Mailman / etc.). Cluster by the brand of the ORIGINAL sender, not
  the list — e.g. "Apple via Zeligs" forwarding insideapple.apple.com
  emails belongs in "Marketing/Apple", not "Marketing/Zeligs".`;
}

export { listLabels };
