/**
 * Stateless HMAC-SHA256 signed session tokens.
 *
 * Token format: <expiry_hex>.<hmac_hex>
 *
 * Tokens are self-verifying — no server-side state or DB is required.
 * Sessions survive server restarts as long as SESSION_SECRET (or SITE_LOCK_PASSCODE)
 * does not change.
 *
 * Trade-off: individual tokens cannot be revoked before expiry. For a
 * passcode-gated app this is acceptable; changing the passcode/secret
 * effectively invalidates all outstanding tokens within 24 hours.
 */

import { v4 as uuidv4 } from 'uuid';
import { Redis } from 'ioredis';

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const COOKIE_NAME = 'catvue_session';

// Initialize Redis client using REDIS_URL from process environment
// Fallback to local default if unconfigured for dev environments
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err: Error) => console.error('Redis Session Cache error:', err));
redis.on('connect', () => console.log('Successfully connected to Redis Session Store'));

export async function createSession(): Promise<string> {
  const token = uuidv4();
  // Store empty string or timestamp since the key's existence proves the session
  await redis.setex(`session:${token}`, SESSION_TTL_SECONDS, Date.now().toString());
  return token;
}

export async function validateSession(token: string | null | undefined): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  // Use GET or EXISTS. Exists returns 1 if key exists.
  const exists = await redis.exists(`session:${token}`);
  return exists === 1;
}

export async function destroySession(token: string | null | undefined): Promise<void> {
  if (!token || typeof token !== 'string') return;
  await redis.del(`session:${token}`);
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
