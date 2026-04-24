import { useEffect, useRef, useState } from 'react';
import type { Action, RunAt } from '@gam/shared';

/**
 * A chip that can be clicked to edit its underlying Action in place.
 *
 *   • addLabel / removeLabel — opens a dropdown for the top-level
 *     canonical category plus a free-text input for the sub-level, so
 *     the user can reclassify without leaving the rule card.
 *   • archive               — opens a compact dropdown of common
 *     timings (immediately / end of day / next business day /
 *     in N days) that map to the RunAt variants.
 *
 * Other action types (markRead, star, markImportant, forward, trash)
 * render as a plain chip — we don't yet offer an inline editor for
 * them because they don't have a "class" parameter the user typically
 * wants to tweak post-proposal.
 */

export const TOP_LEVELS: Array<{ name: string; disposition: 'inbox' | 'archive' }> = [
  { name: 'Family', disposition: 'inbox' },
  { name: 'Friends', disposition: 'inbox' },
  { name: 'Work', disposition: 'inbox' },
  { name: 'Action', disposition: 'inbox' },
  { name: 'Notifications', disposition: 'archive' },
  { name: 'Marketing', disposition: 'archive' },
  { name: 'Subscriptions', disposition: 'archive' },
  { name: 'Receipts', disposition: 'archive' },
  { name: 'Shopping', disposition: 'archive' },
  { name: 'Finance', disposition: 'archive' },
  { name: 'Travel', disposition: 'archive' },
];

const CUSTOM_SENTINEL = '__custom__';

function splitPath(path: string): { top: string; sub: string } {
  if (!path) return { top: '', sub: '' };
  const idx = path.indexOf('/');
  if (idx < 0) return { top: path, sub: '' };
  return { top: path.slice(0, idx), sub: path.slice(idx + 1) };
}
function joinPath(top: string, sub: string): string {
  const t = top.trim();
  const s = sub.trim();
  if (!t) return '';
  return s ? `${t}/${s}` : t;
}

// ── timing options (archive / any time-shifted action) ────────────────

type TimingKey =
  | 'immediate'
  | 'endOfDay'
  | 'endOfNextBusinessDay'
  | 'in1Day'
  | 'in3Days'
  | 'in1Week';

const TIMING_OPTIONS: Array<{ key: TimingKey; label: string; runAt: RunAt | undefined }> = [
  { key: 'immediate', label: 'immediately', runAt: { kind: 'immediate' } },
  { key: 'endOfDay', label: 'at end of day', runAt: { kind: 'endOfDay' } },
  {
    key: 'endOfNextBusinessDay',
    label: 'next business day EOD',
    runAt: { kind: 'endOfNextBusinessDay' },
  },
  { key: 'in1Day', label: 'in 1 day', runAt: { kind: 'relative', days: 1 } },
  { key: 'in3Days', label: 'in 3 days', runAt: { kind: 'relative', days: 3 } },
  { key: 'in1Week', label: 'in 1 week', runAt: { kind: 'relative', days: 7 } },
];

function matchTiming(runAt: RunAt | undefined): TimingKey {
  if (!runAt || runAt.kind === 'immediate') return 'immediate';
  if (runAt.kind === 'endOfDay') return 'endOfDay';
  if (runAt.kind === 'endOfNextBusinessDay') return 'endOfNextBusinessDay';
  if (runAt.kind === 'relative') {
    if (runAt.days === 1) return 'in1Day';
    if (runAt.days === 3) return 'in3Days';
    if (runAt.days === 7) return 'in1Week';
  }
  return 'immediate';
}

function describeRunAt(runAt: RunAt | undefined): string | null {
  if (!runAt || runAt.kind === 'immediate') return null;
  if (runAt.kind === 'endOfDay') return 'at end of day';
  if (runAt.kind === 'endOfNextBusinessDay') return 'next business day EOD';
  if (runAt.kind === 'relative') {
    if (runAt.minutes != null) return `in ${runAt.minutes}m`;
    if (runAt.hours != null) return `in ${runAt.hours}h`;
    if (runAt.days != null) return `in ${runAt.days}d`;
    return 'deferred';
  }
  if (runAt.kind === 'atTime') return `at ${runAt.iso}`;
  if (runAt.kind === 'contentDerived') return `when ${runAt.hint}`;
  return null;
}

// ── main component ─────────────────────────────────────────────────────

export type EditableActionChipProps = {
  action: Action;
  onChange: (next: Action) => void;
  /** Optional: caller is notified of the labelName changes so it can
   *  sync the rule's natural-language text. */
  onLabelRename?: (oldLabelName: string, newLabelName: string) => void;
};

