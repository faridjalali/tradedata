function formatDateUTC(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayKeyInLA(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function weekKeyInLA(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  const dayString = new Date(unixSeconds * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const match = dayString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const weekDay = utcDate.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (weekDay + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);
  return formatDateUTC(utcDate);
}

function normalizeBarsForAggregation(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .filter((bar) => (
      bar &&
      Number.isFinite(Number(bar.time)) &&
      Number.isFinite(Number(bar.open)) &&
      Number.isFinite(Number(bar.high)) &&
      Number.isFinite(Number(bar.low)) &&
      Number.isFinite(Number(bar.close))
    ))
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function aggregate4HourBarsToDaily(fourHourBars) {
  const sorted = normalizeBarsForAggregation(fourHourBars);
  if (sorted.length === 0) return [];

  const byDay = new Map();

  for (const bar of sorted) {
    const time = Number(bar.time);
    const key = dayKeyInLA(time);
    if (!key) continue;

    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    const volume = Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : 0;

    const existing = byDay.get(key);
    if (!existing) {
      byDay.set(key, {
        time,
        open,
        high,
        low,
        close,
        volume,
        _lastTime: time
      });
      continue;
    }

    existing.high = Math.max(existing.high, high);
    existing.low = Math.min(existing.low, low);
    existing.volume += volume;
    if (time >= existing._lastTime) {
      existing.close = close;
      existing._lastTime = time;
    }
  }

  return Array.from(byDay.values())
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume
    }));
}

function aggregateDailyBarsToWeekly(dailyBars) {
  const sorted = normalizeBarsForAggregation(dailyBars);
  if (sorted.length === 0) return [];

  const byWeek = new Map();

  for (const bar of sorted) {
    const time = Number(bar.time);
    const key = weekKeyInLA(time);
    if (!key) continue;

    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    const volume = Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : 0;

    const existing = byWeek.get(key);
    if (!existing) {
      byWeek.set(key, {
        time,
        open,
        high,
        low,
        close,
        volume,
        _lastTime: time
      });
      continue;
    }

    existing.high = Math.max(existing.high, high);
    existing.low = Math.min(existing.low, low);
    existing.volume += volume;
    if (time >= existing._lastTime) {
      existing.close = close;
      existing._lastTime = time;
    }
  }

  return Array.from(byWeek.values())
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume
    }));
}

function isoWeekKeyFromEtUnixSeconds(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(new Date(Number(unixSeconds) * 1000));
  const year = Number(parts.find((p) => p.type === 'year')?.value || 0);
  const month = Number(parts.find((p) => p.type === 'month')?.value || 0);
  const day = Number(parts.find((p) => p.type === 'day')?.value || 0);
  if (!year || !month || !day) return '';

  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const weekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(weekNo).padStart(2, '0')}`;
}

function classifyDivergenceSignal(volumeDelta, close, prevClose) {
  if (!Number.isFinite(volumeDelta) || !Number.isFinite(close) || !Number.isFinite(prevClose)) return null;
  if (volumeDelta > 0 && close < prevClose) return 'bullish';
  if (volumeDelta < 0 && close > prevClose) return 'bearish';
  return null;
}

function aggregateDailyDivergenceToWeekly(dailyBars, dailyDeltas) {
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];
  const deltaByTime = new Map((dailyDeltas || []).map((point) => [Number(point.time), Number(point.delta) || 0]));
  const weekly = [];
  const byKey = new Map();

  for (const bar of dailyBars) {
    const time = Number(bar.time);
    if (!Number.isFinite(time)) continue;
    const weekKey = isoWeekKeyFromEtUnixSeconds(time);
    if (!weekKey) continue;
    const delta = Number(deltaByTime.get(time)) || 0;
    const existing = byKey.get(weekKey);
    if (!existing) {
      const seed = {
        weekKey,
        time,
        _lastTime: time,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        delta
      };
      byKey.set(weekKey, seed);
      weekly.push(seed);
      continue;
    }
    existing.high = Math.max(existing.high, Number(bar.high));
    existing.low = Math.min(existing.low, Number(bar.low));
    existing.delta += delta;
    if (time >= existing._lastTime) {
      existing._lastTime = time;
      existing.time = time;
      existing.close = Number(bar.close);
    }
  }

  return weekly.sort((a, b) => Number(a.time) - Number(b.time));
}

function barsToTuples(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.map((b) => [
    Number(b.time),
    Number(b.open),
    Number(b.high),
    Number(b.low),
    Number(b.close),
    Number(b.volume)
  ]);
}

function pointsToTuples(points, valueKey = 'value') {
  if (!Array.isArray(points)) return [];
  return points.map((p) => [
    Number(p.time),
    Number(p[valueKey])
  ]);
}

module.exports = {
  aggregate4HourBarsToDaily,
  aggregateDailyBarsToWeekly,
  classifyDivergenceSignal,
  aggregateDailyDivergenceToWeekly,
  isoWeekKeyFromEtUnixSeconds,
  barsToTuples,
  pointsToTuples
};
