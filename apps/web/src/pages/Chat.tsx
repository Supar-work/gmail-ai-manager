import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../lib/api.js';

/**
 * Single-thread chat surface — one continuous conversation per user.
 * Talks to the backend at /api/chat (singleton) and consumes SSE
 * events from /api/chat/events. Persistence + reconnect: on reload we
 * re-fetch the conversation and re-open the SSE channel; the bus on
 * the server replays buffered events so we don't lose tokens emitted
 * during the network blip.
 */

type ToolEvent =
  | { type: 'turn_start'; messageId: string; ts: number }
  | { type: 'assistant_text'; messageId: string; delta: string; ts: number }
  | {
      type: 'tool_use_start';
      messageId: string;
      toolUseId: string;
      tool: string;
      input: unknown;
      ts: number;
    }
  | {
      type: 'tool_use_end';
      messageId: string;
      toolUseId: string;
      result: unknown;
      isError: boolean;
      ms: number;
      ts: number;
    }
  | { type: 'turn_done'; messageId: string; ts: number }
  | { type: 'turn_error'; messageId: string; message: string; ts: number };

type ChatMessageView = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'running' | 'done' | 'error';
  persona: string | null;
  toolEvents: ToolEvent[] | null;
  createdAt: string;
};
type ConversationResponse = {
  messages: ChatMessageView[];
};

type State = {
  messages: ChatMessageView[];
  /** Highest SSE seq number we've received so far (for Last-Event-Id). */
  lastSeq: number;
};
type Action =
  | { type: 'load'; messages: ChatMessageView[] }
  | { type: 'event'; seq: number; event: ToolEvent }
  | { type: 'optimistic-user'; message: ChatMessageView };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load':
      return { messages: action.messages, lastSeq: 0 };
    case 'optimistic-user':
      return { ...state, messages: [...state.messages, action.message] };
    case 'event': {
      const seq = Math.max(state.lastSeq, action.seq);
      const e = action.event;
      const messages = [...state.messages];
      const idx = messages.findIndex((m) => m.id === e.messageId);
      if (e.type === 'turn_start') {
        if (idx === -1) {
          messages.push({
            id: e.messageId,
            role: 'assistant',
            content: '',
            status: 'running',
            persona: 'coordinator',
            toolEvents: [e],
            createdAt: new Date(e.ts).toISOString(),
          });
        }
        return { messages, lastSeq: seq };
      }
      if (idx === -1) return { ...state, lastSeq: seq };
      const m = { ...messages[idx]! };
      m.toolEvents = [...(m.toolEvents ?? []), e];
      if (e.type === 'assistant_text') {
        m.content = m.content + e.delta;
      } else if (e.type === 'turn_done') {
        m.status = 'done';
      } else if (e.type === 'turn_error') {
        m.status = 'error';
        if (!m.content) m.content = `Error: ${e.message}`;
      }
      messages[idx] = m;
      return { messages, lastSeq: seq };
    }
  }
}

