import { Router, type Router as RouterT, type Response } from 'express';
import { z } from 'zod';
import { requireUser, getUserId } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { runChatTurn } from '../chat/agent-runner.js';
import { chatEventBus, type ChatStreamEvent } from '../chat/event-bus.js';
import { logger } from '../logger.js';

/**
 * Chat surface HTTP layer — single continuous conversation per user.
 *
 *   GET  /api/chat              — fetch the full message list for the
 *                                  user's one chat (created on demand).
 *   POST /api/chat/messages     — append a user message + kick off a
 *                                  chat turn. Returns the appended user
 *                                  message; the client subscribes to
 *                                  the SSE stream to get the live
 *                                  assistant output.
 *   GET  /api/chat/events       — SSE stream of ChatStreamEvent entries.
 *                                  Send `Last-Event-Id` header (or
 *                                  ?lastSeq=...) to replay events
 *                                  buffered while disconnected.
 *   DELETE /api/chat            — clear the conversation (drops every
 *                                  message; the thread row stays).
 *
 * The chat is modelled as one persistent ChatThread per user. We
 * find-or-create that thread inside `defaultThreadFor()` so the rest
 * of the app can keep using ChatThread as a foreign-key target (e.g.
 * AgentAction.sourceId). The user never sees a thread list.
 *
 * The runner itself is fire-and-forget from the route's perspective —
 * we kick it off in the background and let the SSE stream carry tokens
 * + tool events back to the UI.
 */

export const chatRouter: RouterT = Router();
chatRouter.use(requireUser);

// ── helpers ──────────────────────────────────────────────────────────

/** Find-or-create the user's singleton chat thread. */
async function defaultThreadFor(userId: string): Promise<{ id: string }> {
  const existing = await prisma.chatThread.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' }, // pin to the oldest if multiple exist
    select: { id: true },
  });
  if (existing) return existing;
  const created = await prisma.chatThread.create({
    data: { userId, title: 'Assistant' },
    select: { id: true },
  });
  return created;
}

// ── conversation ─────────────────────────────────────────────────────

chatRouter.get('/', async (req, res) => {
  const userId = getUserId(req);
  const thread = await defaultThreadFor(userId);
  const messages = await prisma.chatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    messages: messages.map(toMessageShape),
  });
});

chatRouter.delete('/', async (req, res) => {
  const userId = getUserId(req);
  const thread = await defaultThreadFor(userId);
  await prisma.chatMessage.deleteMany({ where: { threadId: thread.id } });
  chatEventBus.clearThread(thread.id);
  res.json({ ok: true });
});

// ── messages ─────────────────────────────────────────────────────────

const PostMessageSchema = z.object({
  content: z.string().min(1).max(8000),
  /** Toggle mutating MCP tools for this turn only. */
  enableWrite: z.boolean().optional(),
});

chatRouter.post('/messages', async (req, res) => {
  const userId = getUserId(req);
  const parsed = PostMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_body', details: parsed.error.flatten() });
    return;
  }
  const thread = await defaultThreadFor(userId);

  const userMsg = await prisma.chatMessage.create({
    data: {
      threadId: thread.id,
      userId,
      role: 'user',
      content: parsed.data.content.trim(),
      status: 'done',
    },
  });

  await prisma.chatThread.update({
    where: { id: thread.id },
    data: { updatedAt: new Date() },
  });

  // Fire-and-forget: kick off the chat turn. Errors are caught and
  // emitted as turn_error events on the SSE stream.
  void runChatTurn({
    threadId: thread.id,
    userId,
    userMessageId: userMsg.id,
    enableWrite: parsed.data.enableWrite ?? false,
  }).catch((err) => {
    logger.error({ err, threadId: thread.id }, 'chat: runChatTurn rejected');
  });

  res.json({ userMessage: toMessageShape(userMsg) });
});

// ── SSE stream ───────────────────────────────────────────────────────

chatRouter.get('/events', async (req, res) => {
  const userId = getUserId(req);
  const thread = await defaultThreadFor(userId);

  setupSse(res);

  // Optional replay on reconnect.
  const lastSeenSeqHeader = req.header('Last-Event-Id');
  const lastSeenSeq = parseSeq(lastSeenSeqHeader ?? (req.query.lastSeq as string | undefined));
  if (lastSeenSeq != null) {
    const replay = chatEventBus.replay(thread.id, lastSeenSeq);
    for (const r of replay) {
      writeSseEvent(res, r.seq, r.event);
    }
  }

  const onEvent = (payload: { seq: number; event: ChatStreamEvent }) => {
    writeSseEvent(res, payload.seq, payload.event);
  };
  const channel = `thread:${thread.id}`;
  chatEventBus.on(channel, onEvent);

  // Keep-alive comment every 25s so proxies don't time out the stream.
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    chatEventBus.off(channel, onEvent);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function setupSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': open\n\n');
}

function writeSseEvent(res: Response, seq: number, event: ChatStreamEvent): void {
  res.write(`id: ${seq}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function parseSeq(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

type ChatMessageRow = Awaited<ReturnType<typeof prisma.chatMessage.findFirst>>;

function toMessageShape(row: NonNullable<ChatMessageRow>) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    persona: row.persona,
    toolEvents: row.toolEventsJson ? safeJson(row.toolEventsJson) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
