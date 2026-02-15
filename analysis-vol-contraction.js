#!/usr/bin/env node
/**
 * Quick check: is there volatility contraction toward the END of the
 * RKLB and IREN accumulation periods?  If so, the old HTF vol-contraction
 * metrics could supplement the VD accumulation score.
 *
 * Looks at: daily range, ATR(5), Bollinger Band width, and volume decline
 * in the last third vs first third of the accumulation window.
 */
require('dotenv').config();
const DATA_API_KEY = process.env.DATA_API_KEY;
const BASE = 'https://api.massive.com';

async function fetchBars(symbol, mult, ts, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${mult}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.results || []).map(r => ({
    time: Math.floor((r.t || 0) / 1000),
    open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v || 0
  })).filter(b => Number.isFinite(b.time) && Number.isFinite(b.close));
}

function toDate(ts) { return new Date(ts * 1000).toISOString().split('T')[0]; }

function analyzeVolContraction(bars15m, label) {
  // Aggregate to daily
  const dailyMap = new Map();
  for (const b of bars15m) {
    const d = toDate(b.time);
    if (!dailyMap.has(d)) dailyMap.set(d, { open: b.open, high: -Infinity, low: Infinity, close: b.close, vol: 0, first: true });
    const day = dailyMap.get(d);
    day.high = Math.max(day.high, b.high);
    day.low = Math.min(day.low, b.low);
    day.close = b.close;
    day.vol += b.volume;
    if (day.first) { day.open = b.open; day.first = false; }
  }
  const dates = [...dailyMap.keys()].sort();
  const daily = dates.map(d => dailyMap.get(d));

  if (daily.length < 10) { console.log(`  ${label}: insufficient data (${daily.length} days)`); return; }

  // Compute daily range % and ATR
  const ranges = daily.map(d => ((d.high - d.low) / d.close) * 100);
  const vols = daily.map(d => d.vol);
  const closes = daily.map(d => d.close);

  // Bollinger Band width (20-period)
  const bbWidths = [];
  for (let i = 19; i < closes.length; i++) {
    const slice = closes.slice(i - 19, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / 20;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / 20);
    bbWidths.push((std / mean) * 100);
  }

  // Split into thirds
  const third = Math.floor(daily.length / 3);
  const t1Ranges = ranges.slice(0, third);
  const t3Ranges = ranges.slice(2 * third);
  const t1Vols = vols.slice(0, third);
  const t3Vols = vols.slice(2 * third);

  const avgT1Range = t1Ranges.reduce((s, v) => s + v, 0) / t1Ranges.length;
  const avgT3Range = t3Ranges.reduce((s, v) => s + v, 0) / t3Ranges.length;
  const avgT1Vol = t1Vols.reduce((s, v) => s + v, 0) / t1Vols.length;
  const avgT3Vol = t3Vols.reduce((s, v) => s + v, 0) / t3Vols.length;

  const rangeContraction = ((avgT3Range - avgT1Range) / avgT1Range) * 100;
  const volContraction = ((avgT3Vol - avgT1Vol) / avgT1Vol) * 100;

  // BB width thirds (if enough data)
  let bbContraction = 'N/A';
  if (bbWidths.length >= 6) {
    const bbThird = Math.floor(bbWidths.length / 3);
    const bbT1 = bbWidths.slice(0, bbThird).reduce((s, v) => s + v, 0) / bbThird;
    const bbT3 = bbWidths.slice(2 * bbThird).reduce((s, v) => s + v, 0) / (bbWidths.length - 2 * bbThird);
    bbContraction = `${((bbT3 - bbT1) / bbT1 * 100).toFixed(1)}%`;
  }

  // Last 5 days vs first 5 days
  const last5Range = ranges.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const first5Range = ranges.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
  const last5Vol = vols.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const first5Vol = vols.slice(0, 5).reduce((s, v) => s + v, 0) / 5;

  console.log(`\n  ${label} (${daily.length} days, ${dates[0]} → ${dates[dates.length - 1]})`);
  console.log(`    Daily Range (avg):`);
  console.log(`      First third: ${avgT1Range.toFixed(3)}%`);
  console.log(`      Last third:  ${avgT3Range.toFixed(3)}%`);
  console.log(`      Contraction: ${rangeContraction.toFixed(1)}% ${rangeContraction < -10 ? '✅ CONTRACTING' : rangeContraction > 10 ? '⬆ EXPANDING' : '~ FLAT'}`);
  console.log(`    Volume (avg):`);
  console.log(`      First third: ${(avgT1Vol / 1e6).toFixed(2)}M`);
  console.log(`      Last third:  ${(avgT3Vol / 1e6).toFixed(2)}M`);
  console.log(`      Change:      ${volContraction.toFixed(1)}% ${volContraction < -15 ? '✅ DECLINING' : '~ FLAT/RISING'}`);
  console.log(`    BB Width change: ${bbContraction}`);
  console.log(`    Last 5d vs First 5d:`);
  console.log(`      Range: ${first5Range.toFixed(3)}% → ${last5Range.toFixed(3)}% (${((last5Range/first5Range - 1)*100).toFixed(1)}%)`);
  console.log(`      Volume: ${(first5Vol/1e6).toFixed(2)}M → ${(last5Vol/1e6).toFixed(2)}M (${((last5Vol/first5Vol - 1)*100).toFixed(1)}%)`);

  // Daily detail for last 10 days
  console.log(`    Last 10 days detail:`);
  for (let i = Math.max(0, daily.length - 10); i < daily.length; i++) {
    console.log(`      ${dates[i]}: range=${ranges[i].toFixed(3)}% vol=${(vols[i]/1e6).toFixed(2)}M close=$${closes[i].toFixed(2)}`);
  }
}

async function main() {
  console.log('=== Volatility Contraction Check ===\n');

  const cases = [
    { symbol: 'RKLB', from: '2025-02-26', to: '2025-04-07', label: 'RKLB Feb 26 - Apr 7 2025' },
    { symbol: 'IREN', from: '2025-03-13', to: '2025-04-21', label: 'IREN Mar 13 - Apr 21 2025' },
  ];

  for (const c of cases) {
    const bars = await fetchBars(c.symbol, 15, 'minute', c.from, c.to);
    console.log(`Fetched ${bars.length} 15m bars for ${c.symbol}`);
    analyzeVolContraction(bars, c.label);
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
