import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  Action,
  CleanupApplyResult,
  CleanupPreview,
  CleanupProposal,
  CleanupSample,
  CleanupSession,
  InboxMessagePreview,
} from '@gam/shared';
import { apiGet, apiSend, ApiError } from '../lib/api.js';
import { RuleCheckPanel } from './RuleAnalyzer.js';
import { EditableActionChip } from './EditableActionChip.js';

/**
 * Wizard that walks the user through their inbox, proposing one AI rule
 * per email, showing sample matches, and letting them apply the rule to
 * the inbox or all mail. Coverage math on the server means each rule
 * the user accepts sweeps up every inbox email it matches, so the
 * wizard usually advances several steps at once.
 *
 * Patterns reused from TranslateWizard (apps/web/src/components/GmailFiltersList.tsx):
 *   - background proposal-prefetch pool (concurrency 2)
 *   - per-page `previews`/`edits`/`failures` records
 *   - debounced re-search on NL edits
 */

const PROPOSE_PARALLEL = 2;
const EDIT_DEBOUNCE_MS = 400;

type FinalSummary = {
  applied: Array<{
    ruleId: string;
    naturalLanguage: string;
    scope: 'inbox-only' | 'all-mail' | 'save-only';
    appliedImmediateCount: number;
    scheduledCount: number;
    coveredInboxMessageIds: string[];
  }>;
  coveredCount: number;
  queueSize: number;
  remaining: number;
};

