import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RuleDTO } from '@gam/shared';
import { apiGet, apiSend, ApiError } from '../lib/api.js';
import { RunLogPanel, useActiveRun } from '../components/RunLogPanel.js';
import {
  GmailFiltersList,
  useAutoSyncOnMount,
  useGmailFiltersQuery,
} from '../components/GmailFiltersList.js';
import { RuleCheckPanel } from '../components/RuleAnalyzer.js';
import { InboxCleanupWizard } from '../components/InboxCleanupWizard.js';
import { Chat } from './Chat.js';

// ── types ─────────────────────────────────────────────────────────────────

// Wire shape from /api/rules. Imported from @gam/shared so the API and
// web stay in lockstep — local declarations of the same shape were
// drifting (missing fields, divergent timestamp types).
type Rule = RuleDTO;
type RulesResponse = { rules: Rule[] };

type StartRunResponse = { runId: string };

// ── page ──────────────────────────────────────────────────────────────────

type Tab = 'ai-rules' | 'gmail-filters' | 'decisions' | 'chat';

export function Home() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [tab, setTab] = useState<Tab>('ai-rules');
  const activeRun = useActiveRun();

  const rules = useQuery<RulesResponse>({
    queryKey: ['rules'],
    queryFn: () => apiGet('/api/rules'),
    retry: false,
  });

  const classifyAll = useMutation<StartRunResponse>({
    // No maxMessages: classifyRecent defaults to "all cached inbox messages"
    // for full runs. The result cache keeps this cheap after the first pass.
    mutationFn: () => apiSend('POST', '/api/classify/run', {}),
    onSuccess: (data) => activeRun.start(data.runId, 'All rules'),
  });

  const classifyRule = useMutation<StartRunResponse, Error, { id: string; label: string }>({
    // No cap — iterate over the whole cached inbox. Per-rule runs bypass the
    // result cache so every message is re-tested against this one rule.
    mutationFn: ({ id }) => apiSend('POST', '/api/classify/run', { ruleIds: [id] }),
    onSuccess: (data, vars) => activeRun.start(data.runId, vars.label),
  });

  const toggle = useMutation<unknown, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) => apiSend('PUT', `/api/rules/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const remove = useMutation<unknown, Error, string>({
    mutationFn: (id) => apiSend('DELETE', `/api/rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const move = useMutation<unknown, Error, string[]>({
    mutationFn: (orderedIds) => apiSend('POST', '/api/rules/reorder', { orderedIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const gmailFilters = useGmailFiltersQuery();
  useAutoSyncOnMount();

  if (rules.isLoading) return <div className="empty">Loading…</div>;
  if (rules.isError && rules.error instanceof ApiError && rules.error.status === 401) return null;

  const ruleList = rules.data?.rules ?? [];
  const gmailFilterCount = gmailFilters.data?.filters.length ?? 0;

  function moveRule(idx: number, dir: -1 | 1) {
    const next = [...ruleList];
    const tgt = idx + dir;
    if (tgt < 0 || tgt >= next.length) return;
    const a = next[idx]!;
    const b = next[tgt]!;
    next[idx] = b;
    next[tgt] = a;
    move.mutate(next.map((r) => r.id));
  }

  return (
    <div className={`home ${activeRun.open ? 'home--log-open' : ''}`}>
      <section className="hero-actions hero-actions--two">
        <button className="hero-btn" onClick={() => setCleaningUp(true)}>
          <div className="hero-btn-title">Clean up my inbox</div>
          <div className="hero-btn-sub">AI proposes a rule per email, you approve</div>
        </button>
        <a className="hero-btn" href="https://mail.google.com" target="_blank" rel="noreferrer">
          <div className="hero-btn-title">Open Gmail</div>
          <div className="hero-btn-sub">In a new tab</div>
        </a>
      </section>

      <div className="tabs">
        <button
          className={`tab ${tab === 'ai-rules' ? 'on' : ''}`}
          onClick={() => setTab('ai-rules')}
        >
          AI rules <span className="tab-count">{ruleList.length}</span>
        </button>
        <button
          className={`tab ${tab === 'gmail-filters' ? 'on' : ''}`}
          onClick={() => setTab('gmail-filters')}
        >
          Gmail filters <span className="tab-count">{gmailFilterCount}</span>
        </button>
        <button
          className={`tab ${tab === 'decisions' ? 'on' : ''}`}
          onClick={() => setTab('decisions')}
        >
          Decisions
        </button>
        <button
          className={`tab ${tab === 'chat' ? 'on' : ''}`}
          onClick={() => setTab('chat')}
        >
          Chat
        </button>
      </div>

      {tab === 'ai-rules' && (
        <section className="rules-section">
          <div className="rules-section-head">
            <div className="muted" style={{ fontSize: '0.82rem' }}>
              Natural-language rules evaluated locally by Claude on each email.
            </div>
            <div className="row">
              <button
                onClick={() => classifyAll.mutate()}
                disabled={classifyAll.isPending || activeRun.open}
              >
                {classifyAll.isPending ? 'Starting…' : 'Run all rules now'}
              </button>
              <button className="primary" onClick={() => setCreating(true)}>
                + Add rule
              </button>
            </div>
          </div>

          {ruleList.length === 0 ? (
            <div className="empty">
              No AI rules yet. Click <strong>+ Add rule</strong> to write one in plain English.
            </div>
          ) : (
            <div className="rule-list">
              {ruleList.map((r, i) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  index={i}
                  total={ruleList.length}
                  running={
                    classifyRule.isPending &&
                    classifyRule.variables != null &&
                    classifyRule.variables.id === r.id
                  }
                  disableRun={activeRun.open}
                  onToggle={(enabled) => toggle.mutate({ id: r.id, enabled })}
                  onEdit={() => setEditing(r)}
                  onDelete={() => {
                    if (confirm('Delete this rule?')) remove.mutate(r.id);
                  }}
                  onMove={(dir) => moveRule(i, dir)}
                  onRun={() =>
                    classifyRule.mutate({ id: r.id, label: r.naturalLanguage.slice(0, 60) })
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'gmail-filters' && <GmailFiltersList />}
      {tab === 'decisions' && (
        <DecisionsList
          onEditRule={(ruleId) => {
            const r = ruleList.find((x) => x.id === ruleId);
            if (r) setEditing(r);
          }}
        />
      )}
      {tab === 'chat' && <Chat />}

      {creating && <RuleEditor mode="create" onClose={() => setCreating(false)} />}
      {editing && <RuleEditor mode="edit" rule={editing} onClose={() => setEditing(null)} />}
      {cleaningUp && <InboxCleanupWizard onClose={() => setCleaningUp(false)} />}

      {activeRun.open && activeRun.runId && (
        <RunLogPanel
          runId={activeRun.runId}
          label={activeRun.label ?? 'Run'}
          onClose={activeRun.dismiss}
        />
      )}
    </div>
  );
}

// ── decisions list ──────────────────────────────────────────────────────

type DecisionRow = {
  id: string;
  gmailMessageId: string;
  from: string | null;
  subject: string | null;
  snippet: string | null;
  /** Bare List-ID (e.g. "zelig.zelig.me") when the email arrived via
   *  a mailing list / Google Group; null otherwise. */
  listId: string | null;
  /** Real sender behind a list rewrite, when distinct from `from`. */
  originalFrom: string | null;
  matchedRules: Array<{ id: string; naturalLanguage: string }>;
  reasoning: Array<{ ruleId: string; reasoning: string }>;
  /** Rule + concrete action that actually fired. Persisted by
   *  apps/api/src/classify/run.ts as `{ ruleId, action, at }`. */
  actionsApplied: Array<{
    ruleId?: string;
    action?: Record<string, unknown>;
    at?: string;
  }>;
  actionsScheduled: Array<{
    ruleId?: string;
    action?: Record<string, unknown>;
    runAt?: string;
    scheduledId?: string;
  }>;
  modelVersion: string;
  createdAt: string;
};
type ScheduledStatus = {
  id: string;
  status: string;
  runAt: string;
  lastError: string | null;
  attempts: number;
};
type DecisionsResponse = {
  decisions: DecisionRow[];
  scheduled: Record<string, ScheduledStatus>;
  nextCursor: string | null;
};

/**
 * Read-only list of email decisions: every message the classifier has
 * scored that ended in at least one matched rule (or applied/scheduled
 * action). Paginated by cursor; clicking a row expands the per-rule
 * reasoning + the structured action list. Mirrors the Settings →
 * Audit log surface, but anchored on the email rather than the
 * mutation.
 */
function DecisionsList({ onEditRule }: { onEditRule: (ruleId: string) => void }) {
  const [onlyActed, setOnlyActed] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<DecisionRow[][]>([]);
  const [scheduled, setScheduled] = useState<Record<string, ScheduledStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useQuery<DecisionsResponse>({
    queryKey: ['decisions', onlyActed, cursor],
    queryFn: () =>
      apiGet<DecisionsResponse>(
        `/api/decisions?onlyActed=${onlyActed}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`,
      ),
    refetchOnWindowFocus: false,
  });

  // Reset accumulator when the filter flips.
  useEffect(() => {
    setPages([]);
    setCursor(null);
    setScheduled({});
  }, [onlyActed]);

  // Append the latest page when the query lands.
  useEffect(() => {
    if (!query.data) return;
    setPages((prev) => {
      const lastPage = prev[prev.length - 1];
      const incoming = query.data!.decisions;
      const lastIncoming = incoming[incoming.length - 1];
      // Avoid double-append on Strict Mode re-fire when nothing
      // about the cursor changed.
      if (lastPage && lastIncoming && lastPage[lastPage.length - 1]?.id === lastIncoming.id) {
        return prev;
      }
      return [...prev, incoming];
    });
    setScheduled((prev) => ({ ...prev, ...query.data!.scheduled }));
  }, [query.data]);

  const decisions = pages.flat();
  const nextCursor = query.data?.nextCursor ?? null;

  return (
    <section className="rules-section">
      <div className="rules-section-head">
        <div className="muted" style={{ fontSize: '0.82rem' }}>
          Every email the classifier evaluated, what rule matched, and the
          actions taken (or scheduled). Newest first.
        </div>
        <label className="row" style={{ gap: '0.35rem', fontSize: '0.85rem' }}>
          <input
            type="checkbox"
            checked={onlyActed}
            onChange={(e) => setOnlyActed(e.target.checked)}
          />
          Only show emails where a rule matched
        </label>
      </div>

      {query.isLoading && pages.length === 0 ? (
        <div className="empty">Loading…</div>
      ) : decisions.length === 0 ? (
        <div className="empty">
          {onlyActed
            ? 'No matched decisions yet — run rules to populate.'
            : 'No classifier passes recorded yet.'}
        </div>
      ) : (
        <div className="decision-list">
          {decisions.map((d) => (
            <DecisionRowCard
              key={d.id}
              decision={d}
              scheduled={scheduled}
              isOpen={expanded.has(d.id)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(d.id)) next.delete(d.id);
                  else next.add(d.id);
                  return next;
                })
              }
              onEditRule={onEditRule}
            />
          ))}
          {nextCursor && (
            <button
              className="decision-load-more"
              onClick={() => setCursor(nextCursor)}
              disabled={query.isFetching}
            >
              {query.isFetching ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DecisionRowCard({
  decision,
  scheduled,
  isOpen,
  onToggle,
  onEditRule,
}: {
  decision: DecisionRow;
  scheduled: Record<string, ScheduledStatus>;
  isOpen: boolean;
  onToggle: () => void;
  onEditRule: (ruleId: string) => void;
}) {
  return (
    <div className={`decision-row ${isOpen ? 'open' : ''}`}>
      <div
        className="decision-row-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div
          className="decision-row-when muted"
          title={new Date(decision.createdAt).toLocaleString()}
        >
          {formatRelativeDate(decision.createdAt)}
        </div>
        <div className="decision-row-subject" title={decision.subject ?? ''}>
          <strong>
            {shortFrom(decision.originalFrom ?? decision.from)}
          </strong>
          {decision.listId && (
            <span
              className="chip via-list"
              title={`Forwarded via mailing list ${decision.listId}${
                decision.originalFrom ? ` — original sender ${decision.originalFrom}` : ''
              }`}
            >
              via list
            </span>
          )}
          {decision.subject ? <> — {decision.subject}</> : null}
        </div>
        <div className="decision-row-snippet-line muted" title={decision.snippet ?? ''}>
          {decision.snippet ?? ''}
        </div>
        <div className="decision-row-actions">
          {decision.actionsApplied.map((a, i) => (
            <span key={`a-${i}`} className="chip accent">
              {describeAction(a.action ?? {})}
            </span>
          ))}
          {decision.actionsScheduled.map((s, i) => {
            const status = s.scheduledId ? scheduled[s.scheduledId] : undefined;
            return (
              <span
                key={`s-${i}`}
                className={`chip ${status?.status === 'failed' ? 'danger' : 'warn'}`}
                title={
                  s.runAt
                    ? `runs ${new Date(s.runAt).toLocaleString()}${
                        status ? ` · ${status.status}${status.lastError ? ` — ${status.lastError}` : ''}` : ''
                      }`
                    : status
                      ? `${status.status}${status.lastError ? ` — ${status.lastError}` : ''}`
                      : undefined
                }
              >
                ⏰ {describeAction(s.action ?? {})}
                {s.runAt ? ` · ${formatRelativeDate(s.runAt)}` : ''}
              </span>
            );
          })}
        </div>
        <div className="decision-row-caret muted">
          <a
            href={gmailMessageUrl(decision.gmailMessageId)}
            target="_blank"
            rel="noreferrer"
            className="decision-row-open"
            onClick={(e) => e.stopPropagation()}
            title="Open this email in Gmail"
            aria-label="Open in Gmail"
          >
            ↗
          </a>
          <span className="decision-row-toggle">{isOpen ? '▾' : '▸'}</span>
        </div>
      </div>
      {isOpen && (
        <div className="decision-row-body">
          {decision.snippet && (
            <div className="decision-row-snippet muted">
              {decision.snippet.slice(0, 280)}
            </div>
          )}
          {decision.matchedRules.length > 0 && (
            <div className="decision-row-rules-detail">
              <div className="muted decision-row-section-head">Matched rules</div>
              {decision.matchedRules.map((r) => {
                const why = decision.reasoning.find((x) => x.ruleId === r.id);
                const isDeleted = r.naturalLanguage === '(rule deleted)';
                return (
                  <div key={r.id} className="decision-row-rule">
                    <div className="decision-row-rule-head">
                      <div className="decision-row-rule-nl">{r.naturalLanguage}</div>
                      {!isDeleted && (
                        <button
                          type="button"
                          className="decision-row-rule-edit"
                          onClick={() => onEditRule(r.id)}
                          title={`Edit rule: ${r.naturalLanguage}`}
                        >
                          Edit ✎
                        </button>
                      )}
                    </div>
                    {why && (
                      <div className="muted decision-row-rule-why">{why.reasoning}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="muted decision-row-meta">
            Model: {decision.modelVersion} ·{' '}
            <a
              href={gmailMessageUrl(decision.gmailMessageId)}
              target="_blank"
              rel="noreferrer"
              className="decision-row-open-link"
              title={`Open ${decision.gmailMessageId} in Gmail`}
            >
              Open in Gmail ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/** Direct-link URL into the user's Gmail for a given Gmail message id.
 *  Uses the "all mail" view so the link works regardless of where the
 *  message currently sits (inbox, archived, snoozed, sent, etc.).
 *  `u/0` is the first signed-in account in this browser session — for
 *  users with a single Gmail account that's the right one. If we ever
 *  need to disambiguate across multiple accounts we'd add `authuser=`
 *  with the user's email. */
function gmailMessageUrl(gmailMessageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(gmailMessageId)}`;
}

/** Compact, scannable date format. Today: "1:23 PM". This year:
 *  "Apr 28". Older: "4/28/24". Hover title shows the full timestamp. */
function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, {
    year: '2-digit',
    month: 'numeric',
    day: 'numeric',
  });
}

/** Strip `<addr>` from the From header so the bold sender doesn't
 *  swallow the row. Falls back to the whole header when there's no
 *  display name. */
function shortFrom(from: string | null): string {
  if (!from) return '(unknown sender)';
  const trimmed = from.trim();
  // "Display Name <addr@host>" → "Display Name"
  const m = /^(.+?)\s*<[^>]+>\s*$/.exec(trimmed);
  if (m && m[1]) return m[1].replace(/^"|"$/g, '');
  return trimmed;
}

function describeAction(a: Record<string, unknown>): string {
  const type = typeof a.type === 'string' ? a.type : '?';
  switch (type) {
    case 'addLabel':
      return `+ label "${String(a.labelName ?? '?')}"`;
    case 'removeLabel':
      return `− label "${String(a.labelName ?? '?')}"`;
    case 'archive':
      return 'archive';
    case 'markRead':
      return 'mark read';
    case 'star':
      return 'star';
    case 'markImportant':
      return 'mark important';
    case 'forward':
      return `forward → ${String(a.to ?? '?')}`;
    case 'trash':
      return 'trash';
    default:
      return type;
  }
}

// ── rule row ────────────────────────────────────────────────────────────

function RuleRow(props: {
  rule: Rule;
  index: number;
  total: number;
  running: boolean;
  disableRun: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onRun: () => void;
}) {
  const { rule, index, total, running, disableRun, onToggle, onEdit, onDelete, onMove, onRun } =
    props;
  return (
    <div className="rule-card" style={{ opacity: rule.enabled ? 1 : 0.55 }}>
      <div className="rule-card-order">
        <div className="muted">#{index + 1}</div>
        <div className="row" style={{ gap: '0.15rem' }}>
          <button onClick={() => onMove(-1)} disabled={index === 0} title="Up">
            ↑
          </button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} title="Down">
            ↓
          </button>
        </div>
      </div>
      <div className="rule-card-body">
        <div className="rule-card-text">{rule.naturalLanguage}</div>
      </div>
      <div className="rule-card-controls">
        <label className="row" style={{ gap: '0.3rem', fontSize: '0.8rem' }}>
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="muted">On</span>
        </label>
        <button
          onClick={onRun}
          disabled={running || disableRun || !rule.enabled}
          title={
            !rule.enabled
              ? 'Enable the rule first'
              : disableRun
                ? 'Another run is already in progress'
                : 'Run this rule on the last 10 inbox messages'
          }
        >
          {running ? 'Starting…' : 'Run'}
        </button>
        <button onClick={onEdit}>Edit</button>
        <button onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

// ── rule editor modal ───────────────────────────────────────────────────

type EditorProps =
  | { mode: 'create'; onClose: () => void }
  | { mode: 'edit'; rule: Rule; onClose: () => void };

function RuleEditor(props: EditorProps) {
  const qc = useQueryClient();
  const [nl, setNl] = useState(props.mode === 'edit' ? props.rule.naturalLanguage : '');
  const [enabled, setEnabled] = useState(props.mode === 'edit' ? props.rule.enabled : true);

  const save = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const body = { naturalLanguage: nl, enabled };
      if (props.mode === 'edit') return apiSend('PUT', `/api/rules/${props.rule.id}`, body);
      return apiSend('POST', '/api/rules', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['rules'] });
      props.onClose();
    },
  });

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{props.mode === 'create' ? 'New AI rule' : 'Edit AI rule'}</h3>
        <div className="stack" style={{ gap: '0.75rem' }}>
          <div>
            <label className="muted" style={{ fontSize: '0.8rem' }}>
              AI rule
            </label>
            <textarea
              value={nl}
              onChange={(e) => setNl(e.target.value)}
              placeholder='e.g. "archive promotional emails at end of day"'
              rows={4}
            />
            <div className="muted" style={{ fontSize: '0.75rem', marginTop: '0.3rem' }}>
              Describe the condition and what to do. The AI decides actions and timing per email.
            </div>
          </div>

          <RuleCheckPanel nl={nl} onAcceptRewrite={(s) => setNl(s)} />

          <div className="row">
            <label className="row" style={{ gap: '0.35rem' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>
          </div>
          {save.isError && <div className="banner error">{(save.error as Error).message}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={props.onClose}>Cancel</button>
            <button className="primary" onClick={() => save.mutate()} disabled={!nl.trim() || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
