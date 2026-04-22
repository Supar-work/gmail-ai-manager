import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Action } from '@gaf/shared';
import { apiGet, apiSend, ApiError } from '../lib/api.js';
import { RuleCheckPanel } from './RuleAnalyzer.js';
import { LabelRecommendation } from './LabelRecommendation.js';

export type GmailFilterCriteria = {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: 'larger' | 'smaller';
};
export type GmailFilterAction = {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
};
export type GmailFilterRow = {
  id: string;
  currentGmailId: string | null;
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
  labelMap: Record<string, string>;
  naturalLanguage: string | null;
  enabled: boolean;
  signature: string;
  syncedAt: string;
  updatedAt: string;
};
export type GmailFilterSyncResult = {
  seen: number;
  created: number;
  updated: number;
  deactivated: number;
};

type TranslatePreview = {
  mirrorId: string;
  naturalLanguage: string;
  actions: Action[];
};
type TranslateResponse = { previews: TranslatePreview[] };
type MaterializeResponse = {
  ruleIds: string[];
  disabledCount: number;
  disableErrors: Array<{ mirrorId: string; error: string }>;
};

export function useGmailFiltersQuery() {
  return useQuery<{ filters: GmailFilterRow[] }>({
    queryKey: ['gmail-filters'],
    queryFn: () => apiGet('/api/gmail-filters'),
    retry: false,
  });
}

/**
 * Kick off a Gmail → mirror sync once per page load. Silent failure — the
 * explicit "Sync from Gmail" button stays available for retry.
 */
export function useAutoSyncOnMount(): void {
  const qc = useQueryClient();
  const hasRun = useRef(false);
  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    (async () => {
      try {
        await apiSend('POST', '/api/gmail-filters/sync');
        qc.invalidateQueries({ queryKey: ['gmail-filters'] });
      } catch {
        /* ignore */
      }
    })();
  }, [qc]);
}

