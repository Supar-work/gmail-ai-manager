import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  Action,
  CleanupApplyResult,
  CleanupCovered,
  CleanupOutcome,
  CleanupPreview,
  CleanupProposal,
  CleanupSample,
  CleanupSession,
  InboxMessagePreview,
  RuleToken,
} from '@gam/shared';
import { apiGet, apiSend, ApiError } from '../lib/api.js';
import {
  InlineChipEditor,
  tokensToNaturalLanguage,
  mergeAdjacentText,
} from './InlineChipEditor.js';

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
  const [proposals, setProposals] = useState<Record<string, CleanupOutcome>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Per-message draft token list — what the InlineChipEditor is
  // showing. Diverges from the proposal's tokens when the user edits;
  // re-syncs after the parent calls /preview-matches via the explicit
  // "Evaluate" button.
  const [draftTokens, setDraftTokens] = useState<Record<string, RuleToken[]>>({});
  // Bumped whenever a Claude round-trip writes new tokens for a
  // message. Used as the editor's `version` prop to remount its
  // contenteditable spans with fresh DOM contents.
  const [tokensVersion, setTokensVersion] = useState<Record<string, number>>({});
  // Has the user clicked Evaluate on this message yet? Until they do,
  // we hide IMPACTS / SAMPLES so the wizard pushes them to confirm
  // the rule explicitly rather than reading numbers off an unprompted
  // panel.
  const [evaluated, setEvaluated] = useState<Record<string, boolean>>({});
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
        // Skip messages that got covered mid-session — when the user
        // applied a rule earlier in this same session, sweeping
        // matched messages into `covered`, we don't want to spend a
        // Claude call on a proposal we'll never show.
        if (covered.has(mid)) continue;
        try {
          const p = await apiSend<CleanupOutcome>(
            'POST',
            `/api/inbox-cleanup/session/${session.sessionId}/propose`,
            { messageId: mid },
          );
          if (aborted) return;
          setProposals((prev) => ({ ...prev, [mid]: p }));
          // If the AI determined this email is already handled by an
          // existing enabled rule, mark it covered so the wizard
          // skips past it once the user advances.
          if (p.outcome === 'covered') {
            setCovered((prev) => {
              if (prev.has(mid)) return prev;
              const next = new Set(prev);
              next.add(mid);
              return next;
            });
          }
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

  // ── Hydrate draft tokens whenever a fresh proposal lands ──────────
  // The InlineChipEditor reads from draftTokens[mid]. When propose or
  // evaluate returns a new ruleTokens array we copy it into
  // draftTokens and bump the version so the editor remounts its
  // contenteditable spans with fresh content.
  useEffect(() => {
    for (const mid of Object.keys(proposals)) {
      const p = proposals[mid];
      if (!p || p.outcome !== 'propose') continue;
      if (draftTokens[mid] == null && p.ruleTokens && p.ruleTokens.length > 0) {
        setDraftTokens((prev) => ({ ...prev, [mid]: p.ruleTokens! }));
        setTokensVersion((prev) => ({ ...prev, [mid]: (prev[mid] ?? 0) + 1 }));
      }
    }
  }, [proposals]); // eslint-disable-line react-hooks/exhaustive-deps

  // Explicit Evaluate — the user clicks a button when they're ready
  // for Claude to re-derive chips, actions, samples, and impact from
  // the current token sequence.
  //
  // Fast path: if the user clicks Evaluate without having edited any
  // chips since the proposer's first response, we already HAVE the
  // matching impact/samples in the proposal — just flip `evaluated`
  // to reveal them. No Claude round-trip on a fresh email.
  async function evaluateCurrent(mid: string) {
    if (!session) return;
    const tokens = draftTokens[mid] ?? [];
    const nl = tokensToNaturalLanguage(tokens);
    if (!nl) return;
    const outcome = proposals[mid];
    if (outcome && outcome.outcome === 'covered') {
      // Covered messages don't have a propose form to evaluate. Just
      // mark evaluated and let the wizard advance.
      setEvaluated((prev) => ({ ...prev, [mid]: true }));
      return;
    }
    const proposal = outcome && outcome.outcome === 'propose' ? outcome : undefined;
    const proposalTokensNL = proposal?.ruleTokens
      ? tokensToNaturalLanguage(proposal.ruleTokens)
      : null;
    // Reveal cached impact when nothing changed.
    if (proposal && proposalTokensNL != null && proposalTokensNL.trim() === nl.trim()) {
      setEvaluated((prev) => ({ ...prev, [mid]: true }));
      return;
    }

    setEdits((prev) => ({ ...prev, [mid]: nl }));
    setPreviewUpdating((prev) => ({ ...prev, [mid]: true }));
    try {
      const res = await apiSend<CleanupPreview>(
        'POST',
        `/api/inbox-cleanup/session/${session.sessionId}/preview-matches`,
        { naturalLanguage: nl, messageId: mid },
      );
      setProposals((prev) => {
        const cur = prev[mid];
        // Only patch a propose-shape proposal — covered ones don't
        // expose the propose fields and shouldn't be reachable here.
        if (!cur || cur.outcome !== 'propose') return prev;
        return {
          ...prev,
          [mid]: {
            ...cur,
            naturalLanguage: res.naturalLanguage,
            gmailQuery: res.gmailQuery,
            actions: res.actions,
            samples: res.samples,
            totals: res.totals,
            ruleTokens: res.ruleTokens ?? cur.ruleTokens,
          },
        };
      });
      if (res.ruleTokens && res.ruleTokens.length > 0) {
        setDraftTokens((prev) => ({ ...prev, [mid]: res.ruleTokens! }));
        setTokensVersion((prev) => ({ ...prev, [mid]: (prev[mid] ?? 0) + 1 }));
      }
      setEvaluated((prev) => ({ ...prev, [mid]: true }));
    } catch {
      /* errors surface via the failures map elsewhere */
    } finally {
      setPreviewUpdating((prev) => ({ ...prev, [mid]: false }));
    }
  }

  // ── Derived ────────────────────────────────────────────────────────
  const currentId = queue[idx] ?? null;
  const currentOutcome = currentId ? proposals[currentId] : undefined;
  // Two narrowed views — pick whichever the renderer needs.
  const currentProposal: CleanupProposal | undefined =
    currentOutcome?.outcome === 'propose' ? currentOutcome : undefined;
  const currentCovered: CleanupCovered | undefined =
    currentOutcome?.outcome === 'covered' ? currentOutcome : undefined;
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
        {!currentOutcome && !currentFailed && (
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
        {currentCovered && (
          <CoveredCard
            covered={currentCovered}
            onSkip={() => skipCurrent()}
          />
        )}
        {currentProposal && session && currentId && (
          <ProposalBody
            proposal={currentProposal}
            tokens={draftTokens[currentId] ?? currentProposal.ruleTokens ?? []}
            tokensVersion={tokensVersion[currentId] ?? 0}
            updating={Boolean(previewUpdating[currentId])}
            evaluated={Boolean(evaluated[currentId])}
            dirty={Boolean(
              draftTokens[currentId] &&
                tokensToNaturalLanguage(draftTokens[currentId]!) !==
                  currentProposal.naturalLanguage,
            )}
            onTokensChange={(next) => {
              setDraftTokens((prev) => ({ ...prev, [currentId]: mergeAdjacentText(next) }));
              // Edits invalidate the previous evaluation — hide
              // impact until the user re-evaluates.
              setEvaluated((prev) =>
                prev[currentId] ? { ...prev, [currentId]: false } : prev,
              );
            }}
            onEvaluate={() => evaluateCurrent(currentId)}
          />
        )}

        {/* Footer */}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: '0.8rem' }}>
          <button onClick={goPrev} disabled={applying || idx === 0}>
            ← Previous
          </button>
          <div className="row">
            <button
              onClick={skipCurrent}
              disabled={applying}
              className={currentCovered ? 'primary' : ''}
            >
              {currentCovered ? 'Next email →' : 'Skip'}
            </button>
            {!currentCovered && (
              <>
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
                  disabled={
                    applying ||
                    !currentProposal ||
                    !currentEditText.trim() ||
                    !evaluated[currentId ?? '']
                  }
                  title={
                    !evaluated[currentId ?? '']
                      ? 'Click Evaluate first to see the impact before applying'
                      : 'Save rule and clean up emails currently in the inbox'
                  }
                >
                  {applying
                    ? 'Applying…'
                    : `Apply to inbox${
                        currentProposal && evaluated[currentId ?? '']
                          ? ` (${currentProposal.totals.inbox})`
                          : ''
                      }`}
                </button>
                <button
                  onClick={() => applyCurrent('all-mail')}
                  disabled={
                    applying ||
                    !currentProposal ||
                    !currentEditText.trim() ||
                    !evaluated[currentId ?? '']
                  }
                  title={
                    !evaluated[currentId ?? '']
                      ? 'Click Evaluate first to see the impact before applying'
                      : 'Save rule and apply to every matching email (including already-archived)'
                  }
                >
                  {applying
                    ? ''
                    : `Apply to all emails${
                        currentProposal && evaluated[currentId ?? '']
                          ? ` (${currentProposal.totals.allMail})`
                          : ''
                      }`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders when the AI determined this email is already handled by an
 * existing enabled rule. Skips the rule-editor + impact panel
 * entirely; the user can hit "Next email →" (the relabeled Skip
 * button in the wizard footer) to advance.
 */
function CoveredCard({
  covered,
  onSkip,
}: {
  covered: CleanupCovered;
  onSkip: () => void;
}) {
  return (
    <div
      className="rule-preview"
      style={{
        marginBottom: '0.5rem',
        borderColor: 'var(--accent)',
      }}
    >
      <div className="rule-preview-row">
        <span className="rule-preview-label">Already handled</span>
        <span style={{ fontSize: '0.9rem' }}>
          ✓ This email matches an existing rule — no new rule needed.
        </span>
      </div>
      <div className="rule-preview-row">
        <span className="rule-preview-label">Existing rule</span>
        <span style={{ fontSize: '0.85rem', fontStyle: 'italic' }}>
          "{covered.ruleNL}"
        </span>
      </div>
      <div className="rule-preview-row">
        <span className="rule-preview-label">Why it matches</span>
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          {covered.reasoning}
        </span>
      </div>
      <div className="row" style={{ marginTop: '0.4rem' }}>
        <button className="primary" onClick={onSkip}>
          Next email →
        </button>
      </div>
    </div>
  );
}

function ProposalBody({
  proposal,
  tokens,
  tokensVersion,
  updating,
  evaluated,
  dirty,
  onTokensChange,
  onEvaluate,
}: {
  proposal: CleanupProposal;
  tokens: RuleToken[];
  tokensVersion: number;
  updating: boolean;
  /** True after the user has clicked Evaluate at least once for this
   *  email AND no edits have happened since. Drives whether the
   *  IMPACTS / SAMPLE EMAILS panels render. */
  evaluated: boolean;
  /** True when the user has edited tokens since the last evaluate. */
  dirty: boolean;
  onTokensChange: (next: RuleToken[]) => void;
  onEvaluate: () => void;
}) {
  return (
    <>
      <label
        className="muted"
        style={{
          fontSize: '0.7rem',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          display: 'block',
          marginBottom: '0.35rem',
        }}
      >
        Suggested AI rule
      </label>

      <InlineChipEditor
        tokens={tokens}
        version={tokensVersion}
        evaluating={updating}
        onTokensChange={onTokensChange}
      />

      <div
        className="row"
        style={{
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '0.5rem',
          marginBottom: '0.6rem',
          gap: '0.5rem',
        }}
      >
        <div className="muted" style={{ fontSize: '0.75rem', flex: 1 }}>
          Type freely between chips, click a chip to edit it. Click{' '}
          <strong>Evaluate</strong> to ask AI to refresh the chips and the
          impact below.
          {proposal.refineHistory.length > 0 && (
            <span
              title={proposal.refineHistory.map((h) => `${h.attempt}: ${h.note}`).join('\n')}
              style={{ marginLeft: '0.4rem' }}
            >
              · auto-refined {proposal.refineHistory.length}×
            </span>
          )}
        </div>
        <button
          type="button"
          className={!evaluated || dirty ? 'primary' : ''}
          onClick={onEvaluate}
          disabled={updating}
          title={
            !evaluated
              ? 'Reveal what this rule will do and which emails it hits'
              : dirty
                ? 'Re-run AI to refresh chips, actions, and impact'
                : 'Up to date'
          }
        >
          {updating ? 'Evaluating…' : evaluated && !dirty ? '✓ Evaluated' : 'Evaluate'}
        </button>
      </div>

      {evaluated ? (
        <div className="rule-preview" style={{ marginBottom: '0.5rem' }}>
          <div className="rule-preview-row">
            <span className="rule-preview-label">Impacts</span>
            <span style={{ fontSize: '0.85rem' }}>
              <strong>{proposal.totals.inbox}</strong> in inbox ·{' '}
              <strong>{proposal.totals.allMail}</strong> across all mail
              {updating && (
                <>
                  {' · '}
                  <span
                    className="spinner"
                    style={{ display: 'inline-block', verticalAlign: 'middle' }}
                  />
                  <span style={{ marginLeft: '0.35rem' }}>updating…</span>
                </>
              )}
            </span>
          </div>

          <div className="rule-preview-row">
            <span className="rule-preview-label">Sample emails</span>
            <GroupedSampleList samples={proposal.samples} />
          </div>
        </div>
      ) : (
        <div
          className="empty"
          style={{
            padding: '0.85rem 1rem',
            fontSize: '0.85rem',
            marginBottom: '0.5rem',
          }}
        >
          {dirty
            ? 'Rule edited — click Evaluate to refresh the impact.'
            : 'Click Evaluate to see what this rule will do and which emails it will hit.'}
        </div>
      )}

      {/* Note: the legacy RuleCheckPanel (warnings + rephrase suggestions
          from /api/rules/analyze) was useful when the rule lived in a
          free-form textarea. With the chip composer driving the rule's
          structure, ambiguity-class warnings don't apply — what you see
          in the chips is what runs. The panel was removed; if a future
          warning class shows up that's chip-relevant we can reintroduce
          a leaner indicator inline. */}
    </>
  );
}

/** Two short bulleted lists: one for emails currently in the inbox,
 *  one for matches outside it (already archived, sent, etc.). Helps
 *  the user understand "Apply to inbox" vs "Apply to all emails". */
function GroupedSampleList({ samples }: { samples: CleanupSample[] }) {
  if (samples.length === 0) {
    return (
      <div className="muted" style={{ fontSize: '0.78rem' }}>
        No samples available.
      </div>
    );
  }
  const inInbox = samples.filter((s) => s.inInbox);
  const outside = samples.filter((s) => !s.inInbox);
  return (
    <div style={{ width: '100%' }}>
      {inInbox.length > 0 && (
        <div style={{ marginBottom: outside.length > 0 ? '0.5rem' : 0 }}>
          <div
            className="muted"
            style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '0.2rem',
            }}
          >
            In inbox ({inInbox.length})
          </div>
          <SampleRows rows={inInbox} />
        </div>
      )}
      {outside.length > 0 && (
        <div>
          <div
            className="muted"
            style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '0.2rem',
            }}
          >
            Other matches ({outside.length})
          </div>
          <SampleRows rows={outside} />
        </div>
      )}
    </div>
  );
}

function SampleRows({ rows }: { rows: CleanupSample[] }) {
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
      {rows.map((s) => (
        <li key={s.messageId} style={{ lineHeight: 1.35 }}>
          <strong>{s.from ?? '(unknown sender)'}</strong>
          {s.subject && <> — {s.subject}</>}
          {s.snippet && (
            <div className="muted" style={{ fontSize: '0.75rem', paddingLeft: '0.4rem' }}>
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
