import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiSend } from '../lib/api.js';

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

  const [overridePath, setOverridePath] = useState<string | null>(null);
  const [migrateResult, setMigrateResult] = useState<MigrateResult | null>(null);
  const [migrateExisting, setMigrateExisting] = useState(true);

  // Reset when we switch to a different filter.
  useEffect(() => {
    setOverridePath(null);
    setMigrateResult(null);
    setMigrateExisting(true);
  }, [mirrorId]);

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
  const activePath = overridePath ?? r.labelPath;
  const unchanged = r.currentLabel != null && r.currentLabel === activePath;

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
          <input
            className="label-rec-path"
            value={activePath}
            onChange={(e) => setOverridePath(e.target.value)}
            spellCheck={false}
          />
          <span
            className={`chip ${r.disposition === 'archive' ? 'warn' : 'accent'}`}
            title={`Category: ${r.canonicalLabel} · default disposition: ${r.disposition}`}
          >
            {r.canonicalLabel} · {r.disposition}
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
