import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import {
  bootstrapBreadthHistory,
  runBreadthComputation,
  cleanupBreadthData,
  getLatestBreadthData,
} from './breadthService.js';
import { getBreadthConstituentRuntimeSummary, rebuildBreadthConstituents } from './breadthConstituentService.js';
import { getSpyDaily, getSpyIntraday, dataApiIntradayChartHistory, buildIntradayBreadthPoints } from './chartEngine.js';
import { dataApiDaily } from './dataApi.js';
import { createRunMetricsTracker } from './metricsService.js';

export class BreadthRouteService {
  private bootstrapRunning = false;
  private bootstrapStopRequested = false;
  private bootstrapStatus = '';
  private bootstrapFinishedAt: string | null = null;
  private bootstrapStateHydrationPromise: Promise<void> | null = null;

  constructor(private readonly divergenceDb: Kysely<Database> | null) {}

  public isConfigured(): boolean {
    return this.divergenceDb !== null;
  }

  private getBootstrapStateSnapshot() {
    return {
      running: this.bootstrapRunning,
      status: this.bootstrapStatus,
      finished_at: this.bootstrapFinishedAt,
    };
  }

  private async hydrateBootstrapStateFromDbIfNeeded(): Promise<void> {
    if (!this.isConfigured()) return;
    if (this.bootstrapRunning) return;
    if (this.bootstrapFinishedAt) return;
    if (this.bootstrapStateHydrationPromise) {
      await this.bootstrapStateHydrationPromise;
      return;
    }
    this.bootstrapStateHydrationPromise = (async () => {
      try {
        const result = await sql<{ updated_at: string | null; trade_date: string | null }>`
          SELECT MAX(updated_at)::text AS updated_at, MAX(trade_date)::text AS trade_date
          FROM breadth_snapshots
        `.execute(this.divergenceDb!);
        const row = result.rows[0];
        const updatedAt = String(row?.updated_at || '').trim();
        const tradeDate = String(row?.trade_date || '').trim();
        if (!updatedAt) return;
        this.bootstrapFinishedAt = updatedAt;
        if (!this.bootstrapStatus) {
          this.bootstrapStatus = tradeDate ? `Done — snapshot ${tradeDate}` : 'Done';
        }
      } catch (err: unknown) {
        console.error(
          '[breadth] Failed to hydrate recompute status from DB:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    try {
      await this.bootstrapStateHydrationPromise;
    } finally {
      this.bootstrapStateHydrationPromise = null;
    }
  }

  public async getBootstrapState() {
    await this.hydrateBootstrapStateFromDbIfNeeded();
    return this.getBootstrapStateSnapshot();
  }

  public getBootstrapStateCached() {
    return this.getBootstrapStateSnapshot();
  }

  public requestBootstrapStop(): boolean {
    if (!this.bootstrapRunning) return false;
    this.bootstrapStopRequested = true;
    this.bootstrapStatus = 'Stopping...';
    return true;
  }

  public async getChartData(ticker: string, days: number) {
    const compTicker = ticker.toUpperCase();
    const isIntraday = days <= 30;

    if (isIntraday) {
      const lookbackDays = Math.max(14, days * 3);
      try {
        const [spyBars, compBars] = await Promise.all([
          getSpyIntraday(lookbackDays),
          dataApiIntradayChartHistory(compTicker, '30min', lookbackDays),
        ]);

        if (spyBars && compBars) {
          const points = buildIntradayBreadthPoints(spyBars, compBars, days);
          if (points.length > 0) return { intraday: true, points };
        }
      } catch (err: unknown) {
        // Intraday fetches can occasionally fail for longer windows (e.g. 30d).
        // Fall back to daily series instead of failing the endpoint.
        console.warn(
          `[breadth] Intraday fallback for ${compTicker} ${days}d:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const [spyBars, compBars] = await Promise.all([getSpyDaily(), dataApiDaily(compTicker)]);
    if (!spyBars || !compBars) return null;

    const spyMap = new Map();
    for (const bar of spyBars) spyMap.set(bar.date, bar.close);

    const compMap = new Map();
    for (const bar of compBars) compMap.set(bar.date, bar.close);

    const commonDates = [...spyMap.keys()].filter((d) => compMap.has(d)).sort();
    const allPoints = commonDates.slice(-30).map((d) => ({
      date: d,
      spy: Math.round(spyMap.get(d) * 100) / 100,
      comparison: Math.round(compMap.get(d) * 100) / 100,
    }));

    const sliceDays = days === 1 ? 2 : days;
    return { intraday: false, points: allPoints.slice(-sliceDays) };
  }

  public async getMovingAverages(days: number) {
    if (!this.isConfigured()) throw new Error('Breadth not configured');
    return getLatestBreadthData(days);
  }

  public async startBootstrap(numDays: number): Promise<void> {
    if (!this.isConfigured()) throw new Error('Breadth not configured');

    bootstrapBreadthHistory(numDays)
      .then((r) => console.log(`[breadth] Bootstrap complete: fetched=${r.fetchedDays}, computed=${r.computedDays}`))
      .catch((err) => console.error('[breadth] Bootstrap failed:', err));
  }

  public async startRecompute(numDays: number): Promise<{ status: string; message: string }> {
    if (!this.isConfigured()) throw new Error('Breadth not configured');
    if (this.bootstrapRunning) return { status: 'already_running', message: this.bootstrapStatus };

    const tracker = createRunMetricsTracker('fetchBreadth', {
      trigger: 'manual-api',
      mode: 'recompute',
      requestedDays: numDays,
    });
    const progressRatioRegex = /(\d+)\s*\/\s*(\d+)/;
    const applyProgress = (phase: string, message: string) => {
      tracker.setPhase(phase);
      const match = message.match(progressRatioRegex);
      if (!match) return;
      const done = Math.max(0, Number(match[1]) || 0);
      const total = Math.max(0, Number(match[2]) || 0);
      if (total > 0) tracker.setTotals(total);
      tracker.setProgress(done, 0);
    };
    tracker.setPhase('starting');
    tracker.setTotals(numDays);
    tracker.setProgress(0, 0);

    this.bootstrapRunning = true;
    this.bootstrapStopRequested = false;
    this.bootstrapStatus = 'Starting...';
    this.bootstrapFinishedAt = null;

    bootstrapBreadthHistory(
      numDays,
      (msg) => {
        this.bootstrapStatus = msg;
        const normalized = String(msg || '').toLowerCase();
        if (normalized.startsWith('fetching closes')) {
          applyProgress('fetching_closes', String(msg));
          return;
        }
        if (normalized.startsWith('computing snapshots')) {
          applyProgress('computing_snapshots', String(msg));
          return;
        }
        if (normalized.startsWith('stopped')) {
          tracker.setPhase('stopping');
        }
      },
      () => this.bootstrapStopRequested,
    )
      .then((r) => {
        const verb = this.bootstrapStopRequested ? 'Stopped' : 'Done';
        this.bootstrapStatus = `${verb} — fetched ${r.fetchedDays} days, computed ${r.computedDays} snapshots`;
        this.bootstrapFinishedAt = new Date().toISOString();
        tracker.finish(this.bootstrapStopRequested ? 'stopped' : 'completed', {
          totalTickers: numDays,
          processedTickers: r.computedDays,
          errorTickers: 0,
          phase: this.bootstrapStopRequested ? 'stopped' : 'completed',
          meta: {
            requestedDays: numDays,
            fetchedDays: r.fetchedDays,
            computedDays: r.computedDays,
          },
        });
        console.log(`[breadth] Recompute ${verb.toLowerCase()}: fetched=${r.fetchedDays}, computed=${r.computedDays}`);
      })
      .catch((err: unknown) => {
        this.bootstrapStatus = `Error: ${err instanceof Error ? err.message : String(err)}`;
        this.bootstrapFinishedAt = new Date().toISOString();
        tracker.finish('failed', {
          totalTickers: numDays,
          phase: 'failed',
          meta: {
            requestedDays: numDays,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        console.error('[breadth] Recompute failed:', err);
      })
      .finally(() => {
        this.bootstrapRunning = false;
        this.bootstrapStopRequested = false;
      });

    return { status: 'started', message: 'Recompute started' };
  }

  public async refreshDailyBreadth(tradeDate: string): Promise<void> {
    if (!this.isConfigured()) throw new Error('Breadth not configured');
    await runBreadthComputation(tradeDate);
    await cleanupBreadthData();
  }

  public getConstituentSummary() {
    return getBreadthConstituentRuntimeSummary();
  }

  public async rebuildConstituents(sourceUrl?: string) {
    return rebuildBreadthConstituents({ sourceUrl });
  }
}