export function EditableActionChip({ action, onChange, onLabelRename }: EditableActionChipProps) {
  const [editing, setEditing] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Close when the user clicks outside the chip+editor.
  useEffect(() => {
    if (!editing) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setEditing(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [editing]);

  // For label actions: nothing special to edit if the labelName is a
  // synthetic snooze/<iso> or system label — render plain chip.
  const isLabelAction = action.type === 'addLabel' || action.type === 'removeLabel';
  const isSyntheticLabel =
    isLabelAction &&
    ((action as { labelName: string }).labelName === 'INBOX' ||
      (action as { labelName: string }).labelName.startsWith('snooze/'));

  const supportsEditor =
    (isLabelAction && !isSyntheticLabel) || action.type === 'archive';

  const chipClass = describeChipClass(action);
  const chipLabel = describeChipLabel(action);

  if (!supportsEditor) {
    return <span className={`chip ${chipClass}`}>{chipLabel}</span>;
  }

  return (
    <span className="action-chip-root" ref={rootRef}>
      <button
        type="button"
        className={`chip chip-editable ${chipClass}`}
        onClick={() => setEditing((v) => !v)}
        title="Click to edit"
      >
        {chipLabel}
        <span className="chip-caret" aria-hidden>
          {editing ? '▴' : '▾'}
        </span>
      </button>
      {editing && (
        <div className="chip-editor" role="dialog">
          {isLabelAction ? (
            <LabelEditor
              action={action as Extract<Action, { type: 'addLabel' | 'removeLabel' }>}
              onApply={(newAction) => {
                if (onLabelRename) {
                  onLabelRename(
                    (action as { labelName: string }).labelName,
                    newAction.labelName,
                  );
                }
                onChange(newAction);
                setEditing(false);
              }}
            />
          ) : (
            <ArchiveEditor
              action={action as Extract<Action, { type: 'archive' }>}
              onApply={(newAction) => {
                onChange(newAction);
                setEditing(false);
              }}
            />
          )}
        </div>
      )}
    </span>
  );
}

// ── sub-editors ────────────────────────────────────────────────────────

function LabelEditor({
  action,
  onApply,
}: {
  action: Extract<Action, { type: 'addLabel' | 'removeLabel' }>;
  onApply: (next: Extract<Action, { type: 'addLabel' | 'removeLabel' }>) => void;
}) {
  const initial = splitPath(action.labelName);
  const [top, setTop] = useState(initial.top);
  const [sub, setSub] = useState(initial.sub);
  const [custom, setCustom] = useState(
    initial.top !== '' && !TOP_LEVELS.some((t) => t.name === initial.top),
  );

  const selectValue = custom ? CUSTOM_SENTINEL : top;
  const newPath = joinPath(top, sub);
  const disposition =
    TOP_LEVELS.find((t) => t.name === top)?.disposition ??
    (action.type === 'removeLabel' ? 'archive' : 'inbox');

  return (
    <div className="chip-editor-body">
      <div className="muted" style={{ fontSize: '0.7rem', marginBottom: '0.25rem' }}>
        {action.type === 'addLabel' ? 'ADD LABEL' : 'REMOVE LABEL'}
      </div>
      <div className="row" style={{ gap: '0.3rem', alignItems: 'center' }}>
        <select
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === CUSTOM_SENTINEL) {
              setCustom(true);
            } else {
              setCustom(false);
              setTop(v);
            }
          }}
          className="label-rec-top"
        >
          <option value="">—</option>
          {TOP_LEVELS.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
          <option value={CUSTOM_SENTINEL}>Custom…</option>
        </select>
        {custom && (
          <input
            className="label-rec-custom-top"
            value={top}
            onChange={(e) => setTop(e.target.value)}
            placeholder="Custom top-level"
            spellCheck={false}
          />
        )}
        <span className="muted">/</span>
        <input
          className="label-rec-sub"
          value={sub}
          onChange={(e) => setSub(e.target.value)}
          placeholder="(sub)"
          spellCheck={false}
        />
        <span className={`chip ${disposition === 'archive' ? 'warn' : 'accent'}`}>
          {disposition}
        </span>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.4rem' }}>
        <button
          type="button"
          className="primary"
          onClick={() =>
            newPath
              ? onApply({ ...action, labelName: newPath })
              : undefined
          }
          disabled={!newPath}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function ArchiveEditor({
  action,
  onApply,
}: {
  action: Extract<Action, { type: 'archive' }>;
  onApply: (next: Extract<Action, { type: 'archive' }>) => void;
}) {
  const [key, setKey] = useState<TimingKey>(matchTiming(action.runAt));

  return (
    <div className="chip-editor-body">
      <div className="muted" style={{ fontSize: '0.7rem', marginBottom: '0.25rem' }}>
        ARCHIVE TIMING
      </div>
      <div className="stack" style={{ gap: '0.2rem' }}>
        {TIMING_OPTIONS.map((opt) => (
          <label
            key={opt.key}
            className="row"
            style={{ gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}
          >
            <input
              type="radio"
              name="archive-timing"
              checked={key === opt.key}
              onChange={() => setKey(opt.key)}
            />
            {opt.label}
          </label>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.4rem' }}>
        <button
          type="button"
          className="primary"
          onClick={() => {
            const runAt = TIMING_OPTIONS.find((o) => o.key === key)?.runAt;
            onApply({ ...action, runAt });
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

// ── chip-face helpers ──────────────────────────────────────────────────

function describeChipLabel(a: Action): string {
  const base = (() => {
    switch (a.type) {
      case 'addLabel':
        return `+ label "${a.labelName}"`;
      case 'removeLabel':
        return `− label "${a.labelName}"`;
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
      case 'forward':
        return `forward → ${a.to}`;
    }
  })();
  const timing = describeRunAt(a.runAt);
  return timing ? `${base} — ${timing}` : base;
}

function describeChipClass(a: Action): string {
  if (a.type === 'archive' || a.type === 'removeLabel') return 'warn';
  if (a.type === 'trash') return 'danger';
  return 'accent';
}
