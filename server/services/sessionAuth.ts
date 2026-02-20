/**
 * Session management with Redis support and in-memory fallback.
 *
 * When REDIS_URL is configured and Redis is reachable, sessions are stored in
 * Redis for horizontal scalability.  When Redis is unavailable (e.g. local dev
 * without Docker), sessions transparently fall back to an in-memory Map.
 */

import { v4 as uuidv4 } from 'uuid';
import { Redis } from 'ioredis';
import crypto from 'crypto';
import { SESSION_SECRET, SESSION_COOKIE_SECURE } from '../config.js';
import { timingSafeStringEqual } from '../middleware.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const COOKIE_NAME = SESSION_COOKIE_SECURE ? '__Host-catvue_session' : 'catvue_session';

// ---------------------------------------------------------------------------
// Redis client (best-effort connection)
// ---------------------------------------------------------------------------

let redisReady = false;
let redis: Redis | null = null;

try {
  redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      // Stop retrying after the first failure to avoid blocking startup
      if (times > 1) return null;
      return 200;
    },
    lazyConnect: false,
    enableOfflineQueue: false,
  });

  redis.on('connect', () => {
    redisReady = true;
    console.log('Successfully connected to Redis Session Store');
  });

  redis.on('error', (err: Error) => {
    if (redisReady) console.error('Redis Session Cache error:', err);
    redisReady = false;
  });

  redis.on('close', () => {
    redisReady = false;
  });
} catch {
  console.warn('Redis unavailable — using in-memory session store');
  redis = null;
}

// ---------------------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, number>(); // token → expiresAtMs

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, exp] of memoryStore) {
    if (exp <= now) memoryStore.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function signSessionId(sessionId: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
}

function createSignedToken(sessionId: string): string {
  return `${sessionId}.${signSessionId(sessionId)}`;
}

function parseAndValidateToken(token: string | null | undefined): string | null {
  const raw = String(token || '').trim();
  if (!raw || !SESSION_SECRET) return null;
  const [sessionId, signature] = raw.split('.');
  if (!sessionId || !signature) return null;
  const expectedSignature = signSessionId(sessionId);
  if (!timingSafeStringEqual(signature, expectedSignature)) return null;
  return sessionId;
}

export async function createSession(): Promise<string> {
  const sessionId = uuidv4();
  const token = createSignedToken(sessionId);

  if (redis && redisReady) {
    try {
      await redis.setex(`session:${sessionId}`, SESSION_TTL_SECONDS, Date.now().toString());
      return token;
    } catch {
      // Redis write failed — fall through to memory store
    }
  }

  memoryStore.set(sessionId, Date.now() + SESSION_TTL_SECONDS * 1000);
  return token;
}

export async function validateSession(token: string | null | undefined): Promise<boolean> {
  const sessionId = parseAndValidateToken(token);
  if (!sessionId) return false;

  if (redis && redisReady) {
    try {
      const exists = await redis.exists(`session:${sessionId}`);
      return exists === 1;
    } catch {
      // Redis read failed — fall through to memory store
    }
  }

  pruneExpired();
  return memoryStore.has(sessionId);
}

export async function destroySession(token: string | null | undefined): Promise<void> {
  const sessionId = parseAndValidateToken(token);
  if (!sessionId) return;

  if (redis && redisReady) {
    try {
      await redis.del(`session:${sessionId}`);
    } catch {
      // Ignore Redis errors on destroy
    }
  }

  memoryStore.delete(sessionId);
}

export function parseCookieValue(req: { headers: { cookie?: string } }): string | null {
  const header = String(req.headers.cookie || '');
  const names = [COOKIE_NAME, 'catvue_session'];
  let encodedValue: string | null = null;
  for (const name of names) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (match) {
      encodedValue = match[1];
      break;
    }
  }
  if (!encodedValue) return null;
  try {
    return decodeURIComponent(encodedValue);
  } catch {
    return null;
  }
}

export function setSessionCookie(reply: { header: (name: string, value: string) => unknown }, token: string): void {
  const encodedToken = encodeURIComponent(token);
  const secureSegment = SESSION_COOKIE_SECURE ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodedToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Priority=High${secureSegment}`,
  );
}

export function clearSessionCookie(reply: { header: (name: string, value: string) => unknown }): void {
  const secureSegment = SESSION_COOKIE_SECURE ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Priority=High${secureSegment}`,
  );
}

export { COOKIE_NAME };
