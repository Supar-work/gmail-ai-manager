import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiSend, ApiError } from '../lib/api.js';
import { type RunDetail } from '../components/RunLogPanel.js';

// ── types ─────────────────────────────────────────────────────────────────

type SettingsResponse = {
  pollIntervalSec: number;
  timezone: string;
  claudeModel: string | null;
  /** User's editable cross-cutting AI guidance, or null if unset
   *  (server falls back to the default). */
  aiGuidance?: string | null;
  /** What the proposer actually sees — either the user override or
   *  the default. Read-only on the server side. */
  aiGuidanceEffective?: string;
  /** The factory default, surfaced for the "Reset to defaults" button. */
  aiGuidanceDefault?: string;
  /** Auto-learned memory bullet list distilled by the consolidator. */
  learnedMemory?: string | null;
  /** ISO timestamp of last consolidation, or null if never run. */
  learnedMemoryAt?: string | null;
};

type ConsolidationResult =
  | { ran: true; patternsCount: number; memo: string }
  | { ran: false; reason: string };
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
      <AiGuidanceSection />
      <ForwardAllowlistSection />
      <RuleMaintenanceSection />
      <CleanupCacheSection />
      <AuditLogSection />
      <BackupRestoreSection />
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


// ── backup & restore ──────────────────────────────────────────────────────

type ImportResult = {
  mode: 'merge' | 'replace';
  rulesImported: number;
  gmailFiltersImported: number;
};

type ExportPayload = {
  version: 1;
  exportedAt?: string;
  data: {
    users?: unknown[];
    rules: unknown[];
    gmailFilters: unknown[];
  };
};

// ── Audit log ─────────────────────────────────────────────────────────────

type AgentActionRow = {
  id: string;
  source: 'rule' | 'schedule' | 'cleanup' | 'chat' | 'consolidator' | 'maintenance';
  sourceId: string | null;
  targetType: 'gmailMessage' | 'gmailLabel' | 'rule' | 'scheduledAction';
  targetId: string;
  toolName: string;
  toolInput: unknown;
  toolResult: unknown;
  reasoning: string | null;
  reversibleAs: unknown;
  reversedAt: string | null;
  reversedBy: string | null;
  createdAt: string;
};

type AgentActionsResponse = {
  rows: AgentActionRow[];
  nextCursor: string | null;
};

// ── cleanup cache reset ─────────────────────────────────────────────────

/**
 * Drops the inbox-cleanup wizard's in-memory caches (proposalCache,
 * previewCache, recommendCache) for THIS user only. Use after
 * tweaking AI guidance or when proposed rules look stale — the next
 * wizard run will hit Claude fresh for every email.
 */
// ── rule maintenance ────────────────────────────────────────────────────

type RecommendationKind =
  | 'merge'
  | 'sharpen'
  | 'simplify'
  | 'list_aware'
  | 'disable'
  | 'split';

type ProposedRule = {
  naturalLanguage: string;
  actions: Array<Record<string, unknown>>;
};

type Recommendation = {
  kind: RecommendationKind;
  affectedRuleIds: string[];
  rationale: string;
  confidence: number;
  proposed?: ProposedRule[];
};

type AnalyzeResponse = { recommendations: Recommendation[] };

type RulesResponse = {
  rules: Array<{ id: string; naturalLanguage: string; enabled: boolean; position: number }>;
};

const KIND_LABELS: Record<RecommendationKind, string> = {
  merge: 'Merge',
  sharpen: 'Sharpen',
  simplify: 'Simplify',
  list_aware: 'Use list:',
  disable: 'Disable',
  split: 'Split',
};

const KIND_HINTS: Record<RecommendationKind, string> = {
  merge: 'Two or more rules describe the same class — collapse into one.',
  sharpen: 'Rule fires too broadly — narrow the predicate.',
  simplify: 'Rewrite the rule in clearer English without changing meaning.',
  list_aware: 'Rule keys off a list-rewritten From; switch to list:<id>.',
  disable: "Rule hasn't matched anything recently — turn it off.",
  split: 'Rule conflates two distinct intents — split into separate rules.',
};

/**
 * Settings → Rule maintenance. One-shot button that asks Claude to
 * audit every rule + its match history + reversal history, returning
 * concrete edits. Each recommendation is reviewable and applies in a
 * single click; every apply writes to the AgentAction audit log
 * under source='maintenance' for auditability.
 */
