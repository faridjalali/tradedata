interface AuthAttemptState {
  failures: number;
  nextAllowedAtMs: number;
  lockedUntilMs: number;
  lastFailureAtMs: number;
}

const ATTEMPT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_THRESHOLD = 10;
const LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const attemptsByKey = new Map<string, AuthAttemptState>();

function nowMs(): number {
  return Date.now();
}

function pruneExpired(now = nowMs()): void {
  for (const [key, state] of attemptsByKey) {
    const expired = now - state.lastFailureAtMs > ATTEMPT_TTL_MS;
    const inactive = state.failures <= 0 && state.lockedUntilMs <= now;
    if (expired || inactive) {
      attemptsByKey.delete(key);
    }
  }
}

function getOrCreateState(key: string): AuthAttemptState {
  const existing = attemptsByKey.get(key);
  if (existing) return existing;
  const initial: AuthAttemptState = {
    failures: 0,
    nextAllowedAtMs: 0,
    lockedUntilMs: 0,
    lastFailureAtMs: 0,
  };
  attemptsByKey.set(key, initial);
  return initial;
}

export function isAuthAttemptAllowed(key: string): { allowed: boolean; retryAfterMs: number } {
  const now = nowMs();
  pruneExpired(now);
  const state = attemptsByKey.get(key);
  if (!state) return { allowed: true, retryAfterMs: 0 };

  if (state.lockedUntilMs > now) {
    return { allowed: false, retryAfterMs: state.lockedUntilMs - now };
  }
  if (state.nextAllowedAtMs > now) {
    return { allowed: false, retryAfterMs: state.nextAllowedAtMs - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function recordAuthFailure(key: string): void {
  const now = nowMs();
  const state = getOrCreateState(key);
  state.failures += 1;
  state.lastFailureAtMs = now;

  const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, state.failures - 1));
  state.nextAllowedAtMs = now + backoffMs;

  if (state.failures >= LOCK_THRESHOLD) {
    state.lockedUntilMs = now + LOCK_WINDOW_MS;
  }
}

export function clearAuthFailures(key: string): void {
  attemptsByKey.delete(key);
}

export function getAuthAttemptKey(ip: string, userAgent: string | undefined): string {
  return `${String(ip || 'unknown')}:${String(userAgent || '')
    .trim()
    .toLowerCase()}`;
}
