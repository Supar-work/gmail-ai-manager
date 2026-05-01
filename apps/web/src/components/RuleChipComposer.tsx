import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action } from '@gam/shared';
import { EditableActionChip } from './EditableActionChip.js';

/**
 * Tokenised rule composer. The rule is a list of WHEN-chips (Gmail q:
 * conditions like `from`, `subject`, `list`) and THEN-chips (Action
 * chips, which already cover label/archive/markRead/etc plus timing
 * via EditableActionChip's RunAt picker). Free-form textarea is
 * available behind an "Edit as text" toggle for power users.
 *
 * The composer owns the rule's structure end-to-end:
 *   - parse incoming `gmailQuery` into Condition chips on first render
 *   - serialise chips → gmailQuery on every change
 *   - synthesise a clean naturalLanguage sentence client-side
 *   - call onChange({ naturalLanguage, gmailQuery, actions }) whenever
 *     anything changes; the wizard hits /preview-structured to refresh
 *     impacts + samples without paying the Claude round-trip.
 */

// ── Conditions ───────────────────────────────────────────────────────

export type Condition =
  | { kind: 'from'; value: string }
  | { kind: 'to'; value: string }
  | { kind: 'subject'; value: string }
  | { kind: 'list'; value: string }
  | { kind: 'has'; value: string }
  | { kind: 'is'; value: 'read' | 'unread' | 'starred' | 'important' }
  | { kind: 'newer_than'; value: string }
  | { kind: 'older_than'; value: string }
  /** Anything we couldn't parse — rendered as a free-text chip the user
   *  can still tweak by typing into the popover. */
  | { kind: 'raw'; value: string };

const KNOWN_OPERATORS = new Set([
  'from',
  'to',
  'subject',
  'list',
  'has',
  'is',
  'newer_than',
  'older_than',
]);

/** Tokeniser tolerant of quoted values, unbalanced parens, and stray
 *  AND/OR connectives. */
export function parseGmailQuery(q: string): Condition[] {
  const out: Condition[] = [];
  if (!q.trim()) return out;
  let i = 0;
  const n = q.length;
  while (i < n) {
    while (i < n && /\s/.test(q[i]!)) i++;
    if (i >= n) break;
    // Read a token. Tokens are either operator:value or a bare word.
    const colon = q.indexOf(':', i);
    const nextSpace = nextUnquotedSpace(q, i);
    const tokEnd = nextSpace < 0 ? n : nextSpace;
    if (colon > i && colon < tokEnd) {
      const op = q.slice(i, colon).toLowerCase().replace(/^[(-]+/, '');
      let valStart = colon + 1;
      let valEnd = tokEnd;
      // Quoted value
      if (q[valStart] === '"') {
        const closing = q.indexOf('"', valStart + 1);
        if (closing > valStart) {
          valStart += 1;
          valEnd = closing;
          // Advance tokEnd past close quote to next space
          const after = nextUnquotedSpace(q, closing + 1);
          i = after < 0 ? n : after + 1;
          out.push(toCondition(op, q.slice(valStart, valEnd)));
          continue;
        }
      }
      const raw = q.slice(valStart, valEnd).replace(/\)+$/, '');
      out.push(toCondition(op, raw));
      i = tokEnd + 1;
    } else {
      // Bare word — skip AND/OR, otherwise treat as raw chip.
      const word = q.slice(i, tokEnd);
      const upper = word.toUpperCase();
      if (upper !== 'AND' && upper !== 'OR' && word) {
        out.push({ kind: 'raw', value: word });
      }
      i = tokEnd + 1;
    }
  }
  return out;
}

function nextUnquotedSpace(s: string, from: number): number {
  let inQuote = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') inQuote = !inQuote;
    if (!inQuote && /\s/.test(c)) return i;
  }
  return -1;
}

