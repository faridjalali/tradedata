/**
 * Pure error-classification predicates.
 *
 * Kept in lib/ so utilities like mapWithConcurrency can depend on them
 * without creating a lib → services dependency cycle.
 */

/**
 * Returns true if `err` represents a request-abort signal: an AbortError by
 * name, an HTTP 499 status, or an error message containing "aborted" /
 * "aborterror" (case-insensitive).
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const name = String(e.name || '');
  const message = String(e.message || err || '');
  return name === 'AbortError' || Number(e.httpStatus) === 499 || /aborted|aborterror/i.test(message);
}
