import { spawn } from 'node:child_process';
import type { ZodType } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';

export class ClaudeInvocationError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'ClaudeInvocationError';
  }
}

export type ClaudeOptions = {
  timeoutMs?: number;
  // Explicit override for the CLI prompt-mode --model flag. Falls back to env.
  model?: string;
};

const DEFAULT_TIMEOUT = 90_000;
// Hard cap on prompt size sent to the CLI. Long inbox bodies (calendar
// invites with mhtml attachments, long marketing emails) can land here
// at megabyte scale; truncating bounds CLI memory + token cost without
// losing the signal in the first 64 KB.
const MAX_PROMPT_BYTES = 64 * 1024;
// Hard cap on stdout we'll accumulate. Claude's JSON envelope for our
// prompts is well under 100 KB; a runaway response (Claude looping on
// the prompt) shouldn't be allowed to balloon Node's heap.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/**
 * Build the env passed to the CLI subprocess. Explicit allowlist rather
 * than a wholesale `{ ...process.env }` so any future API-side secret
 * (an Anthropic key in this process for SDK-backed paths, a database
 * password, etc.) doesn't get forwarded into a child we don't fully
 * trust to redact its logs.
 */
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const allow = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    const v = process.env[k];
    if (typeof v === 'string') out[k] = v;
  }
  // The CLI looks under $HOME/.claude for its auth + config — needs
  // HOME at minimum. CLAUDE_* vars (CLAUDE_CONFIG_DIR, etc.) are
  // intentionally NOT forwarded; the Tauri shell scrubs them before
  // spawning the API for the same reason.
  return out;
}

function truncatePrompt(prompt: string): string {
  if (Buffer.byteLength(prompt, 'utf8') <= MAX_PROMPT_BYTES) return prompt;
  // Slice on UTF-8 code units, not characters — preserves multibyte
  // sequences. Reserve room for the truncation marker.
  const marker = '\n\n[... truncated to fit prompt size cap ...]';
  const budget = MAX_PROMPT_BYTES - Buffer.byteLength(marker, 'utf8');
  const buf = Buffer.from(prompt, 'utf8').subarray(0, budget);
  // Trim a possible split codepoint at the boundary.
  return buf.toString('utf8') + marker;
}

/**
 * Run `claude -p` as a one-shot subprocess. The prompt is sent on stdin.
 * Output is parsed as the CLI's JSON envelope so we can pull the model's
 * text response without depending on output-layout heuristics.
 *
 * Uses --permission-mode bypassPermissions so the CLI never pauses asking
 * for tool approvals — our prompts don't request tools, but the flag makes
 * the behavior deterministic if the model ever tries.
 */
export async function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<string> {
  const bin = env.CLAUDE_BIN;
  const model = opts.model ?? env.CLAUDE_MODEL;
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
  if (model) args.push('--model', model);

  const safePrompt = truncatePrompt(prompt);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSubprocessEnv(),
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stdoutOverflowed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ClaudeInvocationError(`claude_timeout_${opts.timeoutMs ?? DEFAULT_TIMEOUT}ms`, stderr));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

    child.stdout.on('data', (c: Buffer) => {
      stdoutBytes += c.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!stdoutOverflowed) {
          stdoutOverflowed = true;
          logger.warn({ stdoutBytes }, 'claude stdout exceeded cap; killing');
          child.kill('SIGKILL');
        }
        return;
      }
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      // Stderr is small; cap loosely so a misbehaving CLI can't OOM us.
      if (stderr.length < 64 * 1024) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ClaudeInvocationError(`claude_spawn_failed: ${String(err)}`, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // The CLI still emits its JSON envelope on non-zero exits — parse it
        // so the caller sees "rate_limit_error" instead of a noisy tail of
        // raw JSON. Falls back to raw slice if parsing fails.
        let reason = '';
        try {
          const env = JSON.parse(stdout);
          const err = env?.error;
          const result = typeof env?.result === 'string' ? env.result : '';
          if (err) {
            reason =
              typeof err === 'string'
                ? err
                : `${err.type ?? 'error'}: ${err.message ?? JSON.stringify(err)}`;
          } else if (env?.subtype && env.subtype !== 'success') {
            reason = `${env.subtype}${result ? `: ${result.slice(0, 240)}` : ''}`;
          } else if (result) {
            reason = result.slice(0, 240);
          }
        } catch {
          /* fall through */
        }
        if (!reason) {
          reason = stderr.trim().slice(-240) || stdout.trim().slice(-240);
        }
        reject(
          new ClaudeInvocationError(
            `claude_exited_${code}${reason ? `: ${reason}` : ''}`,
            stderr,
          ),
        );
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        const result = typeof envelope?.result === 'string' ? envelope.result : null;
        if (result === null) {
          reject(new ClaudeInvocationError('claude_result_missing', stderr));
          return;
        }
        resolve(result);
      } catch (err) {
        reject(
          new ClaudeInvocationError(`claude_output_not_json: ${String(err)}\n${stdout.slice(0, 400)}`, stderr),
        );
      }
    });

    child.stdin.write(safePrompt);
    child.stdin.end();
  });
}

