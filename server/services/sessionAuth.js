import crypto from 'crypto';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const COOKIE_NAME = 'catvue_session';

/** token → expiresAt (unix ms) */
const activeSessions = new Map();

/** Generate a cryptographically random 64-character hex token. */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a new session and return the token.
 * @returns {string} Session token
 */
function createSession() {
  const token = generateToken();
  activeSessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

/**
 * Check whether a session token is valid and not expired.
 * @param {string|null|undefined} token
 * @returns {boolean}
 */
function validateSession(token) {
  if (!token || typeof token !== 'string') return false;
  const expiresAt = activeSessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

/**
 * Immediately invalidate a session token.
 * @param {string|null|undefined} token
 */
function destroySession(token) {
  if (token) activeSessions.delete(token);
}

/** Remove all expired sessions from the active map. */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of activeSessions) {
    if (now > expiresAt) activeSessions.delete(token);
  }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

/**
 * Extract the session cookie value from an HTTP request.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function parseCookieValue(req) {
  const header = String(req.headers.cookie || '');
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match ? match[1] : null;
}

/**
 * Set the session cookie on an HTTP response.
 * @param {import('express').Response} res
 * @param {string} token
 */
function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}

/**
 * Clear the session cookie on an HTTP response.
 * @param {import('express').Response} res
 */
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

/** @returns {number} Number of currently active sessions */
function getActiveSessionCount() {
  return activeSessions.size;
}

export { COOKIE_NAME, createSession, validateSession, destroySession, cleanupExpiredSessions, parseCookieValue, setSessionCookie, clearSessionCookie, getActiveSessionCount };
