import { spawn } from 'node:child_process';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * On API boot, run `claude --version` once so we can surface a banner
 * to the user when the CLI is missing or wedged. Without this, a
 * missing `claude` binary fails silently per-rule with a `claude_spawn_failed`
 * audit row and no UI signal — the user just sees "rules don't fire".
 *
 * The result is cached in module state and exposed via /api/me; the UI
 * renders a banner when state.ok is false.
 */

export type PreflightStatus =
  | { ok: true; version: string; checkedAt: string }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; detail: string; checkedAt: string };

let status: PreflightStatus = {
  ok: false,
  reason: 'missing',
  detail: 'preflight has not run yet',
  checkedAt: new Date(0).toISOString(),
};

const TIMEOUT_MS = 5_000;

export function getClaudePreflightStatus(): PreflightStatus {
  return status;
}

export async function runClaudePreflight(): Promise<PreflightStatus> {
  const bin = env.CLAUDE_BIN;
  const checkedAt = new Date().toISOString();
  const result = await new Promise<PreflightStatus>((resolve) => {
    let child;
    try {
      child = spawn(bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: 'missing',
        detail: err instanceof Error ? err.message : String(err),
        checkedAt,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        ok: false,
        reason: 'timeout',
        detail: `claude --version did not return within ${TIMEOUT_MS}ms`,
        checkedAt,
      });
    }, TIMEOUT_MS);

    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < 1024) stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 1024) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: 'missing',
        detail: err instanceof Error ? err.message : String(err),
        checkedAt,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, version: stdout.trim() || 'unknown', checkedAt });
      } else {
        resolve({
          ok: false,
          reason: 'failed',
          detail: (stderr.trim() || stdout.trim() || `exit ${code}`).slice(0, 240),
          checkedAt,
        });
      }
    });
  });

  status = result;
  if (result.ok) {
    logger.info({ version: result.version }, 'claude preflight ok');
  } else {
    logger.error(
      { reason: result.reason, detail: result.detail },
      'claude preflight failed — rules will not fire until CLI is available',
    );
  }
  return result;
}
