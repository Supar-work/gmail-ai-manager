import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { localOnly } from './local-only.js';

function makeApp() {
  const app = express();
  app.use(localOnly({ port: 3001, extraOrigins: ['http://localhost:5173'] }));
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.post('/ok', (_req, res) => res.json({ ok: true }));
  return app;
}

interface RawResponse {
  status: number;
  body: string;
}

async function rawRequest(
  app: express.Express,
  init: { method?: string; path?: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  try {
    return await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: addr.port,
          method: init.method ?? 'GET',
          path: init.path ?? '/ok',
          headers: init.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('localOnly middleware', () => {
  it('rejects foreign Host header', async () => {
    const res = await rawRequest(makeApp(), {
      headers: { Host: 'evil.com:3001' },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden_host' });
  });

  it('accepts loopback Host on GET', async () => {
    const res = await rawRequest(makeApp(), {
      headers: { Host: '127.0.0.1:3001' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects cross-site POST (Origin not in allowlist)', async () => {
    const res = await rawRequest(makeApp(), {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3001',
        Origin: 'http://evil.com',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden_origin' });
  });

  it('accepts same-origin POST', async () => {
    const res = await rawRequest(makeApp(), {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3001',
        Origin: 'http://127.0.0.1:3001',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(res.status).toBe(200);
  });

  it('accepts non-browser POST (no Origin, no Sec-Fetch-Site)', async () => {
    const res = await rawRequest(makeApp(), {
      method: 'POST',
      headers: { Host: '127.0.0.1:3001' },
    });
    expect(res.status).toBe(200);
  });

  it('accepts dev Vite Origin from extraOrigins', async () => {
    const res = await rawRequest(makeApp(), {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3001',
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-site',
      },
    });
    expect(res.status).toBe(200);
  });
});
