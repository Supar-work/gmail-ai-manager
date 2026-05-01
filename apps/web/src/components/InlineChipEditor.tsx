import { useEffect, useRef, useState } from 'react';
import type { RuleToken, RuleTokenChip } from '@gam/shared';

/**
 * Renders a rule sentence as a flex-wrap row of inline tokens — text
 * spans (editable) and chips (clickable, with optional preset values
 * suggested by the AI).
 *
 * Editing model: text token edits update local state on blur; chip
 * edits commit immediately (popover with options + free-text fallback).
 * Concatenating every token's value reproduces the rule sentence,
 * which is what gets POSTed to /preview-matches when the user clicks
 * Evaluate.
 *
 * After Evaluate the parent feeds in a fresh token list (Claude may
 * promote free text into new chips, merge old ones, etc.). The editor
 * is fully replaced via the `version` prop so contenteditable spans
 * remount with fresh DOM contents.
 */

export type InlineChipEditorProps = {
  tokens: RuleToken[];
  /** Bumped by the parent whenever a Claude round-trip returns new
   *  tokens. The editor remounts internal state on change. */
  version: number;
  onTokensChange: (next: RuleToken[]) => void;
  /** True while a Claude evaluate is in flight. */
  evaluating: boolean;
};

export function InlineChipEditor({
  tokens,
  version,
  onTokensChange,
  evaluating,
}: InlineChipEditorProps) {
  return (
    <div
      className={`inline-rule-editor ${evaluating ? 'is-evaluating' : ''}`}
      key={`v${version}`}
    >
      {tokens.length === 0 && (
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          (empty rule)
        </span>
      )}
      {tokens.map((tok, i) =>
        tok.kind === 'text' ? (
          <TextToken
            key={`t${i}`}
            value={tok.value}
            onCommit={(v) => {
              const next = tokens.slice();
              next[i] = { kind: 'text', value: v };
              onTokensChange(next);
            }}
          />
        ) : (
          <ChipToken
            key={`c${i}`}
            chip={tok}
            onChange={(c) => {
              const next = tokens.slice();
              next[i] = c;
              onTokensChange(next);
            }}
            onRemove={() => {
              // Remove the chip but keep a space so the surrounding
              // text doesn't collapse against neighbouring tokens.
              const next: RuleToken[] = tokens
                .slice(0, i)
                .concat([{ kind: 'text', value: ' ' }])
                .concat(tokens.slice(i + 1));
              onTokensChange(mergeAdjacentText(next));
            }}
          />
        ),
      )}
    </div>
  );
}

// ── Text token (contenteditable single-line) ─────────────────────────

function TextToken({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // Render NBSPs for leading/trailing spaces so they're visible in the
  // contenteditable; convert back when committing.
  const display = value.length === 0 ? ' ' : value;
  return (
    <span
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      className="inline-rule-text"
      onBlur={(e) => {
        const txt = (e.currentTarget.textContent ?? '').replace(/ /g, ' ');
        if (txt !== value) onCommit(txt);
      }}
      onKeyDown={(e) => {
        // Enter inside a text run: blur to commit + flow on to siblings.
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
      }}
    >
      {display}
    </span>
  );
}

// ── Chip token (clickable, popover editor) ───────────────────────────

function ChipToken({
  chip,
  onChange,
  onRemove,
}: {
  chip: RuleTokenChip;
  onChange: (c: RuleTokenChip) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(chip.value);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => setDraft(chip.value), [chip.value]);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const cls = `inline-rule-chip inline-rule-chip--${classifySemantic(chip.semantic)}`;
  return (
    <span ref={wrapRef} className="inline-rule-chip-wrap">
      <button
        type="button"
        className={cls}
        title={chip.semantic}
        onClick={() => setOpen((v) => !v)}
      >
        {chip.label && <span className="inline-rule-chip-label">{chip.label}</span>}
        <span className="inline-rule-chip-value">{chip.value}</span>
        <span className="inline-rule-chip-caret">▾</span>
      </button>
      {open && (
        <div className="inline-rule-chip-pop">
          <div className="inline-rule-chip-pop-head muted">{chip.semantic}</div>
          <input
            className="inline-rule-chip-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (draft.trim()) {
                  onChange({ ...chip, value: draft.trim() });
                  setOpen(false);
                }
              } else if (e.key === 'Escape') {
                setDraft(chip.value);
                setOpen(false);
              }
            }}
            autoFocus
          />
          {chip.options && chip.options.length > 0 && (
            <div className="inline-rule-chip-opts">
              {chip.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`inline-rule-chip-opt ${opt === chip.value ? 'on' : ''}`}
                  onClick={() => {
                    onChange({ ...chip, value: opt });
                    setOpen(false);
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          <div className="inline-rule-chip-foot">
            <button
              type="button"
              className="inline-rule-chip-rm"
              onClick={() => {
                onRemove();
                setOpen(false);
              }}
            >
              Remove chip
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (draft.trim()) {
                  onChange({ ...chip, value: draft.trim() });
                  setOpen(false);
                }
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function classifySemantic(
  s: string,
): 'sender' | 'condition' | 'action' | 'timing' | 'flag' | 'note' {
  const k = s.toLowerCase();
  if (k === 'sender' || k === 'recipient' || k === 'from' || k === 'to') return 'sender';
  if (k === 'action' || k === 'label' || k === 'verb') return 'action';
  if (k === 'timing' || k === 'when' || k === 'schedule') return 'timing';
  if (k === 'flag' || k === 'is' || k === 'attribute') return 'flag';
  if (k === 'subject' || k === 'list' || k === 'time' || k === 'condition' || k === 'attachment')
    return 'condition';
  return 'note';
}

/** Concat adjacent text tokens; preserves spaces between chips. */
export function mergeAdjacentText(tokens: RuleToken[]): RuleToken[] {
  const out: RuleToken[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (t.kind === 'text' && last && last.kind === 'text') {
      out[out.length - 1] = { kind: 'text', value: last.value + t.value };
    } else {
      out.push(t);
    }
  }
  return out;
}

/** Concatenate tokens left-to-right. text values verbatim, chip
 *  values inserted as their `value`. Used to build the NL string that
 *  gets sent to /preview-matches when the user clicks Evaluate. */
export function tokensToNaturalLanguage(tokens: RuleToken[]): string {
  return tokens
    .map((t) => (t.kind === 'text' ? t.value : t.value))
    .join('')
    .trim();
}
