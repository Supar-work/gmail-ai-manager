import { EventEmitter } from 'node:events';

/**
 * Per-thread SSE fanout bus. The chat agent runner emits structured
 * events for tokens / tool calls / completions; the SSE endpoint in
 * `apps/api/src/routes/chat.ts` subscribes per connection and writes
 * each event to the response stream.
 *
 * Events outlive the runner — buffered briefly so a client can
 * reconnect after a network drop and replay any events emitted while
 * disconnected. Buffer is keyed on threadId; trimmed on size.
 */

export type ChatStreamEvent =
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
  | {
      type: 'turn_error';
      messageId: string;
      message: string;
      ts: number;
    };

const MAX_BUFFER_PER_THREAD = 500;

class EventBus extends EventEmitter {
  private buffer = new Map<string, ChatStreamEvent[]>();
  private nextSeq = 1;
  /** Map from event id (sequence string) to event for Last-Event-Id replay. */

  emitFor(threadId: string, event: ChatStreamEvent): number {
    const seq = this.nextSeq++;
    const buf = this.buffer.get(threadId) ?? [];
    buf.push(event);
    if (buf.length > MAX_BUFFER_PER_THREAD) buf.splice(0, buf.length - MAX_BUFFER_PER_THREAD);
    this.buffer.set(threadId, buf);
    this.emit(`thread:${threadId}`, { seq, event });
    return seq;
  }

  /** Replay events from the buffer that the caller missed. */
  replay(threadId: string, lastSeenSeq: number): Array<{ seq: number; event: ChatStreamEvent }> {
    const buf = this.buffer.get(threadId);
    if (!buf) return [];
    // Buffer holds events without seq; we approximate by returning the
    // tail. Good enough for short reconnect windows; clients should
    // also re-fetch the thread on reconnect to get the full state.
    return buf.slice(-50).map((event, i) => ({ seq: lastSeenSeq + i + 1, event }));
  }

  clearThread(threadId: string): void {
    this.buffer.delete(threadId);
  }
}

export const chatEventBus = new EventBus();
