/**
 * Shared date/time utility functions used across backend modules.
 * All functions are pure — no external dependencies or mutable state.
 */

/**
 * Add (or subtract) UTC days from a Date object.
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Convert a Unix-seconds timestamp to an ET date string (YYYY-MM-DD).
 * @param {number} unixSeconds
 * @returns {string}
 */
function etDateStringFromUnixSeconds(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

/**
 * Current ET date string (YYYY-MM-DD).
 * @param {Date} [nowUtc]
 * @returns {string}
 */
function currentEtDateString(nowUtc = new Date()) {
  return nowUtc.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

/**
 * Return the lexicographically greater of two YYYY-MM-DD date strings.
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function maxEtDateString(a, b) {
  const aVal = String(a || '').trim();
  const bVal = String(b || '').trim();
  if (!aVal) return bVal || '';
  if (!bVal) return aVal;
  return aVal >= bVal ? aVal : bVal;
}

/**
 * Parse a YYYY-MM-DD date key to UTC milliseconds (midnight).
 * @param {string} dateKey
 * @returns {number} UTC ms or NaN
 */
function parseDateKeyToUtcMs(dateKey) {
  const value = String(dateKey || '').trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Subtract N days from a YYYY-MM-DD date key.
 * @param {string} dateKey
 * @param {number} days
 * @returns {string} YYYY-MM-DD or ''
 */
function dateKeyDaysAgo(dateKey, days) {
  const baseMs = parseDateKeyToUtcMs(dateKey);
  if (!Number.isFinite(baseMs)) return '';
  const shifted = new Date(baseMs - (Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Convert ET local time components to UTC milliseconds.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {number}
 */
function easternLocalToUtcMs(year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const etOffset = probe.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short'
  }).includes('EST') ? -5 : -4;
  return Date.UTC(year, month - 1, day, hour - etOffset, minute, 0);
}

/**
 * Convert PT local time components to UTC milliseconds.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {number}
 */
function pacificLocalToUtcMs(year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const ptOffset = probe.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  }).includes('PST') ? -8 : -7;
  return Date.UTC(year, month - 1, day, hour - ptOffset, minute, 0);
}

/**
 * Convert a Unix-seconds timestamp to a PT date string (YYYY-MM-DD).
 * @param {number} unixSeconds
 * @returns {string}
 */
function pacificDateStringFromUnixSeconds(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

/**
 * Build a YYYY-MM-DD key from year/month/day parts.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string}
 */
function dateKeyFromYmdParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Get PT date/time parts from a UTC Date.
 * @param {Date} [nowUtc]
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, weekday: number }}
 */
function pacificDateTimeParts(nowUtc = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(nowUtc);
  const map = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  const weekdayMap = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
  };
  return {
    year: Number(map.year || 0),
    month: Number(map.month || 0),
    day: Number(map.day || 0),
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
    weekday: Number(weekdayMap[map.weekday] ?? NaN)
  };
}

export {
  addUtcDays,
  etDateStringFromUnixSeconds,
  currentEtDateString,
  maxEtDateString,
  parseDateKeyToUtcMs,
  dateKeyDaysAgo,
  easternLocalToUtcMs,
  pacificLocalToUtcMs,
  pacificDateStringFromUnixSeconds,
  dateKeyFromYmdParts,
  pacificDateTimeParts,
};
