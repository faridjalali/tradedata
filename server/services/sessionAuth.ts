import crypto from 'crypto';
import type { Request, Response } from 'express';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const COOKIE_NAME = 'catvue_session';

const activeSessions = new Map<string, number>();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(): string {
  const token = generateToken();
  activeSessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function validateSession(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const expiresAt = activeSessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token: string | null | undefined): void {
  if (token) activeSessions.delete(token);
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, expiresAt] of activeSessions) {
    if (now > expiresAt) activeSessions.delete(token);
  }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

function parseCookieValue(req: Request): string | null {
  const header = String(req.headers.cookie || '');
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match ? match[1] : null;
}

function setSessionCookie(res: Response, token: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function getActiveSessionCount(): number {
  return activeSessions.size;
}

export {
  COOKIE_NAME,
  createSession,
  validateSession,
  destroySession,
  cleanupExpiredSessions,
  parseCookieValue,
  setSessionCookie,
  clearSessionCookie,
  getActiveSessionCount,
};
