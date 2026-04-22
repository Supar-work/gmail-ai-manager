// Dummy env values so modules that parse env.ts at import time can load
// under vitest. Real dev/prod values come from apps/api/.env.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'file:./test.db';
process.env.SESSION_SECRET ??= 'test-session-secret-at-least-16-chars';
process.env.TOKEN_ENC_KEY ??= Buffer.alloc(32, 0).toString('base64');
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
