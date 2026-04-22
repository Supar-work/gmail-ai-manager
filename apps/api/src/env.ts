import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),

  // In dev: file:./dev.db (relative to apps/api). In the Tauri bundle:
  // an absolute file path under ~/Library/Application Support/gmail-ai-filters.
  DATABASE_URL: z.string().min(1),

  SESSION_SECRET: z.string().min(16),
  TOKEN_ENC_KEY: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // Loopback redirect that Google's "Desktop app" / localhost allowance accepts.
  GOOGLE_OAUTH_REDIRECT: z.string().url().default('http://127.0.0.1:3001/auth/google/callback'),

  // Path to the Claude Code CLI. Override if `claude` is not on PATH.
  CLAUDE_BIN: z.string().default('claude'),
  // Model id passed to `claude -p --model`. Leave empty to use CLI default.
  CLAUDE_MODEL: z.string().default(''),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
