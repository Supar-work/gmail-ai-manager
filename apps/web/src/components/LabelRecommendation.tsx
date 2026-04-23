import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiSend } from '../lib/api.js';

// Top-level buckets from the canonical taxonomy, hard-coded for UI speed.
// Keep in sync with apps/api/src/canonical-labels.ts.
const TOP_LEVELS: Array<{ name: string; disposition: 'inbox' | 'archive' }> = [
  { name: 'Family', disposition: 'inbox' },
  { name: 'Friends', disposition: 'inbox' },
  { name: 'Work', disposition: 'inbox' },
  { name: 'Action', disposition: 'inbox' },
  { name: 'Notifications', disposition: 'archive' },
  { name: 'Marketing', disposition: 'archive' },
  { name: 'Subscriptions', disposition: 'archive' },
  { name: 'Receipts', disposition: 'archive' },
  { name: 'Shopping', disposition: 'archive' },
  { name: 'Finance', disposition: 'archive' },
  { name: 'Travel', disposition: 'archive' },
];
const CUSTOM_SENTINEL = '__custom__';

function splitPath(path: string): { top: string; sub: string } {
  if (!path) return { top: '', sub: '' };
  const idx = path.indexOf('/');
  if (idx < 0) return { top: path, sub: '' };
  return { top: path.slice(0, idx), sub: path.slice(idx + 1) };
}

function joinPath(top: string, sub: string): string {
  const t = top.trim();
  const s = sub.trim();
  if (!t) return '';
  return s ? `${t}/${s}` : t;
}

export type Recommendation = {
  slug: string;
  canonicalLabel: string;
  labelPath: string;
  disposition: 'inbox' | 'archive';
  placeholderFilled: string | null;
  confidence: number;
  reasoning: string;
  samples: Array<{ from: string | null; subject: string | null; snippet: string | null }>;
  currentLabel: string | null;
};

type MigrateResult = {
  labelId: string;
  moved: number;
  errors: string[];
};

/**
 * Shown on each wizard page after the AI rule translation. Fetches a
 * canonical-label recommendation based on sample emails; user can accept
 * (optionally migrating all existing emails to the new label path) or keep
 * their current label.
 *
 * `onApplied` fires after a successful migration so the parent wizard can
 * rewrite the AI rule text to reference the new label path.
 */
