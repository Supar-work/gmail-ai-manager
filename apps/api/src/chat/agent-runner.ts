import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { prisma } from '../db/client.js';
import { chatEventBus, type ChatStreamEvent } from './event-bus.js';
import { COORDINATOR_PROMPT } from './persona.js';

/**
 * Spawns `claude -p --mcp-config <…>` to drive a single chat turn,
 * then streams the JSON-encoded events into the per-thread SSE bus and
 * persists the final assistant ChatMessage row.
 *
 * Architecture:
 *   1. Build a temporary MCP config that points at our own
 *      stdio-server.js, exporting GAM_USER_ID + DATABASE_URL so the
 *      MCP child reuses the same SQLite + Prisma layer.
 *   2. Spawn claude -p with --output-format stream-json + --print so it
 *      emits one JSON event per line on stdout (init, assistant text +
 *      tool_use blocks, user tool_result blocks, final result).
 *   3. Translate those events into our compact `ChatStreamEvent` shape
 *      and emit on `chatEventBus`. The route handler in routes/chat.ts
 *      subscribes per SSE connection.
 *   4. On completion, write the assistant message to the DB with the
 *      full text + a JSON-encoded toolEvents trail so a later reload
 *      can re-render the run.
 *
 * Mutations: write tools are gated behind `GAM_MCP_ENABLE_WRITE=1` on
 * the MCP child. We pass that env var only when the user has opted into
 * writes (M6); the chat surface ships read-only first.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// In dist:  apps/api/dist/chat/agent-runner.js → ../mcp/stdio-server.js
// In dev:   apps/api/src/chat/agent-runner.ts  → ../mcp/stdio-server.ts
//   tsx resolves the .ts at runtime; in production we resolve to .js.
const STDIO_SERVER_JS = path.resolve(here, '../mcp/stdio-server.js');
const STDIO_SERVER_TS = path.resolve(here, '../mcp/stdio-server.ts');

const TURN_TIMEOUT_MS = 5 * 60 * 1000; // 5 min cap per chat turn

export type RunChatTurnInput = {
  threadId: string;
  userId: string;
  /** ChatMessage.id of the just-written user turn. Used to attribute
   *  any audit rows to this exact message. */
  userMessageId: string;
  /** Persona/prompt mode. Today only "coordinator". */
  persona?: 'coordinator';
  /** Allow mutations during this turn. Off by default (read-only). */
  enableWrite?: boolean;
};

type RunChatTurnResult = {
  assistantMessageId: string;
  text: string;
  toolEvents: ChatStreamEvent[];
};

/**
 * Drive one chat turn end-to-end. Returns when the agent has finished
 * (or errored). Streams progress through `chatEventBus` while running.
 */