export function InboxCleanupWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<CleanupSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [covered, setCovered] = useState<Set<string>>(new Set());
  const [idx, setIdx] = useState(0);
  const [emailPreviews, setEmailPreviews] = useState<Record<string, InboxMessagePreview>>({});
  const [proposals, setProposals] = useState<Record<string, CleanupProposal>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [previewUpdating, setPreviewUpdating] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [finishedSummary, setFinishedSummary] = useState<FinalSummary | null>(null);
  const [startBusy, setStartBusy] = useState(true);

  // ── Start session ───────────────────────────────────────────────────
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const res = await apiSend<CleanupSession>('POST', '/api/inbox-cleanup/session/start');
        setSession(res);
        setQueue(res.messageIds);
        setStartBusy(false);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.code === 'needs_reauth'
              ? 'Gmail connection expired — sign in again.'
              : err.code
            : err instanceof Error
              ? err.message
              : String(err);
        setError(msg);
        setStartBusy(false);
      }
    })();
  }, []);

  // ── Background proposal prefetch ────────────────────────────────────
  const prefetchStartedRef = useRef(false);
  useEffect(() => {
    if (!session || prefetchStartedRef.current || queue.length === 0) return;
    prefetchStartedRef.current = true;
    let aborted = false;
    let next = 0;
    const worker = async () => {
      while (!aborted) {
        const i = next++;
        if (i >= queue.length) return;
        const mid = queue[i]!;
        if (proposals[mid] || failures[mid]) continue;
        try {
          const p = await apiSend<CleanupProposal>(
            'POST',
            `/api/inbox-cleanup/session/${session.sessionId}/propose`,
            { messageId: mid },
          );
          if (aborted) return;
          setProposals((prev) => ({ ...prev, [mid]: p }));
        } catch (err) {
          if (aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          setFailures((prev) => ({ ...prev, [mid]: msg }));
        }
      }
    };
    Promise.all(
      Array.from({ length: Math.min(PROPOSE_PARALLEL, queue.length) }, () => worker()),
    ).catch(() => {});
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId, queue.length]);

  // ── Fetch the inbox preview for the current message (lightweight) ──
  useEffect(() => {
    if (!session) return;
    const mid = queue[idx];
    if (!mid || emailPreviews[mid]) return;
    void apiGet<InboxMessagePreview>(
      `/api/inbox-cleanup/session/${session.sessionId}/message/${mid}`,
    )
      .then((p) => setEmailPreviews((prev) => ({ ...prev, [mid]: p })))
      .catch(() => {});
  }, [session, queue, idx, emailPreviews]);

  // ── Debounced preview-refresh when the user edits the NL ───────────
  useEffect(() => {
    if (!session) return;
    const mid = queue[idx];
    if (!mid) return;
    const current = proposals[mid];
    const draft = edits[mid];
    if (!current || draft == null || draft === current.naturalLanguage) return;

    setPreviewUpdating((prev) => ({ ...prev, [mid]: true }));
    const t = setTimeout(() => {
      void apiSend<CleanupPreview>(
        'POST',
        `/api/inbox-cleanup/session/${session.sessionId}/preview-matches`,
        { naturalLanguage: draft, messageId: mid },
      )
        .then((res) => {
          setProposals((prev) => ({
            ...prev,
            [mid]: {
              ...(prev[mid] as CleanupProposal),
              // Keep the user's exact text (don't jump underneath their cursor).
              naturalLanguage: draft,
              gmailQuery: res.gmailQuery,
              // Crucial: actions now reflect the edited NL. Prevents the
              // "NL says archive but action list doesn't include archive"
              // desync that existed with the v1 preview-matches.
              actions: res.actions,
              samples: res.samples,
              totals: res.totals,
            },
          }));
        })
        .catch(() => {})
        .finally(() => setPreviewUpdating((prev) => ({ ...prev, [mid]: false })));
    }, EDIT_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, idx, queue, session?.sessionId]);

  // ── Derived ────────────────────────────────────────────────────────
  const currentId = queue[idx] ?? null;
  const currentProposal = currentId ? proposals[currentId] : undefined;
  const currentPreview = currentId ? emailPreviews[currentId] : undefined;
  const currentEditText = currentId
    ? edits[currentId] ?? currentProposal?.naturalLanguage ?? ''
    : '';
  const currentFailed = currentId ? failures[currentId] : undefined;
  const totalProposed = Object.keys(proposals).length;

  // ── Advance helpers ────────────────────────────────────────────────
  function nextUncoveredIndex(from: number, coveredSet: Set<string>): number | null {
    for (let i = from; i < queue.length; i++) {
      if (!coveredSet.has(queue[i]!)) return i;
    }
    return null;
  }

  function advancePastCovered(coveredSet: Set<string>) {
    const nxt = nextUncoveredIndex(idx + 1, coveredSet);
    if (nxt == null) {
      // End — fetch summary.
      void finalize(coveredSet);
    } else {
      setIdx(nxt);
    }
  }

  async function finalize(coveredSet: Set<string>) {
    if (!session) return;
    try {
      const sum = await apiGet<FinalSummary>(
        `/api/inbox-cleanup/session/${session.sessionId}/summary`,
      );
      setFinishedSummary(sum);
    } catch {
      setFinishedSummary({
        applied: [],
        coveredCount: coveredSet.size,
        queueSize: queue.length,
        remaining: 0,
      });
    }
    // Invalidate rule list so the AI rules tab shows new rules.
    qc.invalidateQueries({ queryKey: ['rules'] });
  }

  // ── Actions ────────────────────────────────────────────────────────
  async function applyCurrent(scope: 'inbox-only' | 'all-mail' | 'save-only') {
    if (!session || !currentId || !currentProposal) return;
    setApplying(true);
    try {
      const res = await apiSend<CleanupApplyResult>(
        'POST',
        `/api/inbox-cleanup/session/${session.sessionId}/apply`,
        {
          naturalLanguage: edits[currentId] ?? currentProposal.naturalLanguage,
          actions: currentProposal.actions,
          gmailQuery: currentProposal.gmailQuery,
          scope,
        },
      );
      // Merge coverage.
      setCovered((prev) => {
        const next = new Set(prev);
        for (const id of res.coveredInboxMessageIds) next.add(id);
        // Always cover the source email so we don't get stuck on it.
        next.add(currentId);
        return next;
      });
      const newCovered = new Set(covered);
      for (const id of res.coveredInboxMessageIds) newCovered.add(id);
      newCovered.add(currentId);
      advancePastCovered(newCovered);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFailures((prev) => ({ ...prev, [currentId]: msg }));
    } finally {
      setApplying(false);
    }
  }

  async function skipCurrent() {
    if (!session || !currentId) return;
    await apiSend('POST', `/api/inbox-cleanup/session/${session.sessionId}/skip`, {
      messageId: currentId,
    }).catch(() => {});
    const newCovered = new Set(covered);
    newCovered.add(currentId);
    setCovered(newCovered);
    advancePastCovered(newCovered);
  }

  function goPrev() {
    // Find the previous index that's not covered; if none, stay.
    for (let i = idx - 1; i >= 0; i--) {
      if (!covered.has(queue[i]!)) {
        setIdx(i);
        return;
      }
    }
  }

  // ── Loading / error / done screens ─────────────────────────────────
  if (startBusy) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
          <h3 style={{ marginTop: 0 }}>Cleaning up your inbox…</h3>
          <div className="translate-pending">
            <span className="spinner" />
            <span>Syncing Gmail and preparing the queue…</span>
          </div>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
          <h3 style={{ marginTop: 0 }}>Couldn't start</h3>
          <div className="banner error">{error}</div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }
  if (finishedSummary) {
    return <DoneScreen summary={finishedSummary} onClose={onClose} />;
  }
  if (!session || queue.length === 0) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
          <h3 style={{ marginTop: 0 }}>Nothing to clean up</h3>
          <div className="muted">Your inbox is empty or fully cached under existing rules.</div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main wizard page ───────────────────────────────────────────────
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.3rem' }}>
          <h3 style={{ margin: 0 }}>Clean up inbox</h3>
          <button onClick={onClose} disabled={applying}>×</button>
        </div>

        <div className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
          {idx + 1} / {queue.length}
          {' · '}
          covered {covered.size}
          {totalProposed < queue.length && ` · proposing… ${queue.length - totalProposed} left`}
        </div>

        <div className="translate-progress-bar" style={{ marginBottom: '0.75rem' }}>
          <div
            className="translate-progress-fill"
            style={{ width: `${Math.round((covered.size / queue.length) * 100)}%` }}
          />
        </div>

        {/* Source email card */}
        <div className="panel" style={{ fontSize: '0.85rem', marginBottom: '0.6rem' }}>
          <div
            className="muted"
            style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            Inbox email
          </div>
          {currentPreview ? (
            <div style={{ marginTop: '0.25rem' }}>
              <div>
                <strong>{currentPreview.from ?? '(unknown sender)'}</strong>
              </div>
              <div>{currentPreview.subject ?? '(no subject)'}</div>
              <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
                {currentPreview.snippet ?? ''}
              </div>
            </div>
          ) : (
            <div className="muted">Loading email…</div>
          )}
        </div>

        {/* Proposal area */}
        {!currentProposal && !currentFailed && (
          <div className="translate-pending" style={{ marginBottom: '0.6rem' }}>
            <span className="spinner" />
            <span>Proposing a rule for this email (propose → search → evaluate → refine)…</span>
          </div>
        )}
        {currentFailed && (
          <div className="banner error" style={{ marginBottom: '0.6rem' }}>
            Couldn't propose a rule: {currentFailed}. You can Skip this email or try again on the
            next wizard open.
          </div>
        )}
        {currentProposal && session && currentId && (
          <ProposalBody
            proposal={currentProposal}
            editText={currentEditText}
            onEditChange={(v) => setEdits((prev) => ({ ...prev, [currentId]: v }))}
            updating={Boolean(previewUpdating[currentId])}
            onActionsChange={(newActions) => {
              setProposals((prev) => ({
                ...prev,
                [currentId]: {
                  ...(prev[currentId] as CleanupProposal),
                  actions: newActions,
                },
              }));
            }}
            onLabelRename={(oldLabel, newLabel) => {
              // A chip edit changed the label path. Update the NL text to
              // use the new path too — the server's reproposer will
              // re-derive the full action list from the edited NL on the
              // next debounced preview-matches tick. Plain substring
              // replace is adequate for a name like "Marketing/LEGO" →
              // "Notifications/LEGO"; the prompt tolerates minor tidying.
              const current = edits[currentId] ?? currentProposal.naturalLanguage;
              if (!current.includes(oldLabel)) return;
              setEdits((prev) => ({
                ...prev,
                [currentId]: current.split(oldLabel).join(newLabel),
              }));
            }}
          />
        )}

        {/* Footer */}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: '0.8rem' }}>
          <button onClick={goPrev} disabled={applying || idx === 0}>
            ← Previous
          </button>
          <div className="row">
            <button onClick={skipCurrent} disabled={applying}>
              Skip
            </button>
            <button
              onClick={() => applyCurrent('save-only')}
              disabled={applying || !currentProposal || !currentEditText.trim()}
              title="Save the rule for future mail; leave the existing emails alone"
            >
              Save rule only
            </button>
            <button
              className="primary"
              onClick={() => applyCurrent('inbox-only')}
              disabled={applying || !currentProposal || !currentEditText.trim()}
              title="Save rule and clean up emails currently in the inbox"
            >
              {applying
                ? 'Applying…'
                : `Save & clean inbox${
                    currentProposal ? ` (${currentProposal.totals.inbox})` : ''
                  }`}
            </button>
            <button
              onClick={() => applyCurrent('all-mail')}
              disabled={applying || !currentProposal || !currentEditText.trim()}
              title="Save rule and apply to every matching email (including already-archived)"
            >
              {applying
                ? ''
                : `Save & apply to all${
                    currentProposal ? ` (${currentProposal.totals.allMail})` : ''
                  }`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProposalBody({
  proposal,
  editText,
  onEditChange,
  updating,
  onActionsChange,
  onLabelRename,
}: {
  proposal: CleanupProposal;
  editText: string;
  onEditChange: (v: string) => void;
  updating: boolean;
  /** Called when the user edits an action chip. Parent updates the
   *  actions array immediately; the debounced reproposer will also fire
   *  on the follow-on NL edit and produce a consistent list. */
  onActionsChange: (next: Action[]) => void;
  /** Called when a label chip changed its labelName. Parent rewrites
   *  the NL to use the new path so the action list and the NL stay
   *  aligned (and so the schema-level refineLabelsAreNamedInNL on the
   *  next repropose doesn't reject the draft). */
  onLabelRename: (oldLabel: string, newLabel: string) => void;
}) {
  // Layout mirrors RuleEditor (apps/web/src/pages/Home.tsx): label →
  // textarea → description → preview → check-rule. The differences from
  // a blank RuleEditor are (1) the textarea is seeded from the
  // server-side propose loop, (2) actions render live and editable
  // (from the propose/repropose response) rather than waiting for a
  // Check-rule click, and (3) the Matches block is specific to cleanup.
  return (
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
        value={editText}
        onChange={(e) => onEditChange(e.target.value)}
        rows={3}
        spellCheck={false}
        style={{ marginBottom: '0.35rem' }}
      />
      <div className="muted" style={{ fontSize: '0.75rem', marginBottom: '0.6rem' }}>
        Drafted from this email. Edit freely — actions and matches update as you type.
        {proposal.refineHistory.length > 0 && (
          <span
            title={proposal.refineHistory.map((h) => `${h.attempt}: ${h.note}`).join('\n')}
            style={{ marginLeft: '0.4rem' }}
          >
            · auto-refined {proposal.refineHistory.length}×
          </span>
        )}
      </div>

      {/* Live "what it will do" — same .rule-preview styling as RuleEditor's
          analyze output, but driven by the propose/repropose response so the
          chips match the rule that will actually run. Each chip is an
          inline editor: click the label chip to change the canonical
          category, click the archive chip to change timing. */}
      <div className="rule-preview" style={{ marginBottom: '0.5rem' }}>
        <div className="rule-preview-row">
          <span className="rule-preview-label">Actions</span>
          <div className="row wrap" style={{ gap: '0.3rem', alignItems: 'center' }}>
            {proposal.actions.map((a, i) => (
              <EditableActionChip
                key={`${i}-${chipKey(a)}`}
                action={a}
                onChange={(next) => {
                  const copy = proposal.actions.slice();
                  copy[i] = next;
                  onActionsChange(copy);
                }}
                onLabelRename={onLabelRename}
              />
            ))}
            {updating && (
              <span className="muted" style={{ fontSize: '0.78rem' }}>
                · updating…
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Warnings + Suggested phrasing come from /api/rules/analyze; its
          action chips are suppressed (hideActions) so we don't show two
          disagreeing action lists on the same page. */}
      <RuleCheckPanel nl={editText} onAcceptRewrite={(s) => onEditChange(s)} hideActions />

      <div
        className="muted"
        style={{ fontSize: '0.82rem', marginTop: '0.8rem', marginBottom: '0.3rem' }}
      >
        Matches — in inbox: <strong>{proposal.totals.inbox}</strong> · all mail:{' '}
        <strong>{proposal.totals.allMail}</strong>
        {updating && (
          <>
            {' · '}
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} />
            <span style={{ marginLeft: '0.35rem' }}>updating…</span>
          </>
        )}
      </div>

      <SampleList samples={proposal.samples} />
    </>
  );
}

function SampleList({ samples }: { samples: CleanupSample[] }) {
  if (samples.length === 0) {
    return (
      <div className="muted" style={{ fontSize: '0.78rem' }}>
        No samples available.
      </div>
    );
  }
  return (
    <ul
      style={{
        fontSize: '0.8rem',
        margin: 0,
        paddingLeft: '1rem',
        maxHeight: '160px',
        overflowY: 'auto',
      }}
    >
      {samples.map((s) => (
        <li key={s.messageId} style={{ lineHeight: 1.35 }}>
          <span style={{ marginRight: '0.35rem' }}>{s.inInbox ? '●' : '○'}</span>
          <strong>{s.from ?? '(unknown sender)'}</strong>
          {s.subject && <> — {s.subject}</>}
          {s.snippet && (
            <div className="muted" style={{ fontSize: '0.75rem', paddingLeft: '1.1rem' }}>
              {s.snippet.slice(0, 140)}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function DoneScreen({
  summary,
  onClose,
}: {
  summary: FinalSummary;
  onClose: () => void;
}) {
  const totalMoved = summary.applied.reduce((a, r) => a + r.appliedImmediateCount, 0);
  const totalScheduled = summary.applied.reduce((a, r) => a + r.scheduledCount, 0);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>All done</h3>
        <div className="panel" style={{ fontSize: '0.9rem' }}>
          <div>
            <strong>{summary.applied.length}</strong> rule{summary.applied.length === 1 ? '' : 's'}{' '}
            created.
          </div>
          <div>
            <strong>{totalMoved}</strong> email{totalMoved === 1 ? '' : 's'} acted on immediately.
          </div>
          {totalScheduled > 0 && (
            <div>
              <strong>{totalScheduled}</strong> scheduled for later (snoozes / deferred archives).
            </div>
          )}
          {summary.remaining > 0 && (
            <div className="muted" style={{ marginTop: '0.3rem' }}>
              {summary.remaining} inbox email{summary.remaining === 1 ? '' : 's'} left to review —
              reopen the wizard to continue.
            </div>
          )}
        </div>
        {summary.applied.length > 0 && (
          <div style={{ marginTop: '0.6rem' }}>
            <div
              className="muted"
              style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}
            >
              Rules created
            </div>
            <ul style={{ marginTop: '0.3rem', paddingLeft: '1rem' }}>
              {summary.applied.map((r) => (
                <li key={r.ruleId} style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
                  {r.naturalLanguage}
                  <span className="muted" style={{ fontSize: '0.75rem' }}>
                    {' — '}
                    {r.scope}
                    {r.appliedImmediateCount > 0 && ` · ${r.appliedImmediateCount} applied`}
                    {r.scheduledCount > 0 && ` · ${r.scheduledCount} scheduled`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Stable-ish React key for an action so remounts don't nuke the chip's
 *  internal "editing" state every time the parent re-renders. Includes
 *  the labelName / to field because those are what the user's editing
 *  in-place; timing changes keep the same key so the chip doesn't
 *  flicker when the user picks an option. */
function chipKey(a: Action): string {
  if (a.type === 'addLabel' || a.type === 'removeLabel') return `${a.type}:${a.labelName}`;
  if (a.type === 'forward') return `forward:${a.to}`;
  return a.type;
}
