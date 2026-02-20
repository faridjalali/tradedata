export type ViewName = 'admin' | 'divergence' | 'breadth';

export type AppRoute = { kind: 'view'; view: ViewName } | { kind: 'ticker'; ticker: string };

const TICKER_PATTERN = /^\/ticker\/([A-Za-z0-9._-]+)\/?$/;

export function parseAppRoutePath(pathname: string): AppRoute {
  const trimmed = String(pathname || '').trim();
  const normalized = trimmed ? (trimmed.startsWith('/') ? trimmed : `/${trimmed}`) : '/divergence';
  const cleanPath = normalized.replace(/\/+$/, '') || '/';

  const tickerMatch = cleanPath.match(TICKER_PATTERN);
  if (tickerMatch) {
    return { kind: 'ticker', ticker: tickerMatch[1].toUpperCase() };
  }

  if (cleanPath === '/logs') return { kind: 'view', view: 'admin' };
  if (cleanPath === '/admin' || cleanPath === '/divergence' || cleanPath === '/breadth') {
    return { kind: 'view', view: cleanPath.slice(1) as ViewName };
  }

  return { kind: 'view', view: 'divergence' };
}

export function viewPath(view: ViewName): string {
  return `/${view}`;
}

export function tickerPath(ticker: string): string {
  const normalized = String(ticker || '')
    .trim()
    .toUpperCase();
  return `/ticker/${normalized}`;
}
