import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function allowedHosts(port: number): Set<string> {
  return new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ]);
}

function allowedOrigins(port: number): Set<string> {
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);
}

export interface LocalOnlyOptions {
  port: number;
  // Extra origins to permit (e.g. Vite dev server in development).
  extraOrigins?: string[];
}

// Defends against DNS-rebinding and cross-site requests by enforcing that
// every request's Host is loopback-on-our-port and that mutating requests
// originate from the same loopback origin (Sec-Fetch-Site or Origin).
//
// Browsers always send Host; an attacker rebinding evil.com → 127.0.0.1
// is forced to use Host: evil.com:3001 (their own DNS name), which fails
// the Host check. For mutating requests we *additionally* require either
// Sec-Fetch-Site: same-origin/same-site/none, or an Origin in the
// loopback set, so a same-Host POST from a foreign page on the same
// machine still gets blocked.
export function localOnly(opts: LocalOnlyOptions) {
  const hosts = allowedHosts(opts.port);
  const origins = new Set([...allowedOrigins(opts.port), ...(opts.extraOrigins ?? [])]);
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host;
    if (!host || !hosts.has(host)) {
      logger.warn({ host, path: req.path }, 'rejected non-loopback host');
      res.status(403).json({ error: 'forbidden_host' });
      return;
    }

    if (!SAFE_METHODS.has(req.method)) {
      const sfs = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      const sfsOk = sfs === 'same-origin' || sfs === 'same-site' || sfs === 'none';
      const originOk = typeof origin === 'string' && origins.has(origin);
      // Browsers always send Sec-Fetch-Site on modern Chromium/Firefox/Safari.
      // Non-browser clients (curl, our own Tauri shell calling /api/control/*)
      // send no Origin and no Sec-Fetch-Site; allow that case since the Host
      // check already proved the request reached our loopback socket.
      const isBrowser = typeof origin === 'string' || typeof sfs === 'string';
      if (isBrowser && !sfsOk && !originOk) {
        logger.warn(
          { method: req.method, path: req.path, origin, sfs },
          'rejected cross-site mutation',
        );
        res.status(403).json({ error: 'forbidden_origin' });
        return;
      }
    }

    next();
  };
}
