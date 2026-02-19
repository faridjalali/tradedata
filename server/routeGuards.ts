import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeStringEqual } from './middleware.js';

/**
 * Check a debug-metrics secret from query param or header.
 * Returns true if the caller is authorized (or no secret is configured).
 */
export function checkDebugSecret(
  req: FastifyRequest,
  configuredSecret: string | undefined,
  headerName = 'x-debug-secret',
): boolean {
  const trimmed = String(configuredSecret || '').trim();
  if (!trimmed) return true; // no secret configured → open
  const provided = String(
    (req.query as Record<string, string | undefined>).secret || req.headers[headerName] || '',
  ).trim();
  return timingSafeStringEqual(provided, trimmed);
}

/**
 * Guard helper: sends 401/403 and returns true if unauthorized.
 * Usage:  if (rejectUnauthorized(req, res, secret)) return;
 */
export function rejectUnauthorized(
  req: FastifyRequest,
  res: FastifyReply,
  configuredSecret: string | undefined,
  options?: { headerName?: string; statusCode?: 401 | 403 },
): boolean {
  if (checkDebugSecret(req, configuredSecret, options?.headerName)) return false;
  const code = options?.statusCode ?? 401;
  res.code(code).send({ error: code === 403 ? 'Forbidden' : 'Unauthorized' });
  return true;
}
