import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../lib/api.js';

export type RunEvent = { t: number; level: 'info' | 'warn' | 'error'; msg: string };
export type RunAction = {
  kind: 'applied' | 'scheduled';
  t: number;
  ruleId: string;
  subject: string | null;
  gmailMessageId: string;
  action: { type: string; labelName?: string; to?: string };
  runAt?: string;
};
export type RunDetail = {
  id: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  control: 'running' | 'paused' | 'stopping';
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  matched: number;
  applied: number;
  scheduled: number;
  skipped: number;
  errorMsg: string | null;
  events: RunEvent[];
  actions: RunAction[];
};

export function RunLogPanel({
  runId,
  label,
  onClose,
}: {
  runId: string;
  label: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'log' | 'summary'>('log');

  const run = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => apiGet<RunDetail>(`/api/runs/${runId}`),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1000 : false),
    refetchOnWindowFocus: false,
  });

  const pause = useMutation<unknown>({
    mutationFn: () => apiSend('POST', `/api/runs/${runId}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  });
  const resume = useMutation<unknown>({
    mutationFn: () => apiSend('POST', `/api/runs/${runId}/resume`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  });
  const stop = useMutation<unknown>({
    mutationFn: () => apiSend('POST', `/api/runs/${runId}/stop`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (tab === 'log' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [run.data?.events.length, tab]);

  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    const s = run.data?.status;
    if (prevStatus.current === 'running' && s && s !== 'running') {
      void qc.invalidateQueries({ queryKey: ['decisions'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    }
    if (s) prevStatus.current = s;
  }, [run.data?.status, qc]);

  const r = run.data;
  const status = r?.status ?? 'running';
  const control = r?.control ?? 'running';
  const isRunning = status === 'running';
  const canClose = !isRunning;

  return (
    <aside className="run-log">
      <header className="run-log-head">
        <div>
          <div className="run-log-title">Run: {label}</div>
          <div className="muted" style={{ fontSize: '0.75rem' }}>
            {r?.startedAt ? new Date(r.startedAt).toLocaleTimeString() : ''} ·{' '}
            {statusText(status, control)}
          </div>
        </div>
        <button onClick={onClose} disabled={!canClose} title={canClose ? 'Dismiss' : 'Running…'}>
          ×
        </button>
      </header>

      {isRunning && (
        <div className="run-log-controls">
          {control === 'running' && (
            <button onClick={() => pause.mutate()} disabled={pause.isPending}>
              ⏸ Pause
            </button>
          )}
          {control === 'paused' && (
            <button className="primary" onClick={() => resume.mutate()} disabled={resume.isPending}>
              ▶ Resume
            </button>
          )}
          <button className="danger" onClick={() => stop.mutate()} disabled={stop.isPending || control === 'stopping'}>
            {control === 'stopping' ? 'Stopping…' : '■ Stop'}
          </button>
        </div>
      )}

      {r && (
        <div className="run-log-stats">
          <Stat label="scanned" v={r.scanned} />
          <Stat label="matched" v={r.matched} />
          <Stat label="applied" v={r.applied} />
          <Stat label="scheduled" v={r.scheduled} />
          <Stat label="cached" v={r.skipped} />
        </div>
      )}
      {r?.errorMsg && <div className="banner error">{r.errorMsg}</div>}

      <div className="run-log-tabs">
        <button
          className={`run-log-tab ${tab === 'log' ? 'on' : ''}`}
          onClick={() => setTab('log')}
        >
          Log
        </button>
        <button
          className={`run-log-tab ${tab === 'summary' ? 'on' : ''}`}
          onClick={() => setTab('summary')}
        >
          Summary {r ? `(${r.actions.length})` : ''}
        </button>
      </div>

      {tab === 'log' && (
        <div className="run-log-events" ref={scrollRef}>
          {!r && <div className="muted">Starting…</div>}
          {r?.events.length === 0 && <div className="muted">Waiting for first event…</div>}
          {r?.events.map((e, i) => (
            <div key={i} className={`run-log-event run-log-event--${e.level}`}>
              <span className="run-log-time">{fmtTime(e.t)}</span>
              <span className="run-log-msg">{e.msg}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'summary' && r && <SummaryList actions={r.actions} />}
    </aside>
  );
}

function SummaryList({ actions }: { actions: RunAction[] }) {
  if (actions.length === 0) {
    return (
      <div className="run-log-events">
        <div className="muted">No actions yet.</div>
      </div>
    );
  }
  const applied = actions.filter((a) => a.kind === 'applied');
  const scheduled = actions.filter((a) => a.kind === 'scheduled');
  return (
    <div className="run-log-events">
      {applied.length > 0 && (
        <div className="summary-section">
          <div className="summary-heading">Applied · {applied.length}</div>
          {applied.map((a, i) => (
            <SummaryRow key={`a-${i}`} a={a} />
          ))}
        </div>
      )}
      {scheduled.length > 0 && (
        <div className="summary-section">
          <div className="summary-heading">Scheduled · {scheduled.length}</div>
          {scheduled.map((a, i) => (
            <SummaryRow key={`s-${i}`} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ a }: { a: RunAction }) {
  const label = describeAction(a.action);
  return (
    <div className="summary-row">
      <span className={`chip ${a.kind === 'applied' ? 'accent' : 'warn'}`}>{label}</span>
      <a
        href={`https://mail.google.com/mail/u/0/#inbox/${a.gmailMessageId}`}
        target="_blank"
        rel="noreferrer"
        className="summary-subject"
        title={a.subject ?? a.gmailMessageId}
      >
        {a.subject ?? a.gmailMessageId.slice(0, 12)}
      </a>
      {a.runAt && (
        <span className="muted" style={{ fontSize: '0.72rem' }}>
          @ {new Date(a.runAt).toLocaleString()}
        </span>
      )}
    </div>
  );
}

function describeAction(a: { type: string; labelName?: string; to?: string }): string {
  switch (a.type) {
    case 'addLabel':
      return `+ ${a.labelName ?? 'label'}`;
    case 'removeLabel':
      return `− ${a.labelName ?? 'label'}`;
    case 'forward':
      return `→ ${a.to ?? 'email'}`;
    default:
      return a.type;
  }
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="run-stat">
      <div className="run-stat-v">{v}</div>
      <div className="run-stat-k">{label}</div>
    </div>
  );
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function statusText(status: string, control: string): string {
  if (status === 'running') {
    if (control === 'paused') return 'Paused';
    if (control === 'stopping') return 'Stopping…';
    return 'Running…';
  }
  if (status === 'done') return 'Done';
  if (status === 'error') return 'Failed';
  if (status === 'stopped') return 'Stopped';
  return status;
}

export function useActiveRun() {
  const [runId, setRunId] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  return {
    runId,
    label,
    open: runId != null,
    start: (id: string, lbl: string) => {
      setRunId(id);
      setLabel(lbl);
    },
    dismiss: () => {
      setRunId(null);
      setLabel(null);
    },
  };
}