/** Transient CLI / API failures that are worth retrying once. */
function isTransientError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('authentication_error') ||
    m.includes(' 401') ||
    m.includes(': 401') ||
    m.includes('rate_limit') ||
    m.includes('overloaded_error') ||
    m.includes('service_unavailable') ||
    m.includes(' 502') ||
    m.includes(' 503') ||
    m.includes(' 504') ||
    m.includes('claude_timeout_')
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Ask claude for JSON and zod-validate the response. Retries up to twice:
 *   - transient subprocess errors (401 token refresh blips, overloaded,
 *     short timeouts) → back off and try again
 *   - schema-violating responses → nudge for JSON-only and try again
 */
export async function runClaudeJson<T>(
  prompt: string,
  schema: ZodType<T>,
  opts: ClaudeOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const nudged = attempt > 0 && lastErr instanceof ClaudeInvocationError
      && /schema_violation|no_json_in_response/.test(lastErr.message);
    // On schema failures, surface the SPECIFIC zod message so Claude can
    // actually fix it (e.g., "naturalLanguage must literally include
    // 'Notifications/LinkedIn'") rather than seeing only a generic
    // "respond with JSON" nudge. The issue text lives in
    // lastErr.message after "schema_violation: ".
    const specificIssue =
      nudged && lastErr instanceof ClaudeInvocationError
        ? lastErr.message
            .replace(/^schema_violation:\s*/, '')
            .replace(/^no_json_in_response:\s*/, '')
            .split('\nresponse:')[0]
            ?.trim()
        : '';
    const p = nudged
      ? `${prompt}\n\nIMPORTANT: Your previous response could not be parsed as JSON matching the required schema. Respond ONLY with a single valid JSON object, no code fences, no prose.${
          specificIssue ? `\n\nSpecific issue to fix:\n${specificIssue.slice(0, 600)}` : ''
        }`
      : prompt;

    let text: string;
    try {
      text = await runClaude(p, opts);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 2 && isTransientError(msg)) {
        logger.warn({ err: msg, attempt }, 'claude transient error, retrying');
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw err;
    }

    const json = extractJson(text);
    if (json === null) {
      lastErr = new ClaudeInvocationError(`no_json_in_response: ${text.slice(0, 300)}`);
      logger.warn({ err: String(lastErr) }, 'claude response had no json, retrying');
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    lastErr = new ClaudeInvocationError(
      `schema_violation: ${parsed.error.message}\nresponse: ${text.slice(0, 400)}`,
    );
    logger.warn({ err: String(lastErr) }, 'claude response failed schema, retrying');
  }
  throw lastErr;
}

/** Extract the first top-level JSON object/array from a text blob. */
function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  // Strip ```json fences if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1]! : trimmed;
  // Try direct parse first.
  try {
    return JSON.parse(body);
  } catch {
    // Fall through to scan.
  }
  // Scan for balanced { } or [ ] spans.
  const first = body.search(/[\[{]/);
  if (first < 0) return null;
  const open = body[first]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = first; i < body.length; i++) {
    const ch = body[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const span = body.slice(first, i + 1);
        try {
          return JSON.parse(span);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Exported only so unit tests can exercise the parser without spawning.
export const _internal = { extractJson };
