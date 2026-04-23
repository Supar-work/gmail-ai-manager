import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Action } from '@gam/shared';
import { apiGet, apiSend, ApiError } from '../lib/api.js';
import { RunLogPanel, useActiveRun } from '../components/RunLogPanel.js';
import {
  GmailFiltersList,
  useAutoSyncOnMount,
  useGmailFiltersQuery,
} from '../components/GmailFiltersList.js';
import { RuleCheckPanel } from '../components/RuleAnalyzer.js';
import { InboxCleanupWizard } from '../components/InboxCleanupWizard.js';

// ── types ─────────────────────────────────────────────────────────────────

type Rule = {
  id: string;
  naturalLanguage: string;
  actionsJson: Action[];
  enabled: boolean;
  position: number;
};
type RulesResponse = { rules: Rule[] };

type StartRunResponse = { runId: string };

// ── page ──────────────────────────────────────────────────────────────────

type Tab = 'ai-rules' | 'gmail-filters';

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
