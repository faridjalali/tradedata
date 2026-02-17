import { DIVERGENCE_SCANNER_ENABLED } from '../config.js';
import { easternLocalToUtcMs, dateKeyFromYmdParts, pacificDateTimeParts } from '../lib/dateUtils.js';
import * as tradingCalendar from './tradingCalendar.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { isDivergenceConfigured } from '../db.js';
import { runDailyDivergenceScan } from '../orchestrators/dailyScanOrchestrator.js';
import { runDivergenceTableBuild } from '../orchestrators/tableBuildOrchestrator.js';
import { divergenceSchedulerTimer, setDivergenceSchedulerTimer } from './scanControlService.js';


export function getNextDivergenceScanUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  candidate.setHours(16, 20, 0, 0);

  const candidateDateStr = () =>
    `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;

  if (!tradingCalendar.isTradingDay(candidateDateStr()) || nowEt.getTime() >= candidate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 15 && !tradingCalendar.isTradingDay(candidateDateStr()); i++) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return easternLocalToUtcMs(candidate.getFullYear(), candidate.getMonth() + 1, candidate.getDate(), 16, 20);
}


export async function runScheduledDivergencePipeline() {
  const scanSummary = await runDailyDivergenceScan({ trigger: 'scheduler' });
  const scanStatus = String(scanSummary?.status || 'unknown');
  if (scanStatus !== 'completed') {
    console.log(`Scheduled divergence scan status=${scanStatus}; skipping scheduled table build.`);
    return scanSummary;
  }

  try {
    const tableSummary = await runDivergenceTableBuild({
      trigger: 'scheduler-post-scan',
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
    });
    console.log('Scheduled divergence table build completed after scan:', tableSummary);
  } catch (err: any) {
    const message = err && err.message ? err.message : String(err);
    console.error(`Scheduled divergence table build failed after scan: ${message}`);
  }

  return scanSummary;
}


export function scheduleNextDivergenceScan() {
  if (!isDivergenceConfigured() || !DIVERGENCE_SCANNER_ENABLED) return;
  if (divergenceSchedulerTimer) clearTimeout(divergenceSchedulerTimer);
  const nextRunMs = getNextDivergenceScanUtcMs(new Date());
  const delayMs = Math.max(1000, nextRunMs - Date.now());
  const timer = setTimeout(async () => {
    try {
      await runScheduledDivergencePipeline();
    } catch (err: any) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Scheduled divergence scan failed: ${message}`);
    } finally {
      scheduleNextDivergenceScan();
    }
  }, delayMs);
  setDivergenceSchedulerTimer(timer);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  console.log(`Next divergence scan scheduled in ${Math.round(delayMs / 1000)}s`);
}
