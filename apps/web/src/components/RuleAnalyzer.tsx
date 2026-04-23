import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiSend } from '../lib/api.js';

// ── types ─────────────────────────────────────────────────────────────────

export type AnalyzeAction = {
  type:
    | 'addLabel'
    | 'removeLabel'
    | 'archive'
    | 'markRead'
    | 'star'
    | 'markImportant'
    | 'trash'
    | 'forward';
  labelName?: string | null;
  to?: string | null;
  timing?: string | null;
};

export type AnalyzeResponse = {
  summary: string;
  actions: AnalyzeAction[];
  warnings: string[];
  suggestions?: string[];
  suggestedRewrite?: string | null;
};

// ── panel: single "Check rule" entry point used from multiple places ──────
//
// Exposes a small button + collapsible preview + rewrite suggestion, all
// keyed on the current NL text. Typing resets the cached check so the
// on-screen analysis never disagrees with the text in the textarea.

export function RuleCheckPanel({
  nl,
  onAcceptRewrite,
  placement = 'block',
  hideActions = false,
}: {
  nl: string;
  /** Called when the user clicks "Use this" on a suggested rephrase. */
  onAcceptRewrite: (text: string) => void;
  /**
   * 'block' → Check button sits above the preview on its own row.
   * 'inline' → caller places the button manually via the returned render fns.
   *
   * v1 only uses 'block'; the prop is here so a future host can opt into a
   * tighter layout without forking the component.
   */
  placement?: 'block' | 'inline';
  /**
   * Suppress the "What it will do" summary + action chips. Hosts that
   * already render a canonical action list (like the inbox-cleanup
   * wizard) use this to avoid showing a second, potentially conflicting
   * interpretation. Warnings + suggested rewrite still render.
   */
  hideActions?: boolean;
}): JSX.Element {
  const [checked, setChecked] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const analyze = useQuery<AnalyzeResponse>({
    queryKey: ['rule-analyze', checked],
    queryFn: () =>
      apiSend<AnalyzeResponse>('POST', '/api/rules/analyze', { naturalLanguage: checked! }),
    enabled: checked != null,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Reset preview the moment the text diverges from the snapshot we analysed.
  useEffect(() => {
    if (checked != null && checked !== nl.trim()) setChecked(null);
  }, [nl, checked]);

  const trimmed = nl.trim();
  const canCheck = trimmed.length >= 10;
  const fresh = checked === trimmed;

  const showPreview = fresh && (analyze.data != null || analyze.isFetching || analyze.isError);

  return (
    <div className={`rule-check-panel ${placement === 'inline' ? 'inline' : ''}`}>
      <div className="rule-check-panel-action">
        <button
          onClick={() => setChecked(trimmed)}
          disabled={!canCheck || analyze.isFetching}
          title={
            !canCheck
              ? 'Write a few more words before checking'
              : 'Preview what this rule will do'
          }
        >
          {analyze.isFetching ? 'Checking…' : fresh && analyze.data ? '✓ Checked' : 'Check rule'}
        </button>
      </div>

      {showPreview && (
        <>
          {analyze.data?.suggestedRewrite && analyze.data.suggestedRewrite.trim() !== trimmed && (
            <RewriteSuggestion
              suggested={analyze.data.suggestedRewrite.trim()}
              dismissed={dismissed}
              onAccept={(s) => {
                onAcceptRewrite(s);
                setChecked(null);
              }}
              onDismiss={(s) =>
                setDismissed((prev) => {
                  const next = new Set(prev);
                  next.add(s);
                  return next;
                })
              }
            />
          )}
          {analyze.isFetching && !analyze.data && (
            <div className="rule-preview muted">
              <span className="rule-preview-label">Preview</span>
              Asking Claude what this rule means…
            </div>
          )}
          {analyze.isError && (
            <div className="banner error" style={{ marginTop: '0.4rem' }}>
              Preview failed: {(analyze.error as Error).message}
            </div>
          )}
          {analyze.data && <RulePreview data={analyze.data} hideActions={hideActions} />}
        </>
      )}
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────

function RulePreview({
  data,
  hideActions,
}: {
  data: AnalyzeResponse;
  hideActions?: boolean;
}) {
  return (
    <div className="rule-preview">
      {!hideActions && (
        <div className="rule-preview-row">
          <span className="rule-preview-label">What it will do</span>
          <span className="rule-preview-summary">{data.summary}</span>
        </div>
      )}
      {!hideActions && data.actions.length > 0 && (
        <div className="rule-preview-row">
          <span className="rule-preview-label">Actions</span>
          <div className="row wrap" style={{ gap: '0.3rem' }}>
            {data.actions.map((a, i) => (
              <span key={i} className="chip accent">
                {describeAnalyzeAction(a)}
                {a.timing && a.timing !== 'immediate' && a.timing !== 'null'
                  ? ` · ${a.timing}`
                  : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      {data.warnings.length > 0 && (
        <div className="rule-preview-row">
          <span className="rule-preview-label">Warnings</span>
          <ul className="rule-preview-list">
            {data.warnings.map((w, i) => (
              <li key={i} className="rule-preview-warn">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.suggestions && data.suggestions.length > 0 && (
        <div className="rule-preview-row">
          <span className="rule-preview-label">Suggestions</span>
          <ul className="rule-preview-list">
            {data.suggestions.map((s, i) => (
              <li key={i} className="muted">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RewriteSuggestion({
  suggested,
  dismissed,
  onAccept,
  onDismiss,
}: {
  suggested: string;
  dismissed: Set<string>;
  onAccept: (s: string) => void;
  onDismiss: (s: string) => void;
}) {
  if (dismissed.has(suggested)) return null;
  return (
    <div className="rewrite-suggestion">
      <div className="rewrite-label">✨ Suggested phrasing</div>
      <div className="rewrite-text">{suggested}</div>
      <div className="row" style={{ gap: '0.3rem' }}>
        <button className="primary" onClick={() => onAccept(suggested)}>
          Use this
        </button>
        <button onClick={() => onDismiss(suggested)}>Keep mine</button>
      </div>
    </div>
  );
}

function describeAnalyzeAction(a: AnalyzeAction): string {
  switch (a.type) {
    case 'addLabel':
      return `+ label "${a.labelName ?? '?'}"`;
    case 'removeLabel':
      return `− label "${a.labelName ?? '?'}"`;
    case 'forward':
      return `forward → ${a.to ?? '?'}`;
    case 'archive':
      return 'archive';
    case 'markRead':
      return 'mark read';
    case 'star':
      return 'star';
    case 'markImportant':
      return 'mark important';
    case 'trash':
      return 'trash';
  }
}