export function Chat() {
  const qc = useQueryClient();
  const [{ messages, lastSeq }, dispatch] = useReducer(reducer, {
    messages: [],
    lastSeq: 0,
  });
  const [input, setInput] = useState('');
  const [enableWrite, setEnableWrite] = useState(false);

  const conversation = useQuery<ConversationResponse>({
    queryKey: ['chat-conversation'],
    queryFn: () => apiGet('/api/chat'),
    refetchOnWindowFocus: false,
  });

  // Hydrate state when the conversation loads.
  useEffect(() => {
    if (conversation.data) {
      dispatch({ type: 'load', messages: conversation.data.messages });
    }
  }, [conversation.data]);

  // SSE subscription — opens once after first hydrate; reconnect uses
  // the last-seen sequence number so the buffered replay closes the
  // gap.
  const lastSeqRef = useRef(lastSeq);
  lastSeqRef.current = lastSeq;
  useEffect(() => {
    const url =
      lastSeqRef.current > 0
        ? `/api/chat/events?lastSeq=${lastSeqRef.current}`
        : `/api/chat/events`;
    const es = new EventSource(url, { withCredentials: true });
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as ToolEvent;
        const seq = ev.lastEventId ? Number.parseInt(ev.lastEventId, 10) : 0;
        dispatch({ type: 'event', seq, event: data });
      } catch {
        // ignore malformed
      }
    };
    for (const t of [
      'turn_start',
      'assistant_text',
      'tool_use_start',
      'tool_use_end',
      'turn_done',
      'turn_error',
    ]) {
      es.addEventListener(t, handler as EventListener);
    }
    es.onerror = () => {
      // Browser auto-reconnects; nothing to do.
    };
    return () => {
      es.close();
    };
  }, []);

  const send = useMutation<{ userMessage: ChatMessageView }, Error, string>({
    mutationFn: (content) =>
      apiSend(`POST`, `/api/chat/messages`, {
        content,
        enableWrite,
      }),
    onSuccess: (data) => {
      dispatch({ type: 'optimistic-user', message: data.userMessage });
    },
  });

  const clear = useMutation<unknown>({
    mutationFn: () => apiSend('DELETE', '/api/chat'),
    onSuccess: () => {
      dispatch({ type: 'load', messages: [] });
      qc.invalidateQueries({ queryKey: ['chat-conversation'] });
    },
  });

  // Auto-scroll to bottom on each message tick.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const lastIsRunning = useMemo(() => {
    const last = messages[messages.length - 1];
    return last?.role === 'assistant' && last?.status === 'running';
  }, [messages]);

  return (
    <div className="chat-page chat-page--single">
      <div className="chat-thread">
        <header className="chat-thread-head">
          <div className="chat-thread-title">Assistant</div>
          <button
            className="chat-delete"
            onClick={() => {
              if (messages.length > 0 && confirm('Clear the entire conversation?')) clear.mutate();
            }}
            disabled={messages.length === 0}
          >
            Clear
          </button>
        </header>

        <div className="chat-messages" ref={scrollerRef}>
          {conversation.isLoading && messages.length === 0 && (
            <div className="empty">Loading…</div>
          )}
          {!conversation.isLoading && messages.length === 0 && (
            <div className="empty">
              Ask anything. <span className="muted">e.g. "anything urgent today?"</span>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>

        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = input.trim();
            if (!text || send.isPending || lastIsRunning) return;
            setInput('');
            send.mutate(text);
          }}
        >
          <textarea
            className="chat-input"
            placeholder="Message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement).requestSubmit();
              }
            }}
          />
          <div className="chat-composer-row">
            <label className="chat-write-toggle muted">
              <input
                type="checkbox"
                checked={enableWrite}
                onChange={(e) => setEnableWrite(e.target.checked)}
              />
              Allow agent to mutate Gmail (label / archive / draft / snooze)
            </label>
            <button className="primary" type="submit" disabled={!input.trim() || lastIsRunning}>
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessageView }) {
  const cls = `chat-bubble chat-bubble--${message.role}${
    message.status === 'error' ? ' chat-bubble--err' : ''
  }`;
  const tools = (message.toolEvents ?? []).filter(
    (e) => e.type === 'tool_use_start' || e.type === 'tool_use_end',
  );
  return (
    <div className={cls}>
      <div className="chat-bubble-body">
        {message.content ? message.content : message.status === 'running' ? '…' : ''}
      </div>
      {tools.length > 0 && (
        <details className="chat-tool-trail">
          <summary>{toolSummary(tools)}</summary>
          <ToolTrail events={tools} />
        </details>
      )}
    </div>
  );
}

function toolSummary(events: ToolEvent[]): string {
  const starts = events.filter((e) => e.type === 'tool_use_start');
  const ends = events.filter((e) => e.type === 'tool_use_end');
  if (ends.length === starts.length) {
    return `${starts.length} tool call${starts.length === 1 ? '' : 's'}`;
  }
  return `${starts.length} call${starts.length === 1 ? '' : 's'} (${ends.length} done)`;
}

function ToolTrail({ events }: { events: ToolEvent[] }) {
  const starts = events.filter(
    (e): e is Extract<ToolEvent, { type: 'tool_use_start' }> => e.type === 'tool_use_start',
  );
  const ends = new Map(
    events
      .filter(
        (e): e is Extract<ToolEvent, { type: 'tool_use_end' }> => e.type === 'tool_use_end',
      )
      .map((e) => [e.toolUseId, e]),
  );
  return (
    <ol className="chat-tool-list">
      {starts.map((s) => {
        const end = ends.get(s.toolUseId);
        return (
          <li key={s.toolUseId} className={end?.isError ? 'chat-tool-li err' : 'chat-tool-li'}>
            <code className="chat-tool-name">{s.tool}</code>
            <code className="chat-tool-input">{compactJson(s.input)}</code>
            {end ? (
              <span className="muted">
                {' → '}
                {end.isError ? 'error' : 'ok'} ({end.ms}ms)
              </span>
            ) : (
              <span className="muted"> → running…</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function compactJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  } catch {
    return String(v);
  }
}