export function LabelRecommendation({
  mirrorId,
  onApplied,
}: {
  mirrorId: string;
  onApplied?: (info: { oldLabelName: string | null; newLabelPath: string }) => void;
}) {
  const rec = useQuery<Recommendation>({
    queryKey: ['label-recommendation', mirrorId],
    queryFn: () => apiGet<Recommendation>(`/api/gmail-filters/${mirrorId}/label-recommendation`),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  const [topLevel, setTopLevel] = useState<string>('');
  const [subLevel, setSubLevel] = useState<string>('');
  const [topIsCustom, setTopIsCustom] = useState(false);
  const [migrateResult, setMigrateResult] = useState<MigrateResult | null>(null);
  const [migrateExisting, setMigrateExisting] = useState(true);

  // Reset whenever we land on a different filter. Triggered on mirrorId so
  // the user's typed edits don't leak between wizard pages.
  useEffect(() => {
    setTopLevel('');
    setSubLevel('');
    setTopIsCustom(false);
    setMigrateResult(null);
    setMigrateExisting(true);
  }, [mirrorId]);

  // Seed the inputs from the recommendation the first time it arrives for
  // this filter (or when it changes because the cache invalidated).
  useEffect(() => {
    if (!rec.data) return;
    const { top, sub } = splitPath(rec.data.labelPath);
    setTopLevel(top);
    setSubLevel(sub);
    setTopIsCustom(top !== '' && !TOP_LEVELS.some((t) => t.name === top));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.data?.labelPath, mirrorId]);

  const migrate = useMutation<MigrateResult, Error, { newLabelPath: string; oldLabelName: string | null }>({
    mutationFn: (body) => apiSend<MigrateResult>('POST', `/api/gmail-filters/${mirrorId}/migrate-label`, body),
    onSuccess: (data, vars) => {
      setMigrateResult(data);
      onApplied?.({ oldLabelName: vars.oldLabelName, newLabelPath: vars.newLabelPath });
    },
  });

  if (rec.isLoading) {
    return (
      <div className="label-rec translate-pending">
        <span className="spinner" />
        <span>Analyzing sample emails for a canonical label…</span>
      </div>
    );
  }
  if (rec.isError) {
    return (
      <div className="banner error" style={{ marginTop: '0.4rem' }}>
        Couldn't recommend a label: {(rec.error as Error).message}
      </div>
    );
  }
  if (!rec.data) return null;

  const r = rec.data;
  const activePath = joinPath(topLevel, subLevel);
  const unchanged = r.currentLabel != null && r.currentLabel === activePath;
  const knownTop = TOP_LEVELS.find((t) => t.name === topLevel);
  const disposition: 'inbox' | 'archive' = knownTop?.disposition ?? r.disposition;
  const selectValue = topIsCustom ? CUSTOM_SENTINEL : topLevel;

  return (
    <div className="label-rec">
      <div
        className="muted"
        style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        Suggested label
      </div>
      <div className="label-rec-body">
        <div className="label-rec-row">
          <span
            className="label-rec-current chip"
            title={r.currentLabel ? 'Current Gmail label' : 'No existing Gmail label'}
          >
            {r.currentLabel ?? '(no current label)'}
          </span>
          <span className="label-rec-arrow muted">→</span>

          <select
            className="label-rec-top"
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_SENTINEL) {
                setTopIsCustom(true);
              } else {
                setTopIsCustom(false);
                setTopLevel(v);
              }
            }}
            title="Top-level category"
          >
            {TOP_LEVELS.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
            <option value={CUSTOM_SENTINEL}>Custom…</option>
          </select>

          {topIsCustom && (
            <input
              className="label-rec-custom-top"
              value={topLevel}
              onChange={(e) => setTopLevel(e.target.value)}
              placeholder="Custom top-level"
              spellCheck={false}
            />
          )}

          <span className="label-rec-sep muted">/</span>

          <input
            className="label-rec-sub"
            value={subLevel}
            onChange={(e) => setSubLevel(e.target.value)}
            placeholder="(optional sub-category)"
            spellCheck={false}
          />

          <span
            className={`chip ${disposition === 'archive' ? 'warn' : 'accent'}`}
            title={`Default disposition for ${topLevel || 'this category'}`}
          >
            {disposition}
          </span>
        </div>

        <div className="muted" style={{ fontSize: '0.78rem' }}>
          {r.reasoning}
          {' · '}confidence {(r.confidence * 100).toFixed(0)}%
        </div>

        {r.samples.length > 0 && (
          <details className="label-rec-samples">
            <summary className="muted" style={{ fontSize: '0.78rem' }}>
              Based on {r.samples.length} sample email{r.samples.length === 1 ? '' : 's'}
            </summary>
            <ul style={{ fontSize: '0.78rem', margin: '0.3rem 0 0', paddingLeft: '1rem' }}>
              {r.samples.map((s, i) => (
                <li key={i} className="muted" style={{ lineHeight: 1.35 }}>
                  <strong>{s.from ?? '(unknown sender)'}</strong>
                  {s.subject ? ` — ${s.subject}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}

        {r.currentLabel && !unchanged && (
          <label className="row" style={{ gap: '0.4rem', fontSize: '0.82rem' }}>
            <input
              type="checkbox"
              checked={migrateExisting}
              onChange={(e) => setMigrateExisting(e.target.checked)}
            />
            Also move existing emails from <strong>{r.currentLabel}</strong> to{' '}
            <strong>{activePath}</strong>
          </label>
        )}

        {migrate.isError && (
          <div className="banner error">
            Migration failed: {(migrate.error as Error).message}
          </div>
        )}
        {migrateResult && (
          <div className="banner info">
            {migrateResult.moved > 0
              ? `Moved ${migrateResult.moved} email${migrateResult.moved === 1 ? '' : 's'} to ${activePath}.`
              : `Label ${activePath} ensured. Nothing to move.`}
            {migrateResult.errors.length > 0 && (
              <div className="rule-preview-warn" style={{ marginTop: '0.3rem' }}>
                {migrateResult.errors.length} batch
                {migrateResult.errors.length === 1 ? '' : 'es'} errored — some messages may not
                have moved.
              </div>
            )}
          </div>
        )}

        <div className="row">
          {!migrateResult ? (
            <button
              className="primary"
              onClick={() =>
                migrate.mutate({
                  newLabelPath: activePath,
                  oldLabelName: migrateExisting ? r.currentLabel : null,
                })
              }
              disabled={migrate.isPending || !activePath.trim() || unchanged}
              title={
                unchanged
                  ? 'Label already matches'
                  : !activePath.trim()
                    ? 'Label path is empty'
                    : migrateExisting
                      ? 'Create label and move existing emails'
                      : 'Create label only'
              }
            >
              {migrate.isPending
                ? 'Migrating…'
                : unchanged
                  ? 'Label matches'
                  : migrateExisting
                    ? `Use "${activePath}" & migrate emails`
                    : `Use "${activePath}"`}
            </button>
          ) : (
            <button onClick={() => setMigrateResult(null)}>Done — review again</button>
          )}
        </div>
      </div>
    </div>
  );
}
