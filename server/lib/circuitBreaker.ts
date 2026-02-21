/**
 * Circuit Breaker — prevents cascading failures when the external data API
 * is down or degraded.  Three states:
 *
 *   CLOSED   → normal operation, requests pass through
 *   OPEN     → API assumed down, requests rejected immediately
 *   HALF_OPEN → cooldown elapsed, allow ONE probe request through
 *
 * Only infrastructure failures (timeouts, 5xx) trip the breaker.
 * Rate-limit (429), subscription (403), abort, and paused errors are
 * forwarded transparently — they are business-level, not outage signals.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit. Default 5. */
  failureThreshold?: number;
  /** Milliseconds to stay OPEN before probing (HALF_OPEN). Default 30 000. */
  cooldownMs?: number;
  /** Classify an error as infrastructure failure (trips breaker). */
  isInfraError?: (err: unknown) => boolean;
  /** Called whenever the circuit state transitions. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureMs = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly isInfraError: (err: unknown) => boolean;
  private readonly onStateChange: ((from: CircuitState, to: CircuitState) => void) | null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 30_000);
    this.isInfraError = options.isInfraError ?? (() => true);
    this.onStateChange = options.onStateChange ?? null;
  }

  getState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  getInfo(): { state: CircuitState; consecutiveFailures: number; cooldownRemainingMs: number } {
    this.evaluateState();
    const remaining = this.state === 'OPEN' ? Math.max(0, this.cooldownMs - (Date.now() - this.lastFailureMs)) : 0;
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      cooldownRemainingMs: Math.round(remaining),
    };
  }

  /** Wrap an async operation with circuit-breaker protection. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.evaluateState();

    if (this.state === 'OPEN') {
      throw new CircuitOpenError(this.cooldownRemainingMs());
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onError(err);
      throw err;
    }
  }

  /** Reset the breaker to CLOSED (e.g. on manual intervention). */
  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureMs = 0;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private evaluateState(): void {
    if (this.state === 'OPEN' && Date.now() - this.lastFailureMs >= this.cooldownMs) {
      this.onStateChange?.('OPEN', 'HALF_OPEN');
      this.state = 'HALF_OPEN';
    }
  }

  private onSuccess(): void {
    const prev = this.state;
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    if (prev !== 'CLOSED') this.onStateChange?.(prev, 'CLOSED');
  }

  private onError(err: unknown): void {
    if (!this.isInfraError(err)) return; // Business error — don't trip.

    this.consecutiveFailures++;
    this.lastFailureMs = Date.now();

    if (this.consecutiveFailures >= this.failureThreshold && this.state !== 'OPEN') {
      const prev = this.state;
      this.state = 'OPEN';
      this.onStateChange?.(prev, 'OPEN');
    }
  }

  private cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownMs - (Date.now() - this.lastFailureMs));
  }
}

/** Thrown when the circuit is OPEN and a request is rejected without calling the API. */
export class CircuitOpenError extends Error {
  readonly cooldownRemainingMs: number;
  readonly httpStatus = 503;

  constructor(cooldownRemainingMs: number) {
    super(`Circuit breaker is OPEN — API requests blocked for ${Math.ceil(cooldownRemainingMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}