function RuleMaintenanceSection() {
  const qc = useQueryClient();
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  const rules = useQuery<RulesResponse>({
    queryKey: ['rules'],
    queryFn: () => apiGet('/api/rules'),
    retry: false,
  });
  const ruleById = new Map(
    (rules.data?.rules ?? []).map((r) => [r.id, r] as const),
  );

  const analyze = useMutation<AnalyzeResponse>({
    mutationFn: () => apiSend('POST', '/api/settings/rule-maintenance/analyze'),
    onSuccess: (res) => {
      setRecs(res.recommendations);
      setHidden(new Set());
    },
  });

  const applyRec = useMutation<unknown, Error, { idx: number; rec: Recommendation }>({
    mutationFn: ({ rec }) =>
      apiSend('POST', '/api/settings/rule-maintenance/apply', { recommendation: rec }),
    onSuccess: (_res, vars) => {
      setHidden((prev) => {
        const next = new Set(prev);
        next.add(vars.idx);
        return next;
      });
      qc.invalidateQueries({ queryKey: ['rules'] });
      qc.invalidateQueries({ queryKey: ['agent-actions'] });
    },
  });

  return (
    <section className="settings-section">
      <h2>Rule maintenance</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Ask AI to audit your rules + the last 30 days of decisions and reversals,
        then recommend merges, sharpens, simplifications, list-aware rewrites,
        and disables. Each suggestion can be reviewed and applied individually —
        every apply lands in the audit log under <code>source=maintenance</code>.
      </p>
      <div className="row" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
        <button
          onClick={() => analyze.mutate()}
          disabled={analyze.isPending}
          className={recs.length === 0 ? 'primary' : ''}
        >
          {analyze.isPending ? 'Analyzing…' : recs.length === 0 ? 'Analyze rules' : 'Re-analyze'}
        </button>
        {analyze.isSuccess && recs.length === 0 && (
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            No recommendations — your rules look clean.
          </span>
        )}
        {analyze.isError && (
          <span className="error" style={{ fontSize: '0.85rem' }}>
            Failed: {(analyze.error as Error).message}
          </span>
        )}
      </div>

      {recs.length > 0 && (
        <div className="rec-list" style={{ marginTop: '0.75rem' }}>
          {recs.map((r, i) =>
            hidden.has(i) ? null : (
              <RecommendationCard
                key={`${r.kind}-${i}`}
                rec={r}
                ruleById={ruleById}
                onApply={(rec) => applyRec.mutate({ idx: i, rec })}
                onSkip={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    next.add(i);
                    return next;
                  })
                }
                applying={applyRec.isPending && applyRec.variables?.idx === i}
                applyError={
                  applyRec.isError && applyRec.variables?.idx === i
                    ? (applyRec.error as Error).message
                    : null
                }
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function RecommendationCard({
  rec,
  ruleById,
  onApply,
  onSkip,
  applying,
  applyError,
}: {
  rec: Recommendation;
  ruleById: Map<string, { id: string; naturalLanguage: string; enabled: boolean }>;
  /** Receives the (possibly user-edited) recommendation to apply.
   *  For DISABLE we let the user uncheck specific rules, so the
   *  applied list may be a subset of `rec.affectedRuleIds`. */
  onApply: (rec: Recommendation) => void;
  onSkip: () => void;
  applying: boolean;
  applyError: string | null;
}) {
  const qc = useQueryClient();

  // Per-rule selection state for kinds that support partial apply
  // (currently only DISABLE — merge/split/etc. are atomic).
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rec.affectedRuleIds),
  );
  const allSelected = selected.size === rec.affectedRuleIds.length;
  const noneSelected = selected.size === 0;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rec.affectedRuleIds));

  // Live edits to the proposed (AFTER) rules — pencil-icon edits land
  // here and flow into Apply via `finalRec.proposed`. Null = unchanged.
  const [editedProposed, setEditedProposed] = useState<ProposedRule[] | null>(null);
  const proposedLive = editedProposed ?? rec.proposed ?? [];
  const onEditProposed = (idx: number, naturalLanguage: string) => {
    const base = editedProposed ?? rec.proposed ?? [];
    setEditedProposed(
      base.map((p, i) => (i === idx ? { ...p, naturalLanguage } : p)),
    );
  };

  // Edit an existing (BEFORE) rule directly. Saves via PUT /api/rules/:id
  // and invalidates the rules query so the card re-renders with the
  // updated text from `ruleById`.
  const editRule = useMutation<unknown, Error, { id: string; naturalLanguage: string }>({
    mutationFn: ({ id, naturalLanguage }) =>
      apiSend('PUT', `/api/rules/${id}`, { naturalLanguage }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const onEditExisting = async (id: string, naturalLanguage: string) => {
    await editRule.mutateAsync({ id, naturalLanguage });
  };
  const isExistingSaving = (id: string) =>
    editRule.isPending && editRule.variables?.id === id;

  const handleApply = () => {
    const finalRec: Recommendation = { ...rec };
    if (editedProposed) finalRec.proposed = editedProposed;
    if (rec.kind === 'disable') {
      finalRec.affectedRuleIds = Array.from(selected);
    }
    onApply(finalRec);
  };

  const cls = `rec-card rec-card--${rec.kind}`;
  return (
    <div className={cls}>
      <div className="rec-card-head">
        <span className={`chip rec-kind rec-kind--${rec.kind}`}>
          {KIND_LABELS[rec.kind]}
        </span>
        <span className="muted rec-card-conf">
          {Math.round(rec.confidence * 100)}% confidence
        </span>
      </div>

      {/* Body: each kind gets a tailored layout. */}
      {rec.kind === 'disable' ? (
        <DisableBody
          rec={rec}
          ruleById={ruleById}
          selected={selected}
          allSelected={allSelected}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onEditExisting={onEditExisting}
          isExistingSaving={isExistingSaving}
        />
      ) : rec.kind === 'merge' ? (
        <MergeBody
          rec={rec}
          ruleById={ruleById}
          proposed={proposedLive}
          onEditProposed={onEditProposed}
          onEditExisting={onEditExisting}
          isExistingSaving={isExistingSaving}
        />
      ) : rec.kind === 'split' ? (
        <SplitBody
          rec={rec}
          ruleById={ruleById}
          proposed={proposedLive}
          onEditProposed={onEditProposed}
          onEditExisting={onEditExisting}
          isExistingSaving={isExistingSaving}
        />
      ) : (
        // sharpen / simplify / list_aware — all single-rule rewrites
        <RewriteBody
          rec={rec}
          ruleById={ruleById}
          proposed={proposedLive}
          onEditProposed={onEditProposed}
          onEditExisting={onEditExisting}
          isExistingSaving={isExistingSaving}
        />
      )}

      {editRule.isError && (
        <div className="banner error" style={{ marginTop: '0.4rem' }}>
          Couldn't save rule edit: {(editRule.error as Error).message}
        </div>
      )}

      <div className="rec-card-rationale muted">{rec.rationale}</div>

      {applyError && (
        <div className="banner error" style={{ marginTop: '0.4rem' }}>
          Apply failed: {applyError}
        </div>
      )}
      <div className="row" style={{ gap: '0.4rem', marginTop: '0.55rem' }}>
        <button onClick={onSkip} disabled={applying}>
          Skip
        </button>
        <button
          className="primary"
          onClick={handleApply}
          disabled={applying || (rec.kind === 'disable' && noneSelected)}
        >
          {applying
            ? 'Applying…'
            : rec.kind === 'disable'
              ? `Apply (${selected.size})`
              : 'Apply'}
        </button>
      </div>
    </div>
  );
}

// ── Per-kind body components ────────────────────────────────────────────

type EditExistingFn = (id: string, naturalLanguage: string) => Promise<void>;
type EditProposedFn = (idx: number, naturalLanguage: string) => void;
type IsExistingSavingFn = (id: string) => boolean;

/** DISABLE — list of affected rules with a checkbox per row. The user
 *  can uncheck rules they want to keep enabled. Toggle-all in the
 *  header. Apply only sends the checked ids. */
function DisableBody({
  rec,
  ruleById,
  selected,
  allSelected,
  onToggle,
  onToggleAll,
  onEditExisting,
  isExistingSaving,
}: {
  rec: Recommendation;
  ruleById: Map<string, { id: string; naturalLanguage: string; enabled: boolean }>;
  selected: Set<string>;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onEditExisting: EditExistingFn;
  isExistingSaving: IsExistingSavingFn;
}) {
  return (
    <>
      <div className="rec-card-detail">
        <div
          className="rec-card-section-head muted"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            Will disable {selected.size} of {rec.affectedRuleIds.length}
          </span>
          <button
            type="button"
            className="rec-toggle-all"
            onClick={onToggleAll}
          >
            {allSelected ? 'Uncheck all' : 'Check all'}
          </button>
        </div>
        <ul className="rec-card-list">
          {rec.affectedRuleIds.map((id) => {
            const r = ruleById.get(id);
            const checked = selected.has(id);
            const text = r?.naturalLanguage ?? '(rule no longer exists)';
            const exists = !!r;
            return (
              <li key={id} className="rec-card-rule rec-card-rule--check">
                <input
                  type="checkbox"
                  className="rec-checkbox"
                  checked={checked}
                  onChange={() => onToggle(id)}
                  aria-label={`Disable: ${text}`}
                />
                <InlineRuleEditor
                  text={text}
                  onSave={exists ? (next) => onEditExisting(id, next) : null}
                  saving={exists && isExistingSaving(id)}
                  textClassName={r?.enabled === false ? 'muted' : ''}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

/** MERGE — N rules collapse into 1. Show the inputs as a list, then
 *  the proposed canonical version. */
function MergeBody({
  rec,
  ruleById,
  proposed,
  onEditProposed,
  onEditExisting,
  isExistingSaving,
}: {
  rec: Recommendation;
  ruleById: Map<string, { id: string; naturalLanguage: string; enabled: boolean }>;
  proposed: ProposedRule[];
  onEditProposed: EditProposedFn;
  onEditExisting: EditExistingFn;
  isExistingSaving: IsExistingSavingFn;
}) {
  const proposedNL = proposed[0]?.naturalLanguage ?? '';
  return (
    <>
      <div className="rec-card-detail">
        <div className="rec-card-section-head muted">
          Before · {rec.affectedRuleIds.length} rules
        </div>
        <ul className="rec-card-list">
          {rec.affectedRuleIds.map((id) => {
            const r = ruleById.get(id);
            const text = r?.naturalLanguage ?? '(rule no longer exists)';
            return (
              <li key={id} className="rec-card-rule">
                <InlineRuleEditor
                  text={text}
                  onSave={r ? (next) => onEditExisting(id, next) : null}
                  saving={!!r && isExistingSaving(id)}
                />
              </li>
            );
          })}
        </ul>
      </div>
      <div className="rec-card-detail">
        <div className="rec-card-section-head muted">After · 1 rule</div>
        <div className="rec-card-rule rec-card-after">
          <InlineRuleEditor
            text={proposedNL}
            onSave={(next) => onEditProposed(0, next)}
          />
        </div>
      </div>
    </>
  );
}

/** SPLIT — 1 rule into N. Mirror of merge. */
function SplitBody({
  rec,
  ruleById,
  proposed,
  onEditProposed,
  onEditExisting,
  isExistingSaving,
}: {
  rec: Recommendation;
  ruleById: Map<string, { id: string; naturalLanguage: string; enabled: boolean }>;
  proposed: ProposedRule[];
  onEditProposed: EditProposedFn;
  onEditExisting: EditExistingFn;
  isExistingSaving: IsExistingSavingFn;
}) {
  const sourceId = rec.affectedRuleIds[0];
  const sourceRule = sourceId ? ruleById.get(sourceId) : undefined;
  const sourceNL = sourceRule?.naturalLanguage ?? '(rule no longer exists)';
  return (
    <>
      <div className="rec-card-detail">
        <div className="rec-card-section-head muted">Before · 1 rule</div>
        <div className="rec-card-rule">
          <InlineRuleEditor
            text={sourceNL}
            onSave={
              sourceId && sourceRule
                ? (next) => onEditExisting(sourceId, next)
                : null
            }
            saving={!!sourceId && isExistingSaving(sourceId)}
          />
        </div>
      </div>
      <div className="rec-card-detail">
        <div className="rec-card-section-head muted">
          After · {proposed.length} rules
        </div>
        <ul className="rec-card-list">
          {proposed.map((p, i) => (
            <li key={i} className="rec-card-rule rec-card-after">
              <InlineRuleEditor
                text={p.naturalLanguage}
                onSave={(next) => onEditProposed(i, next)}
              />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** SHARPEN / SIMPLIFY / LIST_AWARE — single-rule rewrite. Word-level
 *  diff so removed words show struck through, added words highlighted. */
function RewriteBody({
  rec,
  ruleById,
  proposed,
  onEditProposed,
  onEditExisting,
  isExistingSaving,
}: {
  rec: Recommendation;
  ruleById: Map<string, { id: string; naturalLanguage: string; enabled: boolean }>;
  proposed: ProposedRule[];
  onEditProposed: EditProposedFn;
  onEditExisting: EditExistingFn;
  isExistingSaving: IsExistingSavingFn;
}) {
  const sourceId = rec.affectedRuleIds[0];
  const sourceRule = sourceId ? ruleById.get(sourceId) : undefined;
  const sourceNL = sourceRule?.naturalLanguage ?? '(rule no longer exists)';
  const proposedNL = proposed[0]?.naturalLanguage ?? '';
  return (
    <>
      <div className="rec-card-detail">
        <div className="rec-card-section-head muted">Before</div>
        <div className="rec-card-rule rec-card-before">
          <InlineRuleEditor
            text={sourceNL}
            onSave={
              sourceId && sourceRule
                ? (next) => onEditExisting(sourceId, next)
                : null
            }
            saving={!!sourceId && isExistingSaving(sourceId)}
            renderText={(text) => (
              <DiffSpan text={text} other={proposedNL} side="before" />
            )}
          />
        </div>
      </div>
      <div className="rec-card-detail">
        <div className="rec-card-section-head muted">After</div>
        <div className="rec-card-rule rec-card-after">
          <InlineRuleEditor
            text={proposedNL}
            onSave={(next) => onEditProposed(0, next)}
            renderText={(text) => (
              <DiffSpan text={text} other={sourceNL} side="after" />
            )}
          />
        </div>
      </div>
    </>
  );
}

// ── Inline rule editor ─────────────────────────────────────────────────

/**
 * Renders `text` with a tiny ✎ pencil button at the end. Click → swap
 * to a textarea with Save / Cancel. `onSave` is called with the trimmed
 * draft when the user saves; pass `null` to make the row read-only
 * (e.g., for a rule that no longer exists).
 *
 * `renderText` lets callers like RewriteBody substitute a DiffSpan for
 * the read-only display while still using this component's edit
 * affordance.
 */
function InlineRuleEditor({
  text,
  onSave,
  saving = false,
  renderText,
  textClassName,
}: {
  text: string;
  onSave: ((next: string) => void | Promise<void>) | null;
  saving?: boolean;
  renderText?: (text: string) => ReactNode;
  textClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  // Sync draft when the canonical text changes from outside while we're
  // not actively editing (e.g., another card refetched the rules query).
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  if (editing) {
    const dirty = draft.trim().length > 0 && draft.trim() !== text.trim();
    const cancel = () => {
      setDraft(text);
      setEditing(false);
    };
    return (
      <div className="rec-rule-edit-form">
        <textarea
          className="rec-rule-edit-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 60)))}
          autoFocus
          spellCheck
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && dirty && onSave) {
              e.preventDefault();
              void (async () => {
                await onSave(draft.trim());
                setEditing(false);
              })();
            }
          }}
        />
        <div className="row" style={{ gap: '0.3rem', marginTop: '0.3rem' }}>
          <button
            type="button"
            className="primary"
            disabled={saving || !dirty || !onSave}
            onClick={async () => {
              if (!onSave) return;
              await onSave(draft.trim());
              setEditing(false);
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={cancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <span className="rec-rule-row">
      <span className={`rec-rule-text ${textClassName ?? ''}`}>
        {renderText ? renderText(text) : text}
      </span>
      {onSave && (
        <button
          type="button"
          className="rec-rule-edit-btn"
          onClick={() => setEditing(true)}
          title="Edit rule"
          aria-label="Edit rule"
        >
          ✎
        </button>
      )}
    </span>
  );
}

// ── Word-level diff renderer ────────────────────────────────────────────

/**
 * Render `text` with words that don't appear (case-insensitively) in
 * `other` highlighted. Not a full LCS diff — that would mark too much
 * as changed for paraphrased rewrites — but the simple "is this word
 * present in the other side?" heuristic catches the changed pieces
 * cleanly for short rule sentences.
 */
function DiffSpan({
  text,
  other,
  side,
}: {
  text: string;
  other: string;
  side: 'before' | 'after';
}) {
  const otherTokens = new Set(
    other.toLowerCase().match(/[\w@./\-:'"]+/g) ?? [],
  );
  // Tokenise preserving whitespace + punctuation breaks.
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((p, i) => {
        if (/^\s*$/.test(p)) return p;
        const norm = p.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
        const inOther = norm.length === 0 || otherTokens.has(norm);
        if (inOther) return p;
        return (
          <span
            key={i}
            className={side === 'before' ? 'diff-removed' : 'diff-added'}
          >
            {p}
          </span>
        );
      })}
    </>
  );
}

function CleanupCacheSection() {
  const reset = useMutation<{ ok: true; cleared: number }>({
    mutationFn: () => apiSend('POST', '/api/inbox-cleanup/cache/reset'),
  });
  return (
    <section className="settings-section">
      <h2>Cleanup wizard cache</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        The wizard caches each email's proposed rule + match preview for 12h
        so re-opening it is instant. Reset to force fresh proposals (e.g.
        after editing AI guidance).
      </p>
      <div className="row" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
        <button onClick={() => reset.mutate()} disabled={reset.isPending}>
          {reset.isPending ? 'Resetting…' : 'Reset cleanup cache'}
        </button>
        {reset.isSuccess && (
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            Cleared {reset.data.cleared} cached entr
            {reset.data.cleared === 1 ? 'y' : 'ies'}.
          </span>
        )}
        {reset.isError && (
          <span className="error" style={{ fontSize: '0.85rem' }}>
            Failed: {(reset.error as Error).message}
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * Read-only audit table over every Gmail-mutating action the system has
 * taken — rules, schedules, cleanup wizard, the future chat agent. Each
 * row exposes a one-click "Reverse" button when an inverse Action was
 * recorded with it (label add ↔ remove, archive ↔ un-archive, etc.).
 */
function AuditLogSection() {
  const qc = useQueryClient();
  const [source, setSource] = useState<AgentActionRow['source'] | ''>('');

  const list = useQuery<AgentActionsResponse>({
    queryKey: ['agent-actions', source],
    queryFn: () =>
      apiGet<AgentActionsResponse>(
        `/api/agent-actions?limit=50${source ? `&source=${source}` : ''}`,
      ),
    refetchInterval: 10_000,
    retry: false,
  });

  const reverse = useMutation<unknown, Error, string>({
    mutationFn: (id) => apiSend('POST', `/api/agent-actions/${id}/reverse`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-actions'] }),
  });

  return (
    <section className="settings-section">
      <h2>Audit log</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Every Gmail-mutating action the system takes — rules, schedules, cleanup
        wizard, and (soon) the chat agent. Most actions can be reversed in one
        click; reversal itself shows up as another row so the trail is complete.
      </p>

      <div className="row" style={{ gap: '0.4rem', marginBottom: '0.5rem', alignItems: 'center' }}>
        <label className="muted" style={{ fontSize: '0.78rem' }}>
          Source:
        </label>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as AgentActionRow['source'] | '')}
        >
          <option value="">all</option>
          <option value="rule">rule</option>
          <option value="schedule">schedule</option>
          <option value="cleanup">cleanup</option>
          <option value="chat">chat</option>
          <option value="consolidator">consolidator</option>
          <option value="maintenance">maintenance</option>
        </select>
      </div>

      {list.isLoading && <div className="muted">Loading…</div>}
      {list.isError && (
        <div className="banner error">
          Couldn't load audit log: {(list.error as Error).message}
        </div>
      )}
      {list.data && list.data.rows.length === 0 && (
        <div className="muted">No actions recorded yet.</div>
      )}

      {list.data && list.data.rows.length > 0 && (
        <table className="table runs-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Source</th>
              <th>Tool</th>
              <th>Target</th>
              <th>Reasoning</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data.rows.map((r) => (
              <AuditLogRow
                key={r.id}
                row={r}
                onReverse={() => reverse.mutate(r.id)}
                reversing={reverse.isPending && reverse.variables === r.id}
              />
            ))}
          </tbody>
        </table>
      )}

      {reverse.isError && (
        <div className="banner error" style={{ marginTop: '0.4rem' }}>
          Reverse failed: {(reverse.error as Error).message}
        </div>
      )}
    </section>
  );
}

function AuditLogRow({
  row,
  onReverse,
  reversing,
}: {
  row: AgentActionRow;
  onReverse: () => void;
  reversing: boolean;
}) {
  const reversible = row.reversibleAs != null && row.reversedAt == null;
  const targetLabel = describeTarget(row);
  const toolInputLabel = describeToolInput(row);
  return (
    <tr style={{ opacity: row.reversedAt ? 0.55 : 1 }}>
      <td className="muted" style={{ fontSize: '0.76rem', whiteSpace: 'nowrap' }}>
        {new Date(row.createdAt).toLocaleString()}
      </td>
      <td>
        <span className="chip">{row.source}</span>
      </td>
      <td style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem' }}>
        {row.toolName}
      </td>
      <td style={{ fontSize: '0.82rem' }}>
        {targetLabel}
        {toolInputLabel && (
          <div className="muted" style={{ fontSize: '0.74rem' }}>
            {toolInputLabel}
          </div>
        )}
      </td>
      <td className="muted" style={{ fontSize: '0.78rem', maxWidth: 280 }}>
        {row.reasoning ?? '—'}
      </td>
      <td>
        {row.reversedAt ? (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            reversed
          </span>
        ) : reversible ? (
          <button onClick={onReverse} disabled={reversing}>
            {reversing ? 'Reversing…' : 'Reverse'}
          </button>
        ) : (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            n/a
          </span>
        )}
      </td>
    </tr>
  );
}

function describeTarget(row: AgentActionRow): string {
  switch (row.targetType) {
    case 'gmailMessage':
      return `msg ${row.targetId.slice(0, 12)}…`;
    case 'gmailLabel':
      return `label ${row.targetId}`;
    case 'rule':
      return `rule ${row.targetId.slice(0, 8)}…`;
    case 'scheduledAction':
      return `scheduled ${row.targetId.slice(0, 8)}…`;
  }
}

function describeToolInput(row: AgentActionRow): string | null {
  if (!row.toolInput || typeof row.toolInput !== 'object') return null;
  const obj = row.toolInput as Record<string, unknown>;
  // For inbox.* tools, show the action type + label name.
  if (typeof obj.type === 'string') {
    const name = typeof obj.labelName === 'string' ? ` "${obj.labelName}"` : '';
    return `${obj.type}${name}`;
  }
  // For schedule.add, show the runAt.
  if (typeof obj.runAt === 'string') {
    return `runs at ${obj.runAt}`;
  }
  return null;
}

// ── AI guidance ───────────────────────────────────────────────────────────

/**
 * Cross-cutting "always check first" patterns the inbox-cleanup proposer
 * uses to override per-class defaults. Edited as a free-form bullet list;
 * the server stores it on User.aiGuidance and falls back to a curated
 * default when null.
 *
 * Examples baked into the default text:
 *   - one-time codes / OTPs → archive 1h after arrival
 *   - past-event calendar invites → archive immediately
 *   - newsletters where the user never clicks → archive immediately
 */
function AiGuidanceSection() {
  const qc = useQueryClient();
  const s = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => apiGet('/api/settings'),
  });
  const [draft, setDraft] = useState<string | null>(null);
  // Track whether the user's current draft equals the factory default
  // — when so, we save `null` to the server (falls back to default,
  // so future tweaks to the curated default flow through).
  useEffect(() => {
    if (s.data && draft == null) {
      setDraft(s.data.aiGuidance ?? s.data.aiGuidanceEffective ?? '');
    }
  }, [s.data, draft]);

  const save = useMutation<SettingsResponse, Error, string | null>({
    mutationFn: (val) =>
      apiSend<SettingsResponse>('PUT', '/api/settings', { aiGuidance: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (s.isLoading) return <section className="settings-section">Loading…</section>;
  if (s.isError)
    return (
      <section className="settings-section banner error">
        Failed to load settings.
      </section>
    );

  const data = s.data!;
  const effective = data.aiGuidanceEffective ?? '';
  const factoryDefault = data.aiGuidanceDefault ?? '';
  const draftText = draft ?? '';
  const dirty = draftText.trim() !== (data.aiGuidance ?? effective).trim();
  const usingDefault =
    !data.aiGuidance || data.aiGuidance.trim() === factoryDefault.trim();
  const canResetToDefault =
    draftText.trim() !== factoryDefault.trim() && factoryDefault.length > 0;

  return (
    <section className="settings-section">
      <h2>AI guidance</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Cross-cutting patterns the inbox-cleanup proposer always checks before
        falling back to per-sender / per-category defaults. Use this for things
        like <em>one-time codes archive after an hour</em> or
        <em> calendar invites stay until the event passes</em> — overrides
        that should apply across many classes of email.
      </p>
      <textarea
        value={draftText}
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
        spellCheck={false}
        style={{
          width: '100%',
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: '0.82rem',
        }}
      />
      <div className="row" style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
        <button
          className="primary"
          onClick={() => {
            // Save `null` when the user reset to the factory default so
            // future curated changes flow through automatically.
            const trimmed = draftText.trim();
            const next =
              trimmed === '' || trimmed === factoryDefault.trim() ? null : trimmed;
            save.mutate(next);
          }}
          disabled={!dirty || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => setDraft(factoryDefault)}
          disabled={!canResetToDefault}
          title="Replace the textarea with the factory default"
        >
          Reset to default
        </button>
        {save.isSuccess && !dirty && (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            Saved.
          </span>
        )}
        {usingDefault && !dirty && (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            Currently using the factory default.
          </span>
        )}
      </div>
      {save.isError && (
        <div className="banner error">{(save.error as Error).message}</div>
      )}

      {/* Auto-learned memory section — read-only, refreshable on demand. */}
      <LearnedMemoryPanel data={data} qc={qc} />
    </section>
  );
}

/**
 * Read-only sub-panel under AI guidance showing the memory consolidator's
 * latest distilled memo. The consolidator runs hourly in the background;
 * this panel surfaces "what it learned" + a button to re-run it now.
 */
function LearnedMemoryPanel({
  data,
  qc,
}: {
  data: SettingsResponse;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [open, setOpen] = useState(false);
  const consolidate = useMutation<ConsolidationResult, Error>({
    mutationFn: () => apiSend<ConsolidationResult>('POST', '/api/settings/consolidate-memory'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const memory = data.learnedMemory ?? '';
  const lastRun = data.learnedMemoryAt
    ? new Date(data.learnedMemoryAt).toLocaleString()
    : null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{ marginTop: '0.7rem' }}
    >
      <summary
        className="muted"
        style={{ fontSize: '0.78rem', cursor: 'pointer' }}
      >
        Learned memory{' '}
        {lastRun ? (
          <span style={{ fontSize: '0.74rem' }}>· last updated {lastRun}</span>
        ) : (
          <span style={{ fontSize: '0.74rem' }}>· not yet generated</span>
        )}
      </summary>
      <div
        className="panel"
        style={{ marginTop: '0.4rem', padding: '0.7rem 0.85rem', fontSize: '0.85rem' }}
      >
        <div className="muted" style={{ fontSize: '0.78rem', marginBottom: '0.5rem' }}>
          Auto-distilled by the memory consolidator from your audit log + rule
          decisions. The proposer reads this alongside your guidance text above
          when drafting new rules. Edit your guidance to override anything that
          looks wrong.
        </div>
        {memory ? (
          <pre
            style={{
              fontFamily: 'ui-monospace, Menlo, monospace',
              fontSize: '0.78rem',
              whiteSpace: 'pre-wrap',
              margin: 0,
            }}
          >
            {memory}
          </pre>
        ) : (
          <div className="muted">
            Nothing learned yet. The consolidator runs hourly once enough audit
            data accumulates. Click below to force a run.
          </div>
        )}
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <button
            onClick={() => consolidate.mutate()}
            disabled={consolidate.isPending}
          >
            {consolidate.isPending ? 'Consolidating…' : 'Refresh now'}
          </button>
          {consolidate.isSuccess && consolidate.data && !consolidate.data.ran && (
            <span className="muted" style={{ fontSize: '0.78rem' }}>
              Skipped: {consolidate.data.reason}
            </span>
          )}
          {consolidate.isSuccess && consolidate.data?.ran && (
            <span className="muted" style={{ fontSize: '0.78rem' }}>
              Found {consolidate.data.patternsCount} pattern
              {consolidate.data.patternsCount === 1 ? '' : 's'}.
            </span>
          )}
        </div>
        {consolidate.isError && (
          <div className="banner error" style={{ marginTop: '0.4rem' }}>
            {(consolidate.error as Error).message}
          </div>
        )}
      </div>
    </details>
  );
}

// Forward-action allowlist. Backed by GET/POST/DELETE /me/forward-allowlist.
// Type matches the API's `ForwardingAddress`-derived shape.
type ForwardTarget = {
  id: string;
  address: string;
  verified: boolean;
  updatedAt: string;
};

/**
 * Forwarding addresses the user has approved for the `forward` action.
 *
 * Without an entry here, `applyAction` refuses to send mail, regardless
 * of what a rule or the classifier proposes — that's the kill switch
 * for inbox-exfiltration via a hostile rule. The user adds an address
 * (which lands as `verified=false`) and confirms in a second click; the
 * confirm is the explicit "yes, this app may forward to X."
 */
function ForwardAllowlistSection() {
  const qc = useQueryClient();
  const list = useQuery<{ items: ForwardTarget[] }>({
    queryKey: ['forward-allowlist'],
    queryFn: () => apiGet('/me/forward-allowlist'),
  });
  const [draft, setDraft] = useState('');

  const add = useMutation<ForwardTarget, ApiError, string>({
    mutationFn: (address) =>
      apiSend('POST', '/me/forward-allowlist', { address }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['forward-allowlist'] });
    },
  });
  const confirm = useMutation<ForwardTarget, Error, string>({
    mutationFn: (id) =>
      apiSend('POST', `/me/forward-allowlist/${id}/confirm`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['forward-allowlist'] }),
  });
  const remove = useMutation<void, Error, string>({
    mutationFn: (id) => apiSend('DELETE', `/me/forward-allowlist/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['forward-allowlist'] }),
  });

  const items = list.data?.items ?? [];

  return (
    <details className="settings-section">
      <summary>Forwarding addresses</summary>
      <div className="settings-section-body">
        <p className="settings-help">
          Rules with a <code>forward</code> action can only send mail to
          addresses confirmed here. New addresses land as <em>pending</em>
          and need a second click to activate.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = draft.trim();
            if (v) add.mutate(v);
          }}
          className="settings-row"
        >
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="assistant@example.com"
            autoComplete="off"
          />
          <button type="submit" disabled={add.isPending || draft.trim().length < 3}>
            Add
          </button>
        </form>
        {add.error && (
          <div className="settings-error">
            {add.error.code === 'invalid_address'
              ? 'That doesn’t look like a valid email address.'
              : add.error.message}
          </div>
        )}
        {items.length === 0 ? (
          <div className="settings-empty">No forwarding addresses yet.</div>
        ) : (
          <ul className="forward-allowlist">
            {items.map((it) => (
              <li key={it.id} className={it.verified ? 'verified' : 'pending'}>
                <span className="addr">{it.address}</span>
                <span className="status">
                  {it.verified ? 'confirmed' : 'pending confirmation'}
                </span>
                <span className="actions">
                  {!it.verified && (
                    <button
                      onClick={() => confirm.mutate(it.id)}
                      disabled={confirm.isPending}
                    >
                      Confirm
                    </button>
                  )}
                  <button
                    onClick={() => remove.mutate(it.id)}
                    disabled={remove.isPending}
                    className="danger"
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * UI surface for the same backup / restore flow that scripts/backup.sh
 * offers on the CLI. Download triggers a plain file download from the
 * server; restore accepts a JSON file and calls POST /api/backups/import.
 *
 * Replace mode is gated behind a typed confirmation ("replace") so an
 * accidental button click can't wipe your rules.
 */
function BackupRestoreSection() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ExportPayload | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirmText, setConfirmText] = useState('');
  const [downloadStamp, setDownloadStamp] = useState<string | null>(null);

  // Read + parse the file on selection so we can show counts before the
  // user commits to importing.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as ExportPayload;
        if (cancelled) return;
        if (!parsed || parsed.version !== 1 || !parsed.data) {
          setPreview(null);
          return;
        }
        setPreview(parsed);
      } catch {
        if (!cancelled) setPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const download = useMutation<void, Error>({
    mutationFn: async () => {
      // Plain fetch so we can stream the blob directly to a download.
      const res = await fetch('/api/backups/export', { credentials: 'include' });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const disposition = res.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename =
        match?.[1] ?? `gmail-ai-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadStamp(new Date().toLocaleString());
    },
  });

  const importMut = useMutation<ImportResult, Error, void>({
    mutationFn: async () => {
      if (!preview) throw new Error('no file loaded');
      return apiSend<ImportResult>('POST', '/api/backups/import', {
        payload: preview,
        mode,
      });
    },
    onSuccess: () => {
      // Any cached list view needs to refetch.
      qc.invalidateQueries({ queryKey: ['rules'] });
      qc.invalidateQueries({ queryKey: ['gmail-filters'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const counts = preview
    ? {
        rules: Array.isArray(preview.data.rules) ? preview.data.rules.length : 0,
        filters: Array.isArray(preview.data.gmailFilters) ? preview.data.gmailFilters.length : 0,
        users: Array.isArray(preview.data.users) ? preview.data.users.length : 0,
      }
    : null;

  // Replace mode demands typing "replace" to confirm.
  const confirmOk = mode === 'merge' || confirmText.trim().toLowerCase() === 'replace';
  const importReady = preview != null && confirmOk && !importMut.isPending;

  function reset() {
    setFile(null);
    setPreview(null);
    setConfirmText('');
    importMut.reset();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <section className="settings-section">
      <h2>Backup &amp; restore</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Export your AI rules, Gmail filter mirrors, and user settings as a single JSON file.
        The file is also produced automatically on disk before every app update — look under{' '}
        <code>~/Library/Application Support/gmail-ai-manager/backups/</code>.
      </p>

      {/* Download */}
      <div className="row wrap" style={{ alignItems: 'center', marginTop: '0.3rem' }}>
        <button
          className="primary"
          onClick={() => download.mutate()}
          disabled={download.isPending}
        >
          {download.isPending ? 'Preparing…' : 'Download backup'}
        </button>
        {download.isError && (
          <span className="banner error" style={{ padding: '0.3rem 0.6rem' }}>
            {(download.error as Error).message}
          </span>
        )}
        {downloadStamp && !download.isError && (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            Last download: {downloadStamp}
          </span>
        )}
      </div>

      {/* Restore */}
      <div
        className="panel"
        style={{ marginTop: '1rem', padding: '0.9rem 1rem', fontSize: '0.9rem' }}
      >
        <div style={{ fontWeight: 500, marginBottom: '0.4rem' }}>Restore from file</div>
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: 0 }}>
          Upload a <code>gmail-ai-manager-backup-*.json</code> file you previously downloaded
          (or one produced by <code>scripts/backup.sh</code>). The file's{' '}
          <code>userId</code> field is ignored — rows are always restored to your
          currently-signed-in account.
        </p>

        <div className="row wrap" style={{ gap: '0.6rem' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <button onClick={reset} disabled={importMut.isPending}>
              Clear
            </button>
          )}
        </div>

        {file && !preview && (
          <div className="banner error" style={{ marginTop: '0.5rem' }}>
            Not a valid Gmail AI Manager backup file (expected <code>version: 1</code>).
          </div>
        )}

        {counts && (
          <>
            <div
              className="muted"
              style={{ fontSize: '0.82rem', marginTop: '0.5rem', marginBottom: '0.4rem' }}
            >
              File contains:{' '}
              <strong>{counts.rules}</strong> rule{counts.rules === 1 ? '' : 's'}
              {' · '}
              <strong>{counts.filters}</strong> Gmail filter
              {counts.filters === 1 ? '' : 's'}
              {counts.users > 0 && (
                <>
                  {' · '}
                  <strong>{counts.users}</strong> user settings
                </>
              )}
              {preview?.exportedAt && (
                <>
                  {' · '}
                  exported {new Date(preview.exportedAt).toLocaleString()}
                </>
              )}
            </div>

            <fieldset className="row wrap" style={{ border: 0, padding: 0, gap: '1rem' }}>
              <label className="row" style={{ gap: '0.3rem', alignItems: 'flex-start' }}>
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === 'merge'}
                  onChange={() => {
                    setMode('merge');
                    setConfirmText('');
                  }}
                />
                <span>
                  <strong>Merge</strong>{' '}
                  <span className="muted" style={{ fontSize: '0.82rem' }}>
                    Upsert rules + filters by id. Existing rows in the file overwrite; rows not in
                    the file are kept.
                  </span>
                </span>
              </label>
              <label className="row" style={{ gap: '0.3rem', alignItems: 'flex-start' }}>
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                />
                <span>
                  <strong>Replace</strong>{' '}
                  <span className="muted" style={{ fontSize: '0.82rem' }}>
                    Delete <em>all</em> your current rules + Gmail filter mirrors first, then
                    insert the file. Destructive — requires typed confirmation.
                  </span>
                </span>
              </label>
            </fieldset>

            {mode === 'replace' && (
              <div style={{ marginTop: '0.5rem' }}>
                <label
                  className="muted"
                  style={{ fontSize: '0.82rem', display: 'block', marginBottom: '0.2rem' }}
                >
                  Type <code>replace</code> to confirm:
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="replace"
                  spellCheck={false}
                  autoComplete="off"
                  style={{ maxWidth: 160 }}
                />
              </div>
            )}

            <div className="row" style={{ marginTop: '0.6rem' }}>
              <button
                className="primary"
                onClick={() => importMut.mutate()}
                disabled={!importReady}
                title={
                  !preview
                    ? 'No file loaded'
                    : !confirmOk
                      ? 'Type replace to confirm'
                      : mode === 'replace'
                        ? 'Replace every rule and Gmail filter in your local DB'
                        : 'Merge rules and filters from the file into your local DB'
                }
              >
                {importMut.isPending
                  ? 'Restoring…'
                  : mode === 'replace'
                    ? 'Replace & import'
                    : 'Merge import'}
              </button>
            </div>
          </>
        )}

        {importMut.isError && (
          <div className="banner error" style={{ marginTop: '0.5rem' }}>
            Import failed:{' '}
            {importMut.error instanceof ApiError
              ? importMut.error.code
              : (importMut.error as Error).message}
          </div>
        )}
        {importMut.isSuccess && importMut.data && (
          <div className="banner info" style={{ marginTop: '0.5rem' }}>
            {importMut.data.mode === 'replace' ? 'Replaced' : 'Merged'}:{' '}
            <strong>{importMut.data.rulesImported}</strong> rule
            {importMut.data.rulesImported === 1 ? '' : 's'}
            {' · '}
            <strong>{importMut.data.gmailFiltersImported}</strong> Gmail filter
            {importMut.data.gmailFiltersImported === 1 ? '' : 's'}. Other pages will refresh on
            next visit.
          </div>
        )}
      </div>
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

