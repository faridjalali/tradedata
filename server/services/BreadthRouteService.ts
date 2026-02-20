import type { Kysely } from 'kysely';
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

export class BreadthRouteService {
  private bootstrapRunning = false;
  private bootstrapStopRequested = false;
  private bootstrapStatus = '';
  private bootstrapFinishedAt: string | null = null;

  constructor(private readonly divergenceDb: Kysely<Database> | null) {}

  public isConfigured(): boolean {
    return this.divergenceDb !== null;
  }

  public getBootstrapState() {
    return {
      running: this.bootstrapRunning,
      status: this.bootstrapStatus,
      finished_at: this.bootstrapFinishedAt,
    };
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
      const [spyBars, compBars] = await Promise.all([
        getSpyIntraday(lookbackDays),
        dataApiIntradayChartHistory(compTicker, '30min', lookbackDays),
      ]);

      if (spyBars && compBars) {
        const points = buildIntradayBreadthPoints(spyBars, compBars, days);
        if (points.length > 0) return { intraday: true, points };
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

    this.bootstrapRunning = true;
    this.bootstrapStopRequested = false;
    this.bootstrapStatus = 'Starting...';

    bootstrapBreadthHistory(
      numDays,
      (msg) => {
        this.bootstrapStatus = msg;
      },
      () => this.bootstrapStopRequested,
    )
      .then((r) => {
        const verb = this.bootstrapStopRequested ? 'Stopped' : 'Done';
        this.bootstrapStatus = `${verb} — fetched ${r.fetchedDays} days, computed ${r.computedDays} snapshots`;
        this.bootstrapFinishedAt = new Date().toISOString();
        console.log(`[breadth] Recompute ${verb.toLowerCase()}: fetched=${r.fetchedDays}, computed=${r.computedDays}`);
      })
      .catch((err: unknown) => {
        this.bootstrapStatus = `Error: ${err instanceof Error ? err.message : String(err)}`;
        this.bootstrapFinishedAt = new Date().toISOString();
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
