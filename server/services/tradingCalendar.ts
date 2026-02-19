/**
 * Trading Calendar — hybrid approach using SPY daily bars (historical proof)
 * and the /v1/marketstatus/upcoming endpoint (future holidays / early closes).
 *
 * Falls back to weekday-only logic if API is unreachable or not configured.
 */

const defaultLog = console.log.bind(console);

const HISTORICAL_LOOKBACK_DAYS = 900; // ~2.5 years
const FUTURE_PROJECTION_DAYS = 365; // 1 year ahead
const REFRESH_HOUR_ET = 5; // 5:00 AM ET daily refresh

/** YYYY-MM-DD keys of confirmed trading days */
let tradingDays: Set<string> = new Set();

/** YYYY-MM-DD → close time (e.g. "13:00") for early-close days */
let earlyCloses: Map<string, string> = new Map();

let calendarRangeStart = '';
let calendarRangeEnd = '';
let initialized = false;
let lastRefreshedAt = '';
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

interface CalendarDeps {
  /** Fetches JSON from the data API */
  fetchDataApiJson: Function;
  /** Builds a data API URL with query params */
  buildDataApiUrl: Function;
  /** Formats Date as YYYY-MM-DD */
  formatDateUTC: Function;
  /** Logger function (defaults to console.log) */
  log?: Function;
}

let savedDeps: Partial<CalendarDeps> = {};

// ---------------------------------------------------------------------------
// Date helpers (self-contained, no external deps)
// ---------------------------------------------------------------------------