export function GmailFiltersList() {
  const qc = useQueryClient();
  const list = useGmailFiltersQuery();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wizardRows, setWizardRows] = useState<GmailFilterRow[] | null>(null);

  const sync = useMutation<GmailFilterSyncResult>({
    mutationFn: () => apiSend('POST', '/api/gmail-filters/sync'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail-filters'] }),
  });

  const toggle = useMutation<unknown, Error, { id: string; next: boolean }>({
    mutationFn: ({ id, next }) =>
      apiSend('POST', `/api/gmail-filters/${id}/${next ? 'enable' : 'disable'}`),
    onMutate: async ({ id, next }) => {
      await qc.cancelQueries({ queryKey: ['gmail-filters'] });
      const prev = qc.getQueryData<{ filters: GmailFilterRow[] }>(['gmail-filters']);
      if (prev) {
        qc.setQueryData<{ filters: GmailFilterRow[] }>(['gmail-filters'], {
          filters: prev.filters.map((f) => (f.id === id ? { ...f, enabled: next } : f)),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      const prev = (ctx as { prev?: { filters: GmailFilterRow[] } } | undefined)?.prev;
      if (prev) qc.setQueryData(['gmail-filters'], prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['gmail-filters'] }),
  });

  const rows = list.data?.filters ?? [];
  const enabledRows = rows.filter((r) => r.enabled);
  const selectedIds = [...selected].filter((id) => rows.some((r) => r.id === id));
  const hasSelection = selectedIds.length > 0;

  function toggleSelect(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function startWizardFor(rowsToTranslate: GmailFilterRow[]) {
    setWizardRows(rowsToTranslate);
  }

  return (
    <section className="rules-section">
      <div className="rules-section-head">
        <div className="muted" style={{ fontSize: '0.82rem' }}>
          {rows.length === 0
            ? 'Mirror of your Gmail filters. We keep the definition — toggle controls Gmail.'
            : `${enabledRows.length} active in Gmail · ${rows.length - enabledRows.length} saved but disabled`}
        </div>
        <div className="row">
          {hasSelection ? (
            <button
              className="primary"
              onClick={() =>
                startWizardFor(rows.filter((r) => selectedIds.includes(r.id)))
              }
            >
              Translate selected ({selectedIds.length})
            </button>
          ) : (
            <button
              onClick={() => startWizardFor(enabledRows)}
              disabled={enabledRows.length === 0}
              title={
                enabledRows.length === 0
                  ? 'No active Gmail filters to translate'
                  : 'Translate every active Gmail filter to an AI rule'
              }
            >
              Translate all to AI rules
            </button>
          )}
          <button onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync from Gmail'}
          </button>
        </div>
      </div>

      {sync.isError && (
        <div className="banner error">Sync failed: {(sync.error as Error).message}</div>
      )}
      {sync.isSuccess && sync.data && (
        <div className="muted" style={{ fontSize: '0.78rem' }}>
          Synced · seen {sync.data.seen} · new {sync.data.created} · refreshed{' '}
          {sync.data.updated} · marked disabled {sync.data.deactivated}
        </div>
      )}
      {toggle.isError && (
        <div className="banner error">Toggle failed: {(toggle.error as Error).message}</div>
      )}

      {list.isLoading && <div className="muted">Loading filters…</div>}
      {list.isError && (
        <div className="banner error">
          {list.error instanceof ApiError && list.error.code === 'needs_reauth'
            ? 'Gmail connection expired — sign in again.'
            : `Couldn't load filters: ${(list.error as Error).message}`}
        </div>
      )}

      {!list.isLoading && rows.length === 0 && !list.isError && (
        <div className="empty">
          No Gmail filters saved yet. Click <strong>Sync from Gmail</strong> to pull your current set.
        </div>
      )}

      {rows.length > 0 && (
        <div className="gmail-filter-list">
          {rows.map((r) => (
            <GmailFilterRowView
              key={r.id}
              row={r}
              selected={selected.has(r.id)}
              onSelectToggle={(on) => toggleSelect(r.id, on)}
              onEnabledToggle={(next) => toggle.mutate({ id: r.id, next })}
              onTranslate={() => startWizardFor([r])}
              togglePending={toggle.isPending && toggle.variables?.id === r.id}
            />
          ))}
        </div>
      )}

      {wizardRows && (
        <TranslateWizard
          rows={wizardRows}
          onClose={() => {
            setWizardRows(null);
            setSelected(new Set());
          }}
        />
      )}
    </section>
  );
}

function GmailFilterRowView({
  row,
  selected,
  onSelectToggle,
  onEnabledToggle,
  onTranslate,
  togglePending,
}: {
  row: GmailFilterRow;
  selected: boolean;
  onSelectToggle: (on: boolean) => void;
  onEnabledToggle: (next: boolean) => void;
  onTranslate: () => void;
  togglePending: boolean;
}) {
  const criteriaChips = describeCriteria(row.criteria);
  const actionChips = describeFilterAction(row.action, row.labelMap);
  return (
    <div className="gmail-filter-row" style={{ opacity: row.enabled ? 1 : 0.6 }}>
      <input
        type="checkbox"
        className="gmail-filter-select"
        checked={selected}
        onChange={(e) => onSelectToggle(e.target.checked)}
        title="Select for batch translate"
      />
      <label
        className="toggle-switch"
        title={row.enabled ? 'Active in Gmail' : 'Saved (not in Gmail)'}
      >
        <input
          type="checkbox"
          checked={row.enabled}
          disabled={togglePending}
          onChange={(e) => onEnabledToggle(e.target.checked)}
        />
        <span className="toggle-switch-track">
          <span className="toggle-switch-knob" />
        </span>
      </label>
      <div className="gmail-filter-body">
        <div className="gmail-filter-criteria">
          {criteriaChips.length === 0 ? (
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              (no conditions — matches every email)
            </span>
          ) : (
            criteriaChips.map((c, i) => (
              <span key={i} className="chip">
                {c}
              </span>
            ))
          )}
        </div>
        <div className="gmail-filter-actions">
          {actionChips.length === 0 ? (
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              —
            </span>
          ) : (
            actionChips.map((a, i) => (
              <span key={i} className={`chip ${a.kind}`}>
                {a.label}
              </span>
            ))
          )}
        </div>
      </div>
      <button
        className="gmail-filter-translate"
        onClick={onTranslate}
        title="Translate this filter to an AI rule"
      >
        Translate
      </button>
      <div className="gmail-filter-status muted" style={{ fontSize: '0.72rem' }}>
        {row.enabled ? 'In Gmail' : 'Saved'}
      </div>
    </div>
  );
}

// ── translate wizard (per-filter stepper) ─────────────────────────────────
//
// One Gmail filter per page. Translations stream in a background pool so
// later filters are pre-fetched while the user reviews the first. Each page
// saves as a single-item materialize call — if the user quits midway, the
// rules they've already committed stay; the rest is simply undone work.

const TRANSLATE_PARALLEL = 3;

type MaterializeOne = { ruleId: string; disabled: boolean };

function TranslateWizard({
  rows,
  onClose,
}: {
  rows: GmailFilterRow[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [index, setIndex] = useState(0);
  const [previews, setPreviews] = useState<Record<string, TranslatePreview>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [disableMap, setDisableMap] = useState<Record<string, boolean>>({});
  const [committedIds, setCommittedIds] = useState<string[]>([]);
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const [skippedIds, setSkippedIds] = useState<string[]>([]);
  const [failedTranslations, setFailedTranslations] = useState<Record<string, string>>({});
  const [finished, setFinished] = useState(false);
  // Mirror ID currently being rewritten via Claude (after a label apply). Used
  // to show an inline indicator and lock the textarea briefly.
  const [rewritingId, setRewritingId] = useState<string | null>(null);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (rows.length === 0) return;
    const queue = rows.map((r) => r.id);
    let aborted = false;
    let next = 0;

    async function worker() {
      while (!aborted) {
        const i = next++;
        if (i >= queue.length) return;
        const mirrorId = queue[i]!;
        try {
          const res = await apiSend<TranslateResponse>(
            'POST',
            '/api/gmail-filters/translate',
            { mirrorIds: [mirrorId] },
          );
          if (aborted) return;
          const preview = res.previews[0];
          if (preview) {
            setPreviews((prev) => ({ ...prev, [mirrorId]: preview }));
          }
        } catch (err) {
          if (aborted) return;
          setFailedTranslations((prev) => ({
            ...prev,
            [mirrorId]: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    }

    Promise.all(
      Array.from({ length: Math.min(TRANSLATE_PARALLEL, queue.length) }, () => worker()),
    ).catch(() => {
      /* per-item errors already captured */
    });

    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = rows[index];
  const currentPreview = current ? previews[current.id] : undefined;
  const currentText = current
    ? edits[current.id] ?? currentPreview?.naturalLanguage ?? ''
    : '';
  const currentDisable = current ? disableMap[current.id] ?? true : true;
  const currentCommitted = current ? committedIds.includes(current.id) : false;
  const currentSkipped = current ? skippedIds.includes(current.id) : false;
  const currentFailed = current ? failedTranslations[current.id] : undefined;
  const translationReady = currentPreview != null;
  const isLastPage = index === rows.length - 1;

  const materialize = useMutation<MaterializeResponse, Error, MaterializeOne>({
    mutationFn: async () => {
      if (!current || !currentPreview) throw new Error('not_ready');
      return apiSend<MaterializeResponse>('POST', '/api/gmail-filters/materialize', {
        items: [
          {
            mirrorId: current.id,
            naturalLanguage: currentText.trim(),
            actions: currentPreview.actions,
          },
        ],
        disableSources: currentDisable,
      });
    },
    onSuccess: async (data) => {
      if (!current) return;
      setCommittedIds((prev) => (prev.includes(current.id) ? prev : [...prev, current.id]));
      if (data.disabledCount > 0) {
        setDisabledIds((prev) => (prev.includes(current.id) ? prev : [...prev, current.id]));
      }
      await qc.invalidateQueries({ queryKey: ['rules'] });
      await qc.invalidateQueries({ queryKey: ['gmail-filters'] });
      advance();
    },
  });

  function advance() {
    if (isLastPage) setFinished(true);
    else setIndex((i) => i + 1);
  }

  function skip() {
    if (!current) return;
    setSkippedIds((prev) => (prev.includes(current.id) ? prev : [...prev, current.id]));
    advance();
  }

  function goPrev() {
    setIndex((i) => Math.max(0, i - 1));
  }

  if (finished) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
          <h3 style={{ marginTop: 0 }}>All done</h3>
          <div className="panel" style={{ fontSize: '0.9rem' }}>
            <div>
              <strong>{committedIds.length}</strong> AI rule
              {committedIds.length === 1 ? '' : 's'} created.
            </div>
            <div>
              <strong>{disabledIds.length}</strong> Gmail filter
              {disabledIds.length === 1 ? '' : 's'} disabled.
            </div>
            {skippedIds.length > 0 && (
              <div className="muted">{skippedIds.length} skipped.</div>
            )}
            {Object.keys(failedTranslations).length > 0 && (
              <div className="muted" style={{ marginTop: '0.4rem' }}>
                {Object.keys(failedTranslations).length} filter
                {Object.keys(failedTranslations).length === 1 ? '' : 's'} failed to translate.
              </div>
            )}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="muted">No filters to translate.</div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const originalCriteria = describeCriteria(current.criteria);
  const originalActions = describeFilterAction(current.action, current.labelMap);
  const translationsReady = Object.keys(previews).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.3rem' }}>
          <h3 style={{ margin: 0 }}>Translate Gmail filter → AI rule</h3>
          <button onClick={onClose} disabled={materialize.isPending}>
            ×
          </button>
        </div>
        <div className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
          Filter {index + 1} of {rows.length} · {committedIds.length} saved
          {skippedIds.length ? ` · ${skippedIds.length} skipped` : ''}
          {translationsReady < rows.length
            ? ` · ${rows.length - translationsReady} still translating`
            : ''}
        </div>

        <div className="translate-progress-bar" style={{ marginBottom: '0.75rem' }}>
          <div
            className="translate-progress-fill"
            style={{ width: `${Math.round(((index + 1) / rows.length) * 100)}%` }}
          />
        </div>

        <div className="panel" style={{ fontSize: '0.85rem', marginBottom: '0.6rem' }}>
          <div
            className="muted"
            style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            Original Gmail filter
          </div>
          <div style={{ marginTop: '0.35rem' }}>
            <div className="row wrap" style={{ gap: '0.3rem', marginBottom: '0.3rem' }}>
              <span className="muted" style={{ fontSize: '0.72rem' }}>
                Matches:
              </span>
              {originalCriteria.length === 0 ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  (every email)
                </span>
              ) : (
                originalCriteria.map((c, i) => (
                  <span key={i} className="chip">
                    {c}
                  </span>
                ))
              )}
            </div>
            <div className="row wrap" style={{ gap: '0.3rem' }}>
              <span className="muted" style={{ fontSize: '0.72rem' }}>
                Action:
              </span>
              {originalActions.length === 0 ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  —
                </span>
              ) : (
                originalActions.map((a, i) => (
                  <span key={i} className={`chip ${a.kind}`}>
                    {a.label}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>

        {!translationReady && !currentFailed && (
          <div className="translate-pending" style={{ marginBottom: '0.6rem' }}>
            <span className="spinner" />
            <span>Translating…</span>
          </div>
        )}
        {currentFailed && (
          <div className="banner error">
            Translation failed: {currentFailed}. You can still type an AI rule manually below.
          </div>
        )}
        {(translationReady || currentFailed) && (
          <>
            <label
              className="muted"
              style={{
                fontSize: '0.7rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              AI rule
            </label>
            <textarea
              value={currentText}
              onChange={(e) => setEdits((prev) => ({ ...prev, [current.id]: e.target.value }))}
              rows={3}
              placeholder='e.g. "when email is from X, archive it"'
              style={{ marginBottom: '0.4rem' }}
              disabled={rewritingId === current.id}
            />
            {rewritingId === current.id && (
              <div className="muted" style={{ fontSize: '0.78rem', marginBottom: '0.4rem' }}>
                <span className="spinner" style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
                Rewriting rule to use the new label…
              </div>
            )}
            <RuleCheckPanel
              nl={currentText}
              onAcceptRewrite={(s) => setEdits((prev) => ({ ...prev, [current.id]: s }))}
            />

            <LabelRecommendation
              mirrorId={current.id}
              onApplied={({ oldLabelName, newLabelPath }) => {
                if (!current) return;
                // Ask Claude to rewrite the AI rule against the new label
                // path. Regex substitution over arbitrary prose was too
                // fragile (substring matches, missing-label cases, etc.).
                const baseText =
                  edits[current.id] ?? currentPreview?.naturalLanguage ?? '';
                void rewriteRuleForLabel({
                  mirrorId: current.id,
                  baseText,
                  oldLabelName,
                  newLabelPath,
                  onUpdate: (updated) =>
                    setEdits((prev) => ({ ...prev, [current.id]: updated })),
                  setRewriting: (on) =>
                    setRewritingId(on ? current.id : null),
                });
              }}
            />

            <label
              className="row"
              style={{ gap: '0.4rem', fontSize: '0.88rem', marginTop: '0.5rem' }}
            >
              <input
                type="checkbox"
                checked={currentDisable}
                onChange={(e) =>
                  setDisableMap((prev) => ({ ...prev, [current.id]: e.target.checked }))
                }
              />
              Disable this filter in Gmail after saving
              {!currentDisable && (
                <span className="muted" style={{ fontSize: '0.75rem', marginLeft: '0.3rem' }}>
                  ⚠ both Gmail and the AI rule will act on incoming mail
                </span>
              )}
            </label>
          </>
        )}

        {materialize.isError && (
          <div className="banner error" style={{ marginTop: '0.5rem' }}>
            {(materialize.error as Error).message}
          </div>
        )}
        {currentCommitted && (
          <div className="banner info" style={{ marginTop: '0.5rem' }}>
            Already saved on a previous pass.
          </div>
        )}

        <div className="row" style={{ justifyContent: 'space-between', marginTop: '0.8rem' }}>
          <button onClick={goPrev} disabled={index === 0 || materialize.isPending}>
            ← Previous
          </button>
          <div className="row">
            <button onClick={skip} disabled={materialize.isPending}>
              {currentSkipped ? 'Already skipped — next' : 'Skip'}
            </button>
            <button
              className="primary"
              onClick={() => materialize.mutate({ ruleId: current.id, disabled: currentDisable })}
              disabled={materialize.isPending || currentCommitted || !currentText.trim()}
              title={
                !currentText.trim()
                  ? 'Rule text is empty'
                  : currentCommitted
                    ? 'Already saved'
                    : isLastPage
                      ? 'Create AI rule and finish'
                      : 'Create AI rule and move to next filter'
              }
            >
              {materialize.isPending
                ? 'Saving…'
                : isLastPage
                  ? 'Save & finish'
                  : 'Save & next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Ask Claude to rewrite a rule's natural-language text against a new label
 * path, preserving matching/timing/other-actions. Falls back to leaving the
 * text unchanged on any failure rather than risk a broken string-replace.
 */
async function rewriteRuleForLabel(opts: {
  mirrorId: string;
  baseText: string;
  oldLabelName: string | null;
  newLabelPath: string;
  onUpdate: (next: string) => void;
  setRewriting: (on: boolean) => void;
}): Promise<void> {
  if (!opts.baseText.trim()) return;
  opts.setRewriting(true);
  try {
    const res = await apiSend<{ naturalLanguage: string }>(
      'POST',
      '/api/rules/rewrite-with-label',
      {
        naturalLanguage: opts.baseText,
        oldLabelName: opts.oldLabelName,
        newLabelPath: opts.newLabelPath,
      },
    );
    const rewritten = (res.naturalLanguage ?? '').trim();
    if (rewritten) opts.onUpdate(rewritten);
  } catch {
    // Silent failure: the user can still edit the textarea manually. The
    // migration itself already succeeded.
  } finally {
    opts.setRewriting(false);
  }
}

// ── shared describe helpers ───────────────────────────────────────────────

function describeCriteria(c: GmailFilterCriteria): string[] {
  const out: string[] = [];
  if (c.from) out.push(`from: ${c.from}`);
  if (c.to) out.push(`to: ${c.to}`);
  if (c.subject) out.push(`subject: ${c.subject}`);
  if (c.query) out.push(`matches: ${c.query}`);
  if (c.negatedQuery) out.push(`not: ${c.negatedQuery}`);
  if (c.hasAttachment) out.push('has attachment');
  if (c.excludeChats) out.push('excludes chats');
  if (c.size != null) {
    const op = c.sizeComparison === 'larger' ? '>' : '<';
    out.push(`size ${op} ${c.size}`);
  }
  return out;
}

function describeFilterAction(
  a: GmailFilterAction,
  labelMap: Record<string, string>,
): Array<{ label: string; kind: 'accent' | 'danger' | 'warn' }> {
  const out: Array<{ label: string; kind: 'accent' | 'danger' | 'warn' }> = [];
  const sysName: Record<string, string> = {
    INBOX: 'Inbox',
    TRASH: 'Trash',
    SPAM: 'Spam',
    UNREAD: 'Unread',
    STARRED: 'Starred',
    IMPORTANT: 'Important',
  };
  for (const id of a.addLabelIds ?? []) {
    if (id === 'TRASH' || id === 'SPAM') out.push({ label: sysName[id]!, kind: 'danger' });
    else if (id === 'STARRED') out.push({ label: 'Star', kind: 'accent' });
    else if (id === 'IMPORTANT') out.push({ label: 'Mark important', kind: 'accent' });
    else out.push({ label: `+ ${labelMap[id] ?? sysName[id] ?? id}`, kind: 'accent' });
  }
  for (const id of a.removeLabelIds ?? []) {
    if (id === 'INBOX') out.push({ label: 'Archive', kind: 'warn' });
    else if (id === 'UNREAD') out.push({ label: 'Mark read', kind: 'warn' });
    else out.push({ label: `− ${labelMap[id] ?? sysName[id] ?? id}`, kind: 'warn' });
  }
  if (a.forward) out.push({ label: `→ ${a.forward}`, kind: 'accent' });
  return out;
}
