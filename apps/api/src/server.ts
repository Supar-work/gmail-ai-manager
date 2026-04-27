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
import { startScheduler } from './jobs/scheduler.js';
import { startMemoryConsolidator } from './jobs/memory-consolidator.js';
import { startPoller } from './gmail/poll.js';

const app = express();

app.use(pinoHttp({ logger }));

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
app.use(cookieParser(env.SESSION_SECRET));
// 10mb gives plenty of headroom for full-DB backup imports (a typical
// user's rules + GmailFilter mirror is well under 1mb, but originalFilterJson
// blobs can balloon for heavy Gmail users).
app.use(express.json({ limit: '10mb' }));

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

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  startScheduler();
  startPoller();
  startMemoryConsolidator();
});