export async function runChatTurn(input: RunChatTurnInput): Promise<RunChatTurnResult> {
  const { threadId, userId, userMessageId, persona = 'coordinator', enableWrite = false } = input;

  // Buffered copy of every event we emit this turn — persisted onto
  // the assistant ChatMessage row so the trail survives a reload.
  // Declared up here (before any `emit()` call) to avoid a TDZ trap:
  // function-scoped `function emit(...)` is hoisted but its body
  // closes over `events`, and accessing a `const` before its line
  // throws.
  const events: ChatStreamEvent[] = [];
  function emit(thread: string, e: ChatStreamEvent): void {
    events.push(e);
    chatEventBus.emitFor(thread, e);
  }

  // 1. Insert the assistant placeholder row up front so SSE consumers
  //    that arrive late can still find the row and replay the buffered
  //    events.
  const assistant = await prisma.chatMessage.create({
    data: {
      threadId,
      userId,
      role: 'assistant',
      content: '',
      status: 'running',
      persona,
    },
  });

  emit(threadId, { type: 'turn_start', messageId: assistant.id, ts: Date.now() });

  // 2. Build the prompt — include short prior-turn history so the agent
  //    has continuity without us re-implementing claude's resume mode.
  //    History is capped at the last 12 turns to keep token usage in
  //    check; longer threads can still read older messages on demand
  //    via the persistence layer.
  const history = await prisma.chatMessage.findMany({
    where: {
      threadId,
      // Skip the running placeholder — we add the latest user message
      // explicitly below and the assistant turn we're producing now is
      // empty.
      NOT: { id: assistant.id },
    },
    orderBy: { createdAt: 'asc' },
    take: 25,
  });

  const transcript = history
    .filter((m) => m.role !== 'system' && m.content.trim().length > 0)
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
    .join('\n\n');

  // The latest user message is already in `history` (we just wrote it
  // upstream of this call). We still pass the whole transcript to give
  // claude the prior turns; the persona prompt instructs the agent to
  // act on the LATEST user line.
  const prompt = transcript.length > 0 ? transcript : '(empty thread)';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { claudeModel: true },
  });

  // 3. Build the MCP config + spawn claude.
  const mcpConfig = buildMcpConfig({
    userId,
    chatMessageId: userMessageId,
    enableWrite,
  });

  const args = [
    '-p',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose', // required by claude-p when output-format=stream-json
    '--permission-mode',
    'bypassPermissions',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--system-prompt',
    COORDINATOR_PROMPT,
  ];
  if (user?.claudeModel) {
    args.push('--model', user.claudeModel);
  } else if (env.CLAUDE_MODEL) {
    args.push('--model', env.CLAUDE_MODEL);
  }

  // Tool-use bookkeeping: claude emits start (tool_use block) and the
  // matching end (tool_result in the next user message). We pair them
  // up so we can compute elapsed-ms + isError on the close event.
  const toolStarts = new Map<string, { startTs: number; tool: string }>();
  let assistantText = '';

  await new Promise<void>((resolve) => {
    const child = spawn(env.CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdoutBuf = '';
    let stderr = '';
    let settled = false;

    const settle = (reason?: { kind: 'error'; message: string }) => {
      if (settled) return;
      settled = true;
      if (reason) {
        emit(threadId, {
          type: 'turn_error',
          messageId: assistant.id,
          message: reason.message,
          ts: Date.now(),
        });
      } else {
        emit(threadId, { type: 'turn_done', messageId: assistant.id, ts: Date.now() });
      }
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'error', message: `chat_turn_timeout_${TURN_TIMEOUT_MS}ms` });
    }, TURN_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      // stream-json is JSONL — process complete lines.
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt: unknown = JSON.parse(line);
          handleClaudeEvent(evt);
        } catch (err) {
          logger.warn({ err, line: line.slice(0, 200) }, 'chat: malformed stream-json line');
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      settle({ kind: 'error', message: `claude_spawn_failed: ${String(err)}` });
    });

    child.on('close', (code) => {
      if (code !== 0 && !settled) {
        settle({
          kind: 'error',
          message: `claude_exited_${code}: ${stderr.trim().slice(-240)}`,
        });
        return;
      }
      settle();
    });

    // Pipe the prompt in and close stdin — one-shot.
    child.stdin.write(prompt);
    child.stdin.end();

    // ── Event router ────────────────────────────────────────────────
    function handleClaudeEvent(evt: unknown): void {
      if (typeof evt !== 'object' || evt === null) return;
      const e = evt as Record<string, unknown>;
      const t = e.type;
      if (t === 'assistant') {
        const msg = e.message as { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === 'text') {
            const txt = String(block.text ?? '');
            assistantText += txt;
            emit(threadId, {
              type: 'assistant_text',
              messageId: assistant.id,
              delta: txt,
              ts: Date.now(),
            });
          } else if (block.type === 'tool_use') {
            const id = String(block.id ?? '');
            const name = String(block.name ?? '');
            const inputArg = block.input ?? {};
            toolStarts.set(id, { startTs: Date.now(), tool: name });
            emit(threadId, {
              type: 'tool_use_start',
              messageId: assistant.id,
              toolUseId: id,
              tool: name,
              input: inputArg,
              ts: Date.now(),
            });
          }
        }
      } else if (t === 'user') {
        const msg = e.message as { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === 'tool_result') {
            const id = String(block.tool_use_id ?? '');
            const isError = block.is_error === true;
            const result = block.content ?? null;
            const start = toolStarts.get(id);
            const ms = start ? Date.now() - start.startTs : 0;
            toolStarts.delete(id);
            emit(threadId, {
              type: 'tool_use_end',
              messageId: assistant.id,
              toolUseId: id,
              result,
              isError,
              ms,
              ts: Date.now(),
            });
          }
        }
      } else if (t === 'result') {
        // Final envelope; ignore here — we settle on `close` so we
        // capture the exit code.
      }
    }
  });

  // 4. Persist the assistant turn.
  await prisma.chatMessage.update({
    where: { id: assistant.id },
    data: {
      content: assistantText,
      status: 'done',
      toolEventsJson: events.length > 0 ? JSON.stringify(events) : null,
    },
  });
  await prisma.chatThread.update({
    where: { id: threadId },
    data: { updatedAt: new Date() },
  });

  return {
    assistantMessageId: assistant.id,
    text: assistantText,
    toolEvents: events,
  };
}

// ── MCP config ───────────────────────────────────────────────────────

type McpConfig = {
  mcpServers: Record<
    string,
    {
      type: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  >;
};

function buildMcpConfig(opts: {
  userId: string;
  chatMessageId: string;
  enableWrite: boolean;
}): McpConfig {
  // In production our compiled stdio server lives at dist/mcp/stdio-server.js.
  // In dev we run from src; tsx (the dev runner) loads .ts via hooks but a
  // child node process can't, so dev still requires a one-time `pnpm build`
  // before chat works. The prod path is the common case.
  // Use STDIO_SERVER_JS first; fall back to STDIO_SERVER_TS only if the
  // .js doesn't exist (rare — only in fresh dev workspaces).
  // We leave that decision to runtime in the runner since `fs.existsSync`
  // here would require a sync import.
  const serverPath = STDIO_SERVER_JS;

  return {
    mcpServers: {
      gam: {
        type: 'stdio',
        command: process.execPath, // current node binary
        args: [serverPath],
        env: {
          // Never inherit Claude OAuth env into the MCP child — the same
          // hygiene we apply to the main runClaude call.
          NODE_ENV: process.env.NODE_ENV ?? 'production',
          DATABASE_URL: process.env.DATABASE_URL ?? '',
          GAM_USER_ID: opts.userId,
          GAM_CHAT_MESSAGE_ID: opts.chatMessageId,
          ...(opts.enableWrite ? { GAM_MCP_ENABLE_WRITE: '1' } : {}),
          // Coordinator gets the delegate meta-tool; specialists do not.
          GAM_MCP_ENABLE_DELEGATE: '1',
          // Pass the model down so the delegate spawn picks the same
          // version as the coordinator.
          ...(env.CLAUDE_MODEL ? { CLAUDE_MODEL: env.CLAUDE_MODEL } : {}),
          CLAUDE_BIN: env.CLAUDE_BIN,
          // Token encryption + Google OAuth env are required because
          // mcp tools may call Gmail (which reads encrypted tokens).
          TOKEN_ENC_KEY: process.env.TOKEN_ENC_KEY ?? '',
          GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
          GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
          SESSION_SECRET: process.env.SESSION_SECRET ?? '',
          PATH: process.env.PATH ?? '',
        },
      },
    },
  };
}

// Suppress unused-symbol complaint for the dev-fallback path; kept here
// so we can switch to it later without re-discovering the location.
void STDIO_SERVER_TS;
