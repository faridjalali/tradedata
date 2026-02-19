import type { Bar1m, DailyAggregate, WeekAggregate } from './vdfTypes.js';

export function vdAggregateDaily(bars1m: Bar1m[]): DailyAggregate[] {
  const dailyMap = new Map<string, { buyVol: number; sellVol: number; totalVol: number; close: number; open: number; high: number; low: number; first: boolean }>();
  for (const b of bars1m) {
    const d = new Date(b.time * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(d))
      dailyMap.set(d, {
        buyVol: 0,
        sellVol: 0,
        totalVol: 0,
        close: 0,
        open: 0,
        high: -Infinity,
        low: Infinity,
        first: true,
      });
    const day = dailyMap.get(d)!;
    const delta = b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0;
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.close = b.close;
    if (b.high > day.high) day.high = b.high;
    if (b.low < day.low) day.low = b.low;
    if (day.first) {
      day.open = b.open;
      day.first = false;
    }
  }

  const dates = [...dailyMap.keys()].sort();
  return dates.map((d) => {
    const day = dailyMap.get(d)!;
    return {
      date: d,
      delta: day.buyVol - day.sellVol,
      totalVol: day.totalVol,
      buyVol: day.buyVol,
      sellVol: day.sellVol,
      close: day.close,
      open: day.open,
      high: day.high === -Infinity ? day.close : day.high,
      low: day.low === Infinity ? day.close : day.low,
    };
  });
}

export function buildWeeks(daily: DailyAggregate[]): WeekAggregate[] {
  const weekMap = new Map<string, DailyAggregate[]>();
  for (const d of daily) {
    const dt = new Date(d.date + 'T12:00:00Z');
    const dow = dt.getUTCDay();
    const monday = new Date(dt);
    monday.setUTCDate(monday.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    const wk = monday.toISOString().split('T')[0];
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk)!.push(d);
  }
  return [...weekMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, days]) => {
      const buyVol = days.reduce((s, d) => s + d.buyVol, 0);
      const sellVol = days.reduce((s, d) => s + d.sellVol, 0);
      const totalVol = days.reduce((s, d) => s + d.totalVol, 0);
      return {
        weekStart,
        delta: buyVol - sellVol,
        totalVol,
        deltaPct: totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0,
        nDays: days.length,
      };
    });
}
