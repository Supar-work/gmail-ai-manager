import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Action } from '@gam/shared';

// Hoist mock state so vi.mock factories (which run before imports) can see it.
const m = vi.hoisted(() => ({
  modify: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  isAllowed: vi.fn(),
  messagesGet: vi.fn(),
  messagesSend: vi.fn(),
}));

vi.mock('./client.js', () => ({
  gmailForUser: vi.fn().mockResolvedValue({
    users: {
      messages: {
        modify: m.modify,
        get: m.messagesGet,
        send: m.messagesSend,
      },
      labels: {
        list: vi.fn(),
        create: vi.fn(),
      },
    },
  }),
  GoogleTokenError: class GoogleTokenError extends Error {},
  isInvalidGrant: () => false,
  markNeedsReauth: vi.fn(),
}));

vi.mock('../audit/record.js', async () => {
  const actual = await vi.importActual<typeof import('../audit/record.js')>('../audit/record.js');
  return {
    ...actual,
    beginAgentAction: m.begin,
    completeAgentAction: m.complete,
  };
});

vi.mock('./forward-allowlist.js', () => ({
  isForwardTargetAllowed: m.isAllowed,
}));

const { applyAction, ForwardNotAllowedError } = await import('./actions.js');

beforeEach(() => {
  m.modify.mockReset().mockResolvedValue({});
  m.begin.mockReset().mockResolvedValue('audit-1');
  m.complete.mockReset().mockResolvedValue(undefined);
  m.isAllowed.mockReset();
  m.messagesGet.mockReset();
  m.messagesSend.mockReset();
});

describe('applyAction — trash safety guard', () => {
  it('downgrades trash to archive (removeLabel INBOX) and writes one audit row', async () => {
    const trash: Action = { type: 'trash' };
    await applyAction('user-1', 'msg-1', trash, { source: 'rule', sourceId: 'rule-1' });

    // Gmail mutation must be archive, never delete/trash.
    expect(m.modify).toHaveBeenCalledTimes(1);
    expect(m.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg-1',
      requestBody: { removeLabelIds: ['INBOX'] },
    });

    // Exactly one audit row, recorded for the *downgraded* action.
    expect(m.begin).toHaveBeenCalledTimes(1);
    const beginInput = m.begin.mock.calls[0]?.[0];
    expect(beginInput?.toolName).toBe('inbox.archive');
    expect(JSON.parse(beginInput?.toolInputJson ?? '')).toEqual({ type: 'archive' });
    expect(beginInput?.reasoning).toMatch(/trash downgraded/i);

    // Audit row flipped to applied.
    expect(m.complete).toHaveBeenCalledWith('audit-1', 'applied');
  });

  it('marks audit row failed if archive mutation throws, and rethrows', async () => {
    const boom = new Error('gmail down');
    m.modify.mockRejectedValueOnce(boom);

    await expect(
      applyAction('user-1', 'msg-1', { type: 'trash' }, { source: 'rule' }),
    ).rejects.toBe(boom);

    expect(m.complete).toHaveBeenCalledWith('audit-1', 'failed', { error: boom });
  });

  it('without auditCtx, still downgrades but skips audit log', async () => {
    await applyAction('user-1', 'msg-1', { type: 'trash' });

    expect(m.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg-1',
      requestBody: { removeLabelIds: ['INBOX'] },
    });
    expect(m.begin).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });
});

describe('applyAction — forward allowlist', () => {
  it('refuses unknown forward target → ForwardNotAllowedError, audit row failed', async () => {
    m.isAllowed.mockResolvedValueOnce(false);

    await expect(
      applyAction(
        'user-1',
        'msg-1',
        { type: 'forward', to: 'stranger@evil.com' },
        { source: 'rule' },
      ),
    ).rejects.toBeInstanceOf(ForwardNotAllowedError);

    // No Gmail send must have happened.
    expect(m.messagesSend).not.toHaveBeenCalled();
    expect(m.messagesGet).not.toHaveBeenCalled();

    // Audit row written and marked failed.
    expect(m.begin).toHaveBeenCalledTimes(1);
    const beginInput = m.begin.mock.calls[0]?.[0];
    expect(beginInput?.toolName).toBe('inbox.forward');
    expect(beginInput?.reasoning).toMatch(/not in user allowlist/i);
    expect(m.complete).toHaveBeenCalledTimes(1);
    const completeCall = m.complete.mock.calls[0];
    expect(completeCall?.[0]).toBe('audit-1');
    expect(completeCall?.[1]).toBe('failed');
  });

  it('proceeds when forward target is allowed', async () => {
    m.isAllowed.mockResolvedValueOnce(true);
    m.messagesGet.mockResolvedValueOnce({
      data: { payload: { headers: [{ name: 'Subject', value: 'hi' }, { name: 'From', value: 'a@b.c' }] } },
    });
    m.messagesSend.mockResolvedValueOnce({ data: {} });

    await applyAction(
      'user-1',
      'msg-1',
      { type: 'forward', to: 'verified@example.com' },
      { source: 'rule' },
    );

    expect(m.messagesSend).toHaveBeenCalledTimes(1);
    expect(m.complete).toHaveBeenCalledWith('audit-1', 'applied');
  });
});
