import type { CustomHistory, Location } from 'preact-router';

function parseHashLocation(hash: string): Location {
  const raw = String(hash || '').replace(/^#/, '');
  const withSlash = raw.startsWith('/') ? raw : raw ? `/${raw}` : '/divergence';
  const queryIndex = withSlash.indexOf('?');
  if (queryIndex === -1) {
    return { pathname: withSlash || '/divergence', search: '' };
  }
  return {
    pathname: withSlash.slice(0, queryIndex) || '/divergence',
    search: withSlash.slice(queryIndex),
  };
}

function currentLocation(): Location {
  return parseHashLocation(window.location.hash);
}

function normalizePath(path: string): string {
  const raw = String(path || '').trim();
  if (!raw) return '/divergence';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export const hashHistory: CustomHistory = {
  listen(callback) {
    const handler = () => callback(currentLocation());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  },
  get location() {
    return currentLocation();
  },
  push(path) {
    const normalized = normalizePath(path);
    const targetHash = `#${normalized}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
  },
  replace(path) {
    const normalized = normalizePath(path);
    const targetHash = `#${normalized}`;
    if (window.location.hash === targetHash) return;
    const base = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, '', `${base}${targetHash}`);
  },
};