function toCondition(op: string, value: string): Condition {
  const v = value.trim();
  switch (op) {
    case 'from':
      return { kind: 'from', value: v };
    case 'to':
      return { kind: 'to', value: v };
    case 'subject':
      return { kind: 'subject', value: v };
    case 'list':
      return { kind: 'list', value: v };
    case 'has':
      return { kind: 'has', value: v };
    case 'is':
      if (v === 'read' || v === 'unread' || v === 'starred' || v === 'important') {
        return { kind: 'is', value: v };
      }
      return { kind: 'raw', value: `is:${v}` };
    case 'newer_than':
      return { kind: 'newer_than', value: v };
    case 'older_than':
      return { kind: 'older_than', value: v };
    default:
      return { kind: 'raw', value: KNOWN_OPERATORS.has(op) ? v : `${op}:${v}` };
  }
}

export function serializeConditions(conds: Condition[]): string {
  const parts: string[] = [];
  for (const c of conds) {
    const v = c.value.trim();
    if (!v) continue;
    if (c.kind === 'raw') {
      parts.push(v);
      continue;
    }
    const needsQuotes = /\s|"/.test(v);
    const safe = needsQuotes ? `"${v.replace(/"/g, '\\"')}"` : v;
    parts.push(`${c.kind}:${safe}`);
  }
  return parts.join(' ');
}

// ── NL synthesis ─────────────────────────────────────────────────────

function describeAction(a: Action): string {
  const timing = describeTiming(a);
  switch (a.type) {
    case 'addLabel':
      return `label as ${a.labelName}${timing}`;
    case 'removeLabel':
      return `remove label ${a.labelName}${timing}`;
    case 'archive':
      return `archive${timing}`;
    case 'markRead':
      return `mark read${timing}`;
    case 'star':
      return `star${timing}`;
    case 'markImportant':
      return `mark important${timing}`;
    case 'forward':
      return `forward to ${a.to}${timing}`;
    case 'trash':
      return `trash${timing}`;
  }
}

function describeTiming(a: Action): string {
  if (!('runAt' in a) || !a.runAt || a.runAt.kind === 'immediate') return '';
  const r = a.runAt;
  switch (r.kind) {
    case 'endOfDay':
      return ' at end of day';
    case 'endOfNextBusinessDay':
      return ' at end of next business day';
    case 'relative': {
      const bits: string[] = [];
      if (r.days) bits.push(`${r.days}d`);
      if (r.hours) bits.push(`${r.hours}h`);
      if (r.minutes) bits.push(`${r.minutes}m`);
      return bits.length ? ` after ${bits.join(' ')}` : '';
    }
    case 'atTime':
      return ` at ${r.iso}`;
    case 'contentDerived':
      return ` (timing from email content)`;
  }
}

function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'from':
      return `from ${c.value}`;
    case 'to':
      return `to ${c.value}`;
    case 'subject':
      return `subject contains "${c.value}"`;
    case 'list':
      return `mailing list ${c.value}`;
    case 'has':
      return `has ${c.value}`;
    case 'is':
      return `is ${c.value}`;
    case 'newer_than':
      return `newer than ${c.value}`;
    case 'older_than':
      return `older than ${c.value}`;
    case 'raw':
      return c.value;
  }
}

export function synthesizeNL(conds: Condition[], actions: Action[]): string {
  const when = conds.map(describeCondition).filter(Boolean);
  const then = actions.map(describeAction);
  if (when.length === 0 && then.length === 0) return '';
  if (when.length === 0) return `${capitalise(then.join(' and '))}.`;
  return `When email is ${when.join(' and ')}, ${then.join(' and ')}.`;
}

