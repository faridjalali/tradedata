import type { FastifyInstance } from 'fastify';
import { timingSafeStringEqual } from '../middleware.js';
import {
  getAuthAttemptKey,
  isAuthAttemptAllowed,
  recordAuthFailure,
  clearAuthFailures,
} from '../services/authRateLimit.js';

interface SessionAuthApi {
  createSession: () => Promise<string>;
  setSessionCookie: (reply: { header: (name: string, value: string) => unknown }, token: string) => void;
  parseCookieValue: (request: { headers: { cookie?: string } }) => string | null;
  validateSession: (token: string | null | undefined) => Promise<boolean>;
  destroySession: (token: string | null | undefined) => Promise<void>;
  clearSessionCookie: (reply: { header: (name: string, value: string) => unknown }) => void;
}

interface RegisterAuthRoutesOptions {
  app: FastifyInstance;
  siteLockEnabled: boolean;
  siteLockPasscode: string;
  sessionAuth: SessionAuthApi;
}

export function registerAuthRoutes(options: RegisterAuthRoutesOptions): void {
  const { app, siteLockEnabled, siteLockPasscode, sessionAuth } = options;

  app.post('/api/auth/verify', async (request, reply) => {
    const attemptKey = getAuthAttemptKey(request.ip, request.headers['user-agent']);
    const allowed = isAuthAttemptAllowed(attemptKey);
    if (!allowed.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(allowed.retryAfterMs / 1000));
      reply.header('Retry-After', String(retryAfterSeconds));
      return reply.code(429).send({ error: 'Too many attempts', retryAfterSeconds });
    }

    const passcode = String((request.body as Record<string, unknown>)?.passcode || '').trim();
    if (!siteLockEnabled || !passcode) {
      recordAuthFailure(attemptKey);
      return reply.code(401).send({ error: 'Invalid passcode' });
    }
    if (!timingSafeStringEqual(passcode, siteLockPasscode)) {
      recordAuthFailure(attemptKey);
      return reply.code(401).send({ error: 'Invalid passcode' });
    }

    clearAuthFailures(attemptKey);
    const token = await sessionAuth.createSession();
    sessionAuth.setSessionCookie(reply, token);
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/api/auth/check', async (request, reply) => {
    if (!siteLockEnabled) return reply.code(200).send({ status: 'ok' });
    const token = sessionAuth.parseCookieValue(request);
    const isValid = await sessionAuth.validateSession(token);
    if (isValid) {
      return reply.code(200).send({ status: 'ok' });
    }
    return reply.code(401).send({ error: 'Not authenticated' });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionAuth.parseCookieValue(request);
    await sessionAuth.destroySession(token);
    sessionAuth.clearSessionCookie(reply);
    return reply.code(200).send({ status: 'ok' });
  });
}
