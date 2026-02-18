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

import crypto from 'crypto';
import { SESSION_SECRET } from '../config.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_NAME = 'catvue_session';

function sign(payload: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function timingSafeStrEqual(a: string, b: string): boolean {
  // Both are hex strings from the same HMAC → always equal length when valid.
  // Pad shorter string to avoid length-leaking side channel.
  const len = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(len);
  const bufB = Buffer.alloc(len);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSession(): string {
  const expiresAt = (Date.now() + SESSION_TTL_MS).toString(16);
  const sig = sign(expiresAt);
  return `${expiresAt}.${sig}`;
}

export function validateSession(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(payload);
  if (!timingSafeStrEqual(providedSig, expectedSig)) return false;
  const expiresAt = parseInt(payload, 16);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  return true;
}

/** No-op for stateless tokens — expiry is encoded in the token itself. */
export function destroySession(_token: string | null | undefined): void {
  // Nothing to do — client clears the cookie via clearSessionCookie().
}

export function parseCookieValue(req: { headers: { cookie?: string } }): string | null {
  const header = String(req.headers.cookie || '');
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match ? match[1] : null;
}

export function setSessionCookie(reply: { header: (name: string, value: string) => any }, token: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.header('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

export function clearSessionCookie(reply: { header: (name: string, value: string) => any }): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export { COOKIE_NAME };