function capitalise(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// ── Composer UI ──────────────────────────────────────────────────────

const CONDITION_KINDS: Array<{ kind: Condition['kind']; label: string }> = [
  { kind: 'from', label: 'From' },
  { kind: 'to', label: 'To' },
  { kind: 'subject', label: 'Subject contains' },
  { kind: 'list', label: 'Mailing list' },
  { kind: 'has', label: 'Has' },
  { kind: 'is', label: 'Is' },
  { kind: 'newer_than', label: 'Newer than' },
  { kind: 'older_than', label: 'Older than' },
];

export type RuleDraft = {
  naturalLanguage: string;
  gmailQuery: string;
  actions: Action[];
};

export function RuleChipComposer({
  initialQuery,
  initialActions,
  senderSuggestions,
  onChange,
  onActionsChange,
  onLabelRename,
  updating,
}: {
  initialQuery: string;
  initialActions: Action[];
  /** Known sender addresses to offer in the From-chip dropdown. */
  senderSuggestions: string[];
  /** Fires whenever any chip changes. The wizard pushes this to the
   *  /preview-structured endpoint to refresh impacts + samples. */
  onChange: (draft: RuleDraft) => void;
  /** Fires when an action chip is edited inline (label rename, timing
   *  change, etc.). Kept separate so the parent can apply chip-level
   *  patches that bypass the full re-serialisation path if it wants. */
  onActionsChange: (next: Action[]) => void;
  onLabelRename: (oldLabel: string, newLabel: string) => void;
  updating: boolean;
}) {
  const [conds, setConds] = useState<Condition[]>(() => parseGmailQuery(initialQuery));
  const [actions, setActions] = useState<Action[]>(initialActions);

  // Re-sync if the parent feeds a fresh proposal in (e.g. user navigated
  // to a new email).
  const lastQueryRef = useRef(initialQuery);
  const lastActionsRef = useRef(initialActions);
  useEffect(() => {
    if (initialQuery !== lastQueryRef.current) {
      setConds(parseGmailQuery(initialQuery));
      lastQueryRef.current = initialQuery;
    }
  }, [initialQuery]);
  useEffect(() => {
    if (initialActions !== lastActionsRef.current) {
      setActions(initialActions);
      lastActionsRef.current = initialActions;
    }
  }, [initialActions]);

  // Push a draft up whenever chips change. A short debounce keeps
  // typing-into-a-chip from spamming the backend; the parent then
  // re-fetches /preview-structured.
  const lastEmittedRef = useRef<string>('');
  useEffect(() => {
    const timer = setTimeout(() => {
      const gmailQuery = serializeConditions(conds);
      const naturalLanguage = synthesizeNL(conds, actions) || '(empty rule)';
      const key = `${gmailQuery}::${JSON.stringify(actions)}`;
      if (key === lastEmittedRef.current) return;
      lastEmittedRef.current = key;
      onChange({ naturalLanguage, gmailQuery, actions });
    }, 250);
    return () => clearTimeout(timer);
  }, [conds, actions, onChange]);

  return (
    <div className="chip-composer">
      <div className="chip-composer-row">
        <span className="chip-composer-label">When</span>
        <div className="chip-composer-chips">
          {conds.length === 0 && (
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              No conditions yet — add one →
            </span>
          )}
          {conds.map((c, i) => (
            <ConditionChip
              key={`${c.kind}-${i}`}
              condition={c}
              senderSuggestions={c.kind === 'from' || c.kind === 'to' ? senderSuggestions : []}
              onChange={(next) => {
                const copy = conds.slice();
                copy[i] = next;
                setConds(copy);
              }}
              onRemove={() => setConds((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
          <AddConditionPicker
            onAdd={(kind) =>
              setConds((prev) => [...prev, defaultConditionFor(kind)])
            }
          />
        </div>
      </div>

      <div className="chip-composer-row">
        <span className="chip-composer-label">Then</span>
        <div className="chip-composer-chips">
          {actions.map((a, i) => (
            <span key={`${i}-${chipKey(a)}`} className="chip-composer-action">
              <EditableActionChip
                action={a}
                onChange={(next) => {
                  const copy = actions.slice();
                  copy[i] = next;
                  setActions(copy);
                  onActionsChange(copy);
                }}
                onLabelRename={onLabelRename}
              />
              <button
                className="chip-remove"
                title="Remove this action"
                onClick={() => {
                  const copy = actions.filter((_, j) => j !== i);
                  setActions(copy);
                  onActionsChange(copy);
                }}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
          <AddActionPicker
            onAdd={(action) => {
              const copy = [...actions, action];
              setActions(copy);
              onActionsChange(copy);
            }}
          />
          {updating && (
            <span className="muted" style={{ fontSize: '0.78rem' }}>
              · updating…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function defaultConditionFor(kind: Condition['kind']): Condition {
  switch (kind) {
    case 'is':
      return { kind, value: 'unread' };
    case 'has':
      return { kind, value: 'attachment' };
    case 'newer_than':
    case 'older_than':
      return { kind, value: '7d' };
    default:
      return { kind, value: '' } as Condition;
  }
}

function chipKey(a: Action): string {
  if (a.type === 'addLabel' || a.type === 'removeLabel') return `${a.type}:${a.labelName}`;
  if (a.type === 'forward') return `${a.type}:${a.to}`;
  return a.type;
}

// ── ConditionChip ────────────────────────────────────────────────────

function ConditionChip({
  condition,
  senderSuggestions,
  onChange,
  onRemove,
}: {
  condition: Condition;
  senderSuggestions: string[];
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(condition.value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(condition.value);
  }, [condition.value]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    onChange({ ...condition, value: draft.trim() } as Condition);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(condition.value);
    setEditing(false);
  };

  if (condition.kind === 'is') {
    return (
      <span className="chip cond">
        <span className="chip-key">is</span>
        <select
          className="chip-select"
          value={condition.value}
          onChange={(e) =>
            onChange({ kind: 'is', value: e.target.value as Condition['value'] } as Condition)
          }
        >
          <option value="read">read</option>
          <option value="unread">unread</option>
          <option value="starred">starred</option>
          <option value="important">important</option>
        </select>
        <RemoveButton onClick={onRemove} />
      </span>
    );
  }

  return (
    <span className="chip cond" onClick={() => !editing && setEditing(true)}>
      <span className="chip-key">{labelFor(condition.kind)}:</span>
      {editing ? (
        <>
          <input
            ref={inputRef}
            className="chip-input"
            list={
              senderSuggestions.length > 0 ? `senders-${condition.kind}` : undefined
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                cancel();
              }
            }}
            onBlur={commit}
          />
          {senderSuggestions.length > 0 && (
            <datalist id={`senders-${condition.kind}`}>
              {senderSuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </>
      ) : (
        <span className="chip-value">{condition.value || <em className="muted">empty</em>}</span>
      )}
      <RemoveButton
        onClick={(e) => {
          e?.stopPropagation();
          onRemove();
        }}
      />
    </span>
  );
}

function labelFor(kind: Condition['kind']): string {
  switch (kind) {
    case 'newer_than':
      return 'newer than';
    case 'older_than':
      return 'older than';
    default:
      return kind;
  }
}

function RemoveButton({ onClick }: { onClick: (e?: React.MouseEvent) => void }) {
  return (
    <button
      className="chip-remove"
      type="button"
      title="Remove"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      ×
    </button>
  );
}

// ── Add pickers ──────────────────────────────────────────────────────

function AddConditionPicker({ onAdd }: { onAdd: (kind: Condition['kind']) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));
  return (
    <div className="chip-add-wrap" ref={ref}>
      <button
        className="chip-add"
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Add a condition"
      >
        + condition
      </button>
      {open && (
        <div className="chip-menu">
          {CONDITION_KINDS.map((c) => (
            <button
              key={c.kind}
              className="chip-menu-item"
              type="button"
              onClick={() => {
                onAdd(c.kind);
                setOpen(false);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ACTION_PRESETS: Array<{ label: string; build: () => Action }> = [
  { label: '+ label', build: () => ({ type: 'addLabel', labelName: 'Notifications/New' }) },
  { label: '− label', build: () => ({ type: 'removeLabel', labelName: 'INBOX' }) },
  { label: 'archive', build: () => ({ type: 'archive' }) },
  { label: 'mark read', build: () => ({ type: 'markRead' }) },
  { label: 'star', build: () => ({ type: 'star' }) },
  { label: 'mark important', build: () => ({ type: 'markImportant' }) },
];

function AddActionPicker({ onAdd }: { onAdd: (a: Action) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));
  return (
    <div className="chip-add-wrap" ref={ref}>
      <button
        className="chip-add"
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Add an action"
      >
        + action
      </button>
      {open && (
        <div className="chip-menu">
          {ACTION_PRESETS.map((p) => (
            <button
              key={p.label}
              className="chip-menu-item"
              type="button"
              onClick={() => {
                onAdd(p.build());
                setOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useClickOutside(ref: React.RefObject<HTMLElement>, fn: () => void): void {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fn();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, fn]);
}

// kept here so the wizard can hide its own NL textarea when chips drive
// the rule. The wizard reuses the synthesised NL on save, which is
// what the runtime classifier prompt eventually gets fed.
export const __nlSynth = synthesizeNL;
