/**
 * Session management with Redis support and in-memory fallback.
 *
 * When REDIS_URL is configured and Redis is reachable, sessions are stored in
 * Redis for horizontal scalability.  When Redis is unavailable (e.g. local dev
 * without Docker), sessions transparently fall back to an in-memory Map.
 */

import { v4 as uuidv4 } from 'uuid';
import { Redis } from 'ioredis';

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const COOKIE_NAME = 'catvue_session';

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

export async function createSession(): Promise<string> {
  const token = uuidv4();

  if (redis && redisReady) {
    try {
      await redis.setex(`session:${token}`, SESSION_TTL_SECONDS, Date.now().toString());
      return token;
    } catch {
      // Redis write failed — fall through to memory store
    }
  }

  memoryStore.set(token, Date.now() + SESSION_TTL_SECONDS * 1000);
  return token;
}

export async function validateSession(token: string | null | undefined): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;

  if (redis && redisReady) {
    try {
      const exists = await redis.exists(`session:${token}`);
      return exists === 1;
    } catch {
      // Redis read failed — fall through to memory store
    }
  }

  pruneExpired();
  return memoryStore.has(token);
}

export async function destroySession(token: string | null | undefined): Promise<void> {
  if (!token || typeof token !== 'string') return;

  if (redis && redisReady) {
    try {
      await redis.del(`session:${token}`);
    } catch {
      // Ignore Redis errors on destroy
    }
  }

  memoryStore.delete(token);
}

export function parseCookieValue(req: { headers: { cookie?: string } }): string | null {
  const header = String(req.headers.cookie || '');
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match ? match[1] : null;
}

export function setSessionCookie(reply: { header: (name: string, value: string) => any }, token: string): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`);
}

export function clearSessionCookie(reply: { header: (name: string, value: string) => any }): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export { COOKIE_NAME };