function toDateStr(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function isWeekday(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * Convert Unix ms timestamp to ET date string YYYY-MM-DD
 */
function unixMsToEtDateStr(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * All weekday date strings between start and end (inclusive)
 */
function weekdaysBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let cursor = start;
  for (let i = 0; i < 1500 && cursor <= end; i++) {
    if (isWeekday(cursor)) result.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fallback (replicates current weekday-only behavior)
// ---------------------------------------------------------------------------

function fallbackPreviousTradingDay(dateStr: string): string {
  let cursor = addDays(dateStr, -1);
  for (let i = 0; i < 15; i++) {
    if (isWeekday(cursor)) return cursor;
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

function fallbackNextTradingDay(dateStr: string): string {
  let cursor = addDays(dateStr, 1);
  for (let i = 0; i < 15; i++) {
    if (isWeekday(cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a given date is a trading day.
 * Falls back to weekday check when calendar is not initialized.
 */
function isTradingDay(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  if (!initialized) return isWeekday(dateStr);
  if (dateStr >= calendarRangeStart && dateStr <= calendarRangeEnd) {
    return tradingDays.has(dateStr);
  }
  // Outside known range — fall back to weekday check
  return isWeekday(dateStr);
}

/**
 * Check whether a given date is an early-close trading day.
 */
function isEarlyClose(dateStr: string): boolean {
  if (!initialized) return false;
  return earlyCloses.has(dateStr);
}

/**
 * Get the ET close time for a trading day.
 * @returns Close time string (e.g. "16:00", "13:00"), or null if not a trading day
 */
function getCloseTimeEt(dateStr: string): string | null {
  if (!isTradingDay(dateStr)) return null;
  if (earlyCloses.has(dateStr)) return earlyCloses.get(dateStr) as string;
  return '16:00';
}

/**
 * Find the most recent trading day before the given date.
 */
function previousTradingDay(dateStr: string): string {
  if (!initialized) return fallbackPreviousTradingDay(dateStr);
  let cursor = addDays(dateStr, -1);
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cursor)) return cursor;
    cursor = addDays(cursor, -1);
  }
  return fallbackPreviousTradingDay(dateStr);
}

/**
 * Find the next trading day after the given date.
 */
function nextTradingDay(dateStr: string): string {
  if (!initialized) return fallbackNextTradingDay(dateStr);
  let cursor = addDays(dateStr, 1);
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return fallbackNextTradingDay(dateStr);
}

/**
 * Get all trading days between two dates (inclusive).
 */
function getTradingDaysBetween(start: string, end: string): string[] {
  if (!initialized) return weekdaysBetween(start, end);
  const result: string[] = [];
  let cursor = start;
  for (let i = 0; i < 1500 && cursor <= end; i++) {
    if (isTradingDay(cursor)) result.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return result;
}

/**
 * Get the current calendar status for diagnostics.
 */
function getStatus(): { initialized: boolean; tradingDaysCount: number; earlyClosesCount: number; rangeStart: string; rangeEnd: string; lastRefreshedAt: string } {
  return {
    initialized,
    tradingDaysCount: tradingDays.size,
    earlyClosesCount: earlyCloses.size,
    rangeStart: calendarRangeStart,
    rangeEnd: calendarRangeEnd,
    lastRefreshedAt,
  };
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchHistoricalTradingDays(deps: CalendarDeps) {
  const { fetchDataApiJson, buildDataApiUrl, formatDateUTC, log = defaultLog } = deps;
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - HISTORICAL_LOOKBACK_DAYS);

  const fromStr = formatDateUTC(start);
  const toStr = formatDateUTC(end);
  log(`Fetching SPY daily bars ${fromStr} → ${toStr}`);

  const url = buildDataApiUrl(`/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}`, {
    adjusted: 'true',
    sort: 'asc',
    limit: 50000,
  });

  const data = await fetchDataApiJson(url, 'TradingCalendar-SPY');
  const results = (data && data.results) || [];
  const dates: Set<string> = new Set();
  for (const bar of results) {
    const ts = bar.t;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      dates.add(unixMsToEtDateStr(ts));
    }
  }

  log(`SPY returned ${dates.size} trading days from ${results.length} bars`);
  return { dates, fromStr, toStr };
}

async function fetchUpcomingHolidays(deps: CalendarDeps) {
  const { fetchDataApiJson, buildDataApiUrl, log = defaultLog } = deps;
  log('Fetching upcoming market status');

  const url = buildDataApiUrl('/v1/marketstatus/upcoming', {});
  const data = await fetchDataApiJson(url, 'TradingCalendar-upcoming');
  const entries = Array.isArray(data) ? data : [];

  const holidays: Set<string> = new Set();
  const eCloses: Map<string, string> = new Map();

  for (const entry of entries) {
    const date = String(entry.date || '').trim();
    const status = String(entry.status || '').toLowerCase();
    if (!date || date.length !== 10) continue;

    if (status === 'closed') {
      holidays.add(date);
    } else if (status === 'early-close') {
      eCloses.set(date, String(entry.close || '13:00'));
    }
  }

  log(`Upcoming: ${holidays.size} holidays, ${eCloses.size} early closes`);
  return { holidays, eCloses };
}

// ---------------------------------------------------------------------------
// Calendar construction
// ---------------------------------------------------------------------------

function buildCalendar(
  historical: { dates: Set<string>; fromStr: string; toStr: string },
  upcoming: { holidays: Set<string>; eCloses: Map<string, string> },
) {
  const todayStr = unixMsToEtDateStr(Date.now());

  // Range: from historical start to 1 year from now
  const futureEnd = new Date();
  futureEnd.setUTCDate(futureEnd.getUTCDate() + FUTURE_PROJECTION_DAYS);
  const rangeStart = historical.fromStr;
  const rangeEnd = toDateStr(futureEnd.getUTCFullYear(), futureEnd.getUTCMonth() + 1, futureEnd.getUTCDate());

  const allTradingDays: Set<string> = new Set();
  const allEarlyCloses: Map<string, string> = new Map();

  // Generate all weekdays in range
  const allWeekdays = weekdaysBetween(rangeStart, rangeEnd);

  for (const day of allWeekdays) {
    if (day < todayStr) {
      // Historical: only include if SPY had a bar
      if (historical.dates.has(day)) {
        allTradingDays.add(day);
      }
    } else {
      // Today/future: include unless listed as closed
      if (!upcoming.holidays.has(day)) {
        allTradingDays.add(day);
      }
    }
  }

  // Mark early closes (only for future/today dates)
  for (const [date, closeTime] of upcoming.eCloses) {
    if (allTradingDays.has(date)) {
      allEarlyCloses.set(date, closeTime);
    }
  }

  return { tradingDays: allTradingDays, earlyCloses: allEarlyCloses, rangeStart, rangeEnd };
}

// ---------------------------------------------------------------------------
// Refresh scheduling
// ---------------------------------------------------------------------------

function scheduleRefresh(deps: CalendarDeps): void {
  if (refreshTimer) clearTimeout(refreshTimer);

  // Schedule for 5:00 AM ET tomorrow
  const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nextRefresh = new Date(nowEt);
  nextRefresh.setDate(nextRefresh.getDate() + 1);
  nextRefresh.setHours(REFRESH_HOUR_ET, 0, 0, 0);

  // Convert back to UTC delay
  const delayMs = Math.max(60000, nextRefresh.getTime() - nowEt.getTime());

  refreshTimer = setTimeout(async () => {
    const log = deps.log || defaultLog;
    try {
      log('Daily refresh starting');
      await refreshCalendar(deps);
      log('Daily refresh complete');
    } catch (err: unknown) {
      log(`Daily refresh failed (keeping stale data): ${err instanceof Error ? err.message : String(err)}`);
    }
    scheduleRefresh(deps);
  }, delayMs);

  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

async function refreshCalendar(deps: CalendarDeps): Promise<void> {
  const [historical, upcoming] = await Promise.all([
    fetchHistoricalTradingDays(deps),
    fetchUpcomingHolidays(deps).catch((err: unknown) => {
      const log = deps.log || defaultLog;
      log(`Upcoming holidays fetch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { holidays: new Set<string>(), eCloses: new Map<string, string>() };
    }),
  ]);

  if (historical.dates.size === 0) {
    const log = deps.log || defaultLog;
    log('SPY history returned 0 trading days; keeping existing calendar');
    return;
  }

  const calendar = buildCalendar(historical, upcoming);
  tradingDays = calendar.tradingDays;
  earlyCloses = calendar.earlyCloses;
  calendarRangeStart = calendar.rangeStart;
  calendarRangeEnd = calendar.rangeEnd;
  initialized = true;
  lastRefreshedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Init / destroy
// ---------------------------------------------------------------------------

/**
 * Initialize the trading calendar by fetching historical SPY data and upcoming market status.
 */
async function init(deps: CalendarDeps): Promise<void> {
  const log = deps.log || defaultLog;
  savedDeps = deps;

  if (!deps.fetchDataApiJson || !deps.buildDataApiUrl || !deps.formatDateUTC) {
    log('Missing dependencies; staying in weekday-only mode');
    return;
  }

  try {
    await refreshCalendar(deps);
    log(
      `Initialized: ${tradingDays.size} trading days, ${earlyCloses.size} early closes, range ${calendarRangeStart} to ${calendarRangeEnd}`,
    );
    scheduleRefresh(deps);
  } catch (err: unknown) {
    log(`Init failed: ${err instanceof Error ? err.message : String(err)}; staying in weekday-only mode`);
  }
}

/** Stop the daily refresh timer. */
function destroy(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  init,
  destroy,
  isTradingDay,
  isEarlyClose,
  getCloseTimeEt,
  previousTradingDay,
  nextTradingDay,
  getTradingDaysBetween,
  getStatus,
};
