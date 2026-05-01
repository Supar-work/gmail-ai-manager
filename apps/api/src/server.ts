import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './logger.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { filtersRouter } from './routes/filters.js';
import { rulesRouter } from './routes/rules.js';
import { backupsRouter } from './routes/backups.js';
import { classifyRouter } from './routes/classify.js';
import { decisionsRouter } from './routes/decisions.js';
import { migrationRouter } from './routes/migration.js';
import { runsRouter } from './routes/runs.js';
import { settingsRouter } from './routes/settings.js';
import { modelsRouter } from './routes/models.js';
import { gmailFiltersRouter } from './routes/gmail-filters.js';
import { inboxCleanupRouter } from './routes/inbox-cleanup.js';
import { agentActionsRouter } from './routes/agent-actions.js';
import { controlRouter } from './routes/control.js';
import { chatRouter } from './routes/chat.js';
import { startScheduler } from './jobs/scheduler.js';
import { startMemoryConsolidator } from './jobs/memory-consolidator.js';
import { startPruner } from './jobs/pruner.js';
import { startEmbeddingsIndexer } from './embeddings/indexer.js';
import { startPoller } from './gmail/poll.js';
import { localOnly } from './middleware/local-only.js';
import { runClaudePreflight } from './claude/preflight.js';

const app = express();

app.use(cookieParser(env.SESSION_SECRET));
app.use(pinoHttp({ logger }));

// Reject any request whose Host header isn't loopback-on-our-port (DNS
// rebinding) and any cross-site mutation (CSRF). Mounted before routers
// and before the static SPA so it covers every path.
app.use(
  localOnly({
    port: env.PORT,
    // In dev, Vite serves the UI from a different port and proxies fetches
    // here; allow its origin. Production is same-origin so this is empty.
    extraOrigins: env.NODE_ENV !== 'production' ? [env.PUBLIC_WEB_URL] : [],
  }),
);

// In dev, the web UI runs on a different port (Vite) so we need CORS. In
// production the API serves the built UI and the request is same-origin.
if (env.NODE_ENV !== 'production') {
  app.use(
    cors({
      origin: env.PUBLIC_WEB_URL,
      credentials: true,
    }),
  );
}
// Tight body limit on every route (most accept small JSON payloads), with
// the single exception of /api/backups/import which can carry a full DB
// snapshot — originalFilterJson blobs balloon on heavy Gmail users.
const smallJson = express.json({ limit: '100kb' });
const bigJson = express.json({ limit: '10mb' });
app.use((req, res, next) => {
  if (req.path === '/api/backups/import') return bigJson(req, res, next);
  return smallJson(req, res, next);
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.use('/auth', authRouter);
app.use('/me', meRouter);
app.use('/api/filters', filtersRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/classify', classifyRouter);
app.use('/api/decisions', decisionsRouter);
app.use('/api/migration', migrationRouter);
app.use('/api/runs', runsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/models', modelsRouter);
app.use('/api/gmail-filters', gmailFiltersRouter);
app.use('/api/inbox-cleanup', inboxCleanupRouter);
app.use('/api/agent-actions', agentActionsRouter);
app.use('/api/control', controlRouter);
app.use('/api/chat', chatRouter);

// JSON 404 for unmatched API/auth/me routes. Without this, prod falls
// through to the SPA fallback below (returning HTML for an API miss),
// and dev returns Express's default HTML 404. Either way the client
// can't distinguish "route doesn't exist" from "auth/server error".
app.use(/^\/(api|auth|me)(\/|$)/, (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

if (env.NODE_ENV === 'production') {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server.js → apps/api/dist, web dist → apps/web/dist
  const webDist = path.resolve(here, '../../web/dist');
  app.use(express.static(webDist));
  app.get(/^\/(?!auth|me|api|healthz).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

// Bind to loopback only. The Tauri shell, the Vite dev server, and any
// other consumer all reach us via 127.0.0.1; binding to 0.0.0.0 would
// expose the API to the local network (and to DNS rebinding).
app.listen(env.PORT, '127.0.0.1', () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  // Preflight runs in the background — don't block listening on it. The
  // result lands in module state and is read by /me so the UI can show
  // a banner when the CLI is missing.
  void runClaudePreflight();
  startScheduler();
  startPoller();
  startMemoryConsolidator();
  startPruner();
  startEmbeddingsIndexer();
});
