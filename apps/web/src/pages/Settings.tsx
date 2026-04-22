import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiSend, ApiError } from '../lib/api.js';
import { type RunDetail } from '../components/RunLogPanel.js';

// ── types ─────────────────────────────────────────────────────────────────

type SettingsResponse = {
  pollIntervalSec: number;
  timezone: string;
  claudeModel: string | null;
};
type RunRow = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  status: 'running' | 'done' | 'error';
  scanned: number;
  matched: number;
  applied: number;
  scheduled: number;
  skipped: number;
  errorMsg: string | null;
};


// ── page ──────────────────────────────────────────────────────────────────

export function Settings() {
  const navigate = useNavigate();
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);

  return (
    <div className="settings-page">
      <div className="settings-head">
        <button onClick={() => navigate('/')} className="back-link">
          ← Back
        </button>
        <h1>Settings</h1>
      </div>

      <ClaudeModelSection />
      <SyncFrequencySection />
      <RunHistorySection onOpen={setViewingRunId} />

      {viewingRunId && (
        <RunDetailModal runId={viewingRunId} onClose={() => setViewingRunId(null)} />
      )}
    </div>
  );
}

// ── model ─────────────────────────────────────────────────────────────────

type ModelOption = { id: string; displayName: string; hint?: string; recommended?: boolean };
type ModelsResponse = { models: ModelOption[]; source: 'claude' | 'curated' };

