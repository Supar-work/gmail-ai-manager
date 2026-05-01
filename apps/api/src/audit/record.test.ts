import { describe, it, expect } from 'vitest';
import { inverseAction } from './record.js';
import type { Action } from '@gam/shared';

describe('inverseAction', () => {
  it('addLabel ↔ removeLabel', () => {
    const a: Action = { type: 'addLabel', labelName: 'Receipts' };
    expect(inverseAction(a)).toEqual({ type: 'removeLabel', labelName: 'Receipts' });
  });

  it('removeLabel ↔ addLabel', () => {
    const a: Action = { type: 'removeLabel', labelName: 'Newsletter' };
    expect(inverseAction(a)).toEqual({ type: 'addLabel', labelName: 'Newsletter' });
  });

  it('archive → addLabel(INBOX) (un-archive)', () => {
    const a: Action = { type: 'archive' };
    expect(inverseAction(a)).toEqual({ type: 'addLabel', labelName: 'INBOX' });
  });

  it('markRead → addLabel(UNREAD) (re-mark unread)', () => {
    const a: Action = { type: 'markRead' };
    expect(inverseAction(a)).toEqual({ type: 'addLabel', labelName: 'UNREAD' });
  });

  it('star → removeLabel(STARRED)', () => {
    const a: Action = { type: 'star' };
    expect(inverseAction(a)).toEqual({ type: 'removeLabel', labelName: 'STARRED' });
  });

  it('markImportant → removeLabel(IMPORTANT)', () => {
    const a: Action = { type: 'markImportant' };
    expect(inverseAction(a)).toEqual({ type: 'removeLabel', labelName: 'IMPORTANT' });
  });

  it('forward → null (already sent, no clean undo)', () => {
    const a: Action = { type: 'forward', to: 'someone@example.com' };
    expect(inverseAction(a)).toBeNull();
  });

  it('trash → null (banned action; never emitted in practice)', () => {
    const a: Action = { type: 'trash' };
    expect(inverseAction(a)).toBeNull();
  });
});
