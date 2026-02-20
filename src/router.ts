/**
 * router.ts — Lightweight hash-based router for the application.
 *
 * Centralises route parsing, navigation, and hashchange handling that was
 * previously scattered across main.ts.  The API is intentionally thin so it
 * can be swapped to preact-router once all views have been migrated to Preact
 * components (Phases 5d–5f).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ViewName = 'admin' | 'divergence' | 'breadth';

export type Route = { kind: 'view'; view: ViewName } | { kind: 'ticker'; ticker: string };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseHash(hash: string): Route | null {
  const raw = (hash || '').replace(/^#\/?/, '').trim();
  if (!raw) return null;

  // #/ticker/AAPL  or  #/ticker/AAPL/
  const tickerMatch = raw.match(/^ticker\/([A-Za-z0-9._-]+)\/?$/);
  if (tickerMatch) return { kind: 'ticker', ticker: tickerMatch[1].toUpperCase() };

  // #/divergence, #/admin, #/breadth   (#/logs → admin for backward compat)
  const viewName = raw.replace(/\/$/, '').toLowerCase();
  if (viewName === 'logs') return { kind: 'view', view: 'admin' };
  if (viewName === 'divergence' || viewName === 'admin' || viewName === 'breadth') {
    return { kind: 'view', view: viewName };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** True while we're responding to a hashchange — prevents re-entrant pushHash. */
let hashNavInProgress = false;

export function setHashNavInProgress(v: boolean): void {
  hashNavInProgress = v;
}

export function pushHash(hash: string): void {
  if (hashNavInProgress) return;
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash !== target) {
    history.pushState(null, '', target);
  }
}

/**
 * Navigate programmatically.  Optionally skip the URL push (e.g. when we're
 * already reacting to a hashchange event).
 */
export function navigate(path: string, { skipPush = false } = {}): void {
  if (!skipPush) pushHash(path);
}

// ---------------------------------------------------------------------------
// Route change subscriptions
// ---------------------------------------------------------------------------

type RouteHandler = (route: Route) => void;
const listeners: RouteHandler[] = [];

export function onRouteChange(handler: RouteHandler): () => void {
  listeners.push(handler);
  return () => {
    const idx = listeners.indexOf(handler);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notifyListeners(route: Route): void {
  for (const fn of listeners) {
    try {
      fn(route);
    } catch (err) {
      console.error('Route handler error:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// hashchange listener (installed once)
// ---------------------------------------------------------------------------

let installed = false;

export function installHashListener(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('hashchange', () => {
    const route = parseHash(window.location.hash);
    if (!route) return;
    hashNavInProgress = true;
    try {
      notifyListeners(route);
    } finally {
      hashNavInProgress = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Initial route
// ---------------------------------------------------------------------------

export function getInitialRoute(): Route {
  return parseHash(window.location.hash) ?? { kind: 'view', view: 'divergence' };
}