function ClaudeModelSection() {
  const qc = useQueryClient();
  const s = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => apiGet('/api/settings'),
  });
  const m = useQuery<ModelsResponse>({
    queryKey: ['models'],
    queryFn: () => apiGet('/api/models'),
    staleTime: 5 * 60 * 1000,
  });
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (s.data && draft == null) setDraft(s.data.claudeModel ?? '');
  }, [s.data, draft]);

  const save = useMutation<SettingsResponse, Error, string>({
    mutationFn: (val) =>
      apiSend<SettingsResponse>('PUT', '/api/settings', {
        claudeModel: val === '' ? null : val,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (s.isLoading || m.isLoading) return <section className="settings-section">Loading…</section>;
  if (s.isError)
    return <section className="settings-section banner error">Failed to load settings.</section>;

  const current = s.data!.claudeModel ?? '';
  const dirty = draft != null && draft !== current;
  const models = m.data?.models ?? [];
  const picked = models.find((o) => o.id === (draft ?? current));

  return (
    <section className="settings-section">
      <h2>Classifier model</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Model passed to <code>claude -p</code> for every rule-matching call. Haiku is the right
        default — classification is a lightweight task and cost adds up fast across a full inbox.
      </p>
      <div className="row wrap">
        <select
          value={draft ?? current}
          onChange={(e) => setDraft(e.target.value)}
          style={{ maxWidth: 360 }}
        >
          <option value="">Claude Code CLI default</option>
          {models.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
              {o.recommended ? ' — recommended' : ''} ({o.id})
            </option>
          ))}
        </select>
        <button
          className="primary"
          onClick={() => draft != null && save.mutate(draft)}
          disabled={!dirty || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.isSuccess && !dirty && <span className="muted">Saved.</span>}
      </div>
      {picked?.hint && (
        <div className="muted" style={{ fontSize: '0.8rem' }}>
          {picked.hint}
        </div>
      )}
      {m.data && (
        <div className="muted" style={{ fontSize: '0.72rem' }}>
          {m.data.source === 'claude'
            ? `Fetched via claude -p · ${models.length} models · cached 24h.`
            : `Curated fallback list (claude -p didn't respond).`}
        </div>
      )}
      {save.isError && <div className="banner error">{(save.error as Error).message}</div>}
    </section>
  );
}

// ── sync frequency ────────────────────────────────────────────────────────

function SyncFrequencySection() {
  const qc = useQueryClient();
  const s = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => apiGet('/api/settings'),
  });

  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => {
    if (s.data && draft == null) setDraft(s.data.pollIntervalSec);
  }, [s.data, draft]);

  const save = useMutation<SettingsResponse, Error, number>({
    mutationFn: (pollIntervalSec) =>
      apiSend<SettingsResponse>('PUT', '/api/settings', { pollIntervalSec }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (s.isLoading) return <section className="settings-section">Loading…</section>;
  if (s.isError) return <section className="settings-section banner error">Failed to load settings.</section>;

  const current = s.data!.pollIntervalSec;
  const dirty = draft != null && draft !== current;

  return (
    <section className="settings-section">
      <h2>Sync frequency</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        How often the app checks Gmail for new messages to classify. Minimum 60s, maximum 1 hour.
      </p>
      <div className="row">
        <input
          type="number"
          min={60}
          max={3600}
          step={30}
          value={draft ?? current}
          onChange={(e) => setDraft(Number(e.target.value))}
          style={{ maxWidth: 120 }}
        />
        <span className="muted">seconds</span>
        <button
          className="primary"
          onClick={() => draft != null && save.mutate(draft)}
          disabled={!dirty || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.isSuccess && !dirty && <span className="muted">Saved.</span>}
      </div>
      {save.isError && <div className="banner error">{(save.error as Error).message}</div>}
    </section>
  );
}


// ── run history ───────────────────────────────────────────────────────────

function RunHistorySection({ onOpen }: { onOpen: (id: string) => void }) {
  const runs = useQuery<{ runs: RunRow[] }>({
    queryKey: ['runs'],
    queryFn: () => apiGet('/api/runs'),
    refetchInterval: 5000,
    retry: false,
  });

  return (
    <section className="settings-section">
      <h2>Run history</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Every manual, polled, and scheduled run, most recent first. Click a row to see events.
      </p>
      {runs.isLoading && <div className="muted">Loading…</div>}
      {runs.isError && <div className="banner error">Failed to load runs.</div>}
      {runs.data && runs.data.runs.length === 0 && (
        <div className="muted">No runs yet — trigger one from the main page.</div>
      )}
      {runs.data && runs.data.runs.length > 0 && (
        <table className="table runs-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Trigger</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Scanned</th>
              <th style={{ textAlign: 'right' }}>Matched</th>
              <th style={{ textAlign: 'right' }}>Applied</th>
              <th style={{ textAlign: 'right' }}>Scheduled</th>
              <th style={{ textAlign: 'right' }}>Cached</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.data.runs.map((r) => (
              <tr key={r.id}>
                <td className="muted" style={{ fontSize: '0.78rem' }}>
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td>
                  <span className="chip">{r.trigger}</span>
                </td>
                <td>
                  <StatusChip status={r.status} />
                </td>
                <td style={{ textAlign: 'right' }}>{r.scanned}</td>
                <td style={{ textAlign: 'right' }}>{r.matched}</td>
                <td style={{ textAlign: 'right' }}>{r.applied}</td>
                <td style={{ textAlign: 'right' }}>{r.scheduled}</td>
                <td style={{ textAlign: 'right' }}>{r.skipped}</td>
                <td>
                  <button onClick={() => onOpen(r.id)}>View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: RunRow['status'] }) {
  const cls = status === 'done' ? 'accent' : status === 'error' ? 'danger' : 'warn';
  return <span className={`chip ${cls}`}>{status}</span>;
}

// ── past-run detail modal ─────────────────────────────────────────────────

function RunDetailModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const r = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => apiGet(`/api/runs/${runId}`),
  });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Run log</h3>
          <button onClick={onClose}>Close</button>
        </div>
        {r.isLoading && <div className="muted">Loading…</div>}
        {r.data && (
          <>
            <div className="run-log-stats" style={{ marginTop: '0.5rem' }}>
              <Stat label="scanned" v={r.data.scanned} />
              <Stat label="matched" v={r.data.matched} />
              <Stat label="applied" v={r.data.applied} />
              <Stat label="scheduled" v={r.data.scheduled} />
              <Stat label="cached" v={r.data.skipped} />
            </div>
            {r.data.errorMsg && <div className="banner error">{r.data.errorMsg}</div>}
            <div className="run-log-events" style={{ maxHeight: '50vh' }}>
              {r.data.events.map((e, i) => (
                <div key={i} className={`run-log-event run-log-event--${e.level}`}>
                  <span className="run-log-time">
                    {new Date(e.t).toLocaleTimeString()}
                  </span>
                  <span className="run-log-msg">{e.msg}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="run-stat">
      <div className="run-stat-v">{v}</div>
      <div className="run-stat-k">{label}</div>
    </div>
  );
}

