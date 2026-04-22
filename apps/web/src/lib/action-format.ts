import type { Action } from '@gaf/shared';

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'addLabel':
      return `add label "${a.labelName}"`;
    case 'removeLabel':
      return `remove label "${a.labelName}"`;
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
}

export function describeRunAt(a: Action): string | null {
  if (!a.runAt) return null;
  switch (a.runAt.kind) {
    case 'immediate':
      return 'now';
    case 'endOfDay':
      return 'at end of day';
    case 'endOfNextBusinessDay':
      return 'next business day EOD';
    case 'relative': {
      const u = a.runAt.minutes != null ? `${a.runAt.minutes}m` : a.runAt.hours != null ? `${a.runAt.hours}h` : `${a.runAt.days}d`;
      return `in ${u}`;
    }
    case 'atTime':
      return `at ${a.runAt.iso}`;
    case 'contentDerived':
      return `when ${a.runAt.hint ?? 'content-derived'}`;
  }
}
