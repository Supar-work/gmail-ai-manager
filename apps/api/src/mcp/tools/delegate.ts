import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerTool } from '../stdio-server.js';
import { SPECIALISTS, type SpecialistName } from '../../agents/specialists.js';

/**
 * agent.delegate — coordinator-only meta-tool that spawns a specialist
 * subagent (a fresh `claude -p` child) with a curated MCP tool subset
 * and a persona prompt. Returns the specialist's final text response.
 *
 * Why a tool and not a server-side route: the coordinator decides
 * delegation by tool-call rather than us hard-routing on intent. This
 * mirrors open-poke's "let the model decide" lesson.
 *
 * Recursion guard: the specialist's MCP child is started without
 * GAM_MCP_ENABLE_DELEGATE, so specialists can't recursively delegate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/mcp/tools/delegate.js → ../../mcp/stdio-server.js
const STDIO_SERVER_JS = path.resolve(here, '../stdio-server.js');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const SpecialistEnum = z.enum(['triage', 'drafter', 'scheduler', 'searcher', 'explainer']);

export function registerDelegateTool(): void {
  registerTool({
    name: 'agent.delegate',
    description:
      'Spawn a specialist subagent with a tightly-scoped tool list. Use when a task requires a different persona or write surface than the coordinator has. Specialists: triage (label/archive), drafter (compose drafts only), scheduler (snooze/defer), searcher (read-only research), explainer (read-only why-did-X).',
    inputSchema: z.object({
      specialist: SpecialistEnum.describe('Which specialist to invoke.'),
      brief: z
        .string()
        .min(1)
        .max(4000)
        .describe('Self-contained instructions for the specialist. Include all the context they need; they do not see the chat history.'),
    }),
    handler: async ({ specialist, brief }, { userId }) => {
      const spec = SPECIALISTS[specialist as SpecialistName];
      if (!spec) {
        return { ok: false, error: `unknown_specialist: ${specialist}` };
      }
      const result = await runSpecialist({
        specialist: spec,
        brief,
        userId,
        chatMessageId: process.env.GAM_CHAT_MESSAGE_ID ?? null,
      });
      return result;
    },
  });
}

async function runSpecialist(opts: {
  specialist: { name: SpecialistName; systemPrompt: string; allowedTools: string[] };
  brief: string;
  userId: string;
  chatMessageId: string | null;
}): Promise<{ ok: true; specialist: SpecialistName; output: string } | { ok: false; error: string }> {
  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
  const claudeModel = process.env.CLAUDE_MODEL ?? '';

  const mcpConfig = {
    mcpServers: {
      gam: {
        type: 'stdio',
        command: process.execPath,
        args: [STDIO_SERVER_JS],
        env: {
          NODE_ENV: process.env.NODE_ENV ?? 'production',
          DATABASE_URL: process.env.DATABASE_URL ?? '',
          GAM_USER_ID: opts.userId,
          ...(opts.chatMessageId ? { GAM_CHAT_MESSAGE_ID: opts.chatMessageId } : {}),
          // Specialists may write through their allowlist — pass the
          // write flag down. The allowlist filter still prevents
          // specialists from calling tools they shouldn't.
          GAM_MCP_ENABLE_WRITE: '1',
          GAM_MCP_TOOL_ALLOWLIST: opts.specialist.allowedTools.join(','),
          // No GAM_MCP_ENABLE_DELEGATE — specialists cannot delegate.
          TOKEN_ENC_KEY: process.env.TOKEN_ENC_KEY ?? '',
          GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
          GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
          SESSION_SECRET: process.env.SESSION_SECRET ?? '',
          PATH: process.env.PATH ?? '',
        },
      },
    },
  };

  const args = [
    '-p',
    '--print',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--system-prompt',
    opts.specialist.systemPrompt,
  ];
  if (claudeModel) args.push('--model', claudeModel);

  return await new Promise((resolve) => {
    const child = spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, error: `delegate_timeout_${DEFAULT_TIMEOUT_MS}ms` });
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `delegate_spawn_failed: ${String(err)}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          ok: false,
          error: `delegate_exited_${code}: ${(stderr.trim() || stdout.trim()).slice(-240)}`,
        });
        return;
      }
      try {
        const env = JSON.parse(stdout) as { result?: string };
        resolve({
          ok: true,
          specialist: opts.specialist.name,
          output: typeof env.result === 'string' ? env.result : '',
        });
      } catch (err) {
        resolve({
          ok: false,
          error: `delegate_output_not_json: ${String(err)}: ${stdout.slice(0, 240)}`,
        });
      }
    });

    child.stdin.write(opts.brief);
    child.stdin.end();
  });
}
