import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import logger from './logger.js';
import * as schemas from './schemas.js';
import {
  BASIC_AUTH_ENABLED, BASIC_AUTH_USERNAME, BASIC_AUTH_PASSWORD, BASIC_AUTH_REALM,
} from './config.js';


export function logStructured(level: string, event: string, fields: Record<string, unknown> = {}) {
  const pinoLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[pinoLevel]({ event, ...fields });
}


export function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(8).toString('hex');
}


export function shouldLogRequestPath(pathname: string) {
  const path = String(pathname || '');
  if (path.startsWith('/api/')) return true;
  return path === '/healthz' || path === '/readyz';
}


export function extractSafeRequestMeta(req: FastifyRequest) {
  const path = String(req.url?.split('?')[0] || '');
  const queryKeys = Object.keys((req.query as Record<string, unknown>) || {});
  const meta = {
    method: req.method,
    path,
    queryKeys,
  };
  if (path.startsWith('/api/chart')) {
    const q = req.query as Record<string, unknown>;
    const ticker = typeof q?.ticker === 'string' ? q.ticker : null;
    const interval = typeof q?.interval === 'string' ? q.interval : null;
    return { ...meta, ticker, interval };
  }
  return meta;
}


export function isValidTickerSymbol(value: unknown) {
  return schemas.tickerSymbol.safeParse(value).success;
}


export function parseEtDateInput(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const result = schemas.etDate.safeParse(value);
  return result.success ? result.data : null;
}


export function parseBooleanInput(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const result = schemas.booleanInput.safeParse(value);
  return result.success ? result.data : fallback;
}


export function validateChartPayloadShape(payload: unknown) {
  const result = schemas.chartPayload.safeParse(payload);
  if (result.success) return { ok: true as const };
  const firstIssue = result.error.issues[0];
  return { ok: false as const, error: firstIssue ? firstIssue.message : 'Invalid chart payload shape' };
}


export function validateChartLatestPayloadShape(payload: unknown) {
  const result = schemas.chartLatestPayload.safeParse(payload);
  if (result.success) return { ok: true as const };
  const firstIssue = result.error.issues[0];
  return { ok: false as const, error: firstIssue ? firstIssue.message : 'Invalid latest payload shape' };
}


export function timingSafeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}


export async function basicAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  if (!BASIC_AUTH_ENABLED || request.method === 'OPTIONS') {
    return;
  }

  const authHeader = String(request.headers.authorization || '');
  if (!authHeader.startsWith('Basic ')) {
    reply.header('WWW-Authenticate', `Basic realm="${BASIC_AUTH_REALM}"`);
    return reply.code(401).send('Authentication required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';

  const validUsername = timingSafeStringEqual(username, BASIC_AUTH_USERNAME);
  const validPassword = timingSafeStringEqual(password, BASIC_AUTH_PASSWORD);
  if (!validUsername || !validPassword) {
    reply.header('WWW-Authenticate', `Basic realm="${BASIC_AUTH_REALM}"`);
    return reply.code(401).send('Invalid credentials');
  }
}
