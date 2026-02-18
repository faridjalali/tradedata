/**
 * Chart performance telemetry.
 * Tracks fetch/render timing per interval with P95 summaries.
 */

import type { ChartInterval } from './chartApi';
import { CHART_PERF_SAMPLE_MAX } from './chartTypes';

type ChartPerfSummary = {
  fetchCount: number;
  renderCount: number;
  fetchP95Ms: number;
  renderP95Ms: number;
  responseCacheHit: number;
  responseCacheMiss: number;
  responseCacheUnknown: number;
};

const chartPerfSamples: Record<ChartInterval, { fetchMs: number[]; renderMs: number[] }> = {
  '5min': { fetchMs: [], renderMs: [] },
  '15min': { fetchMs: [], renderMs: [] },
  '30min': { fetchMs: [], renderMs: [] },
  '1hour': { fetchMs: [], renderMs: [] },
  '4hour': { fetchMs: [], renderMs: [] },
  '1day': { fetchMs: [], renderMs: [] },
  '1week': { fetchMs: [], renderMs: [] },
};

const chartPerfSummary: Record<ChartInterval, ChartPerfSummary> = {
  '5min': {
    fetchCount: 0,
    renderCount: 0,
    fetchP95Ms: 0,
    renderP95Ms: 0,
    responseCacheHit: 0,
    responseCacheMiss: 0,
    responseCacheUnknown: 0,
  },
  '15min': {
    fetchCount: 0,
    renderCount: 0,
    fetchP95Ms: 0,
    renderP95Ms: 0,
    responseCacheHit: 0,
    responseCacheMiss: 0,
    responseCacheUnknown: 0,
  },
  '30min': {
    fetchCount: 0,
    renderCount: 0,
    fetchP95Ms: 0,
    renderP95Ms: 0,
    responseCacheHit: 0,
    responseCacheMiss: 0,
    responseCacheUnknown: 0,
  },
  '1hour': {
    fetchCount: 0,
    renderCount: 0,
    fetchP95Ms: 0,
    renderP95Ms: 0,
    responseCacheHit: 0,
    responseCacheMiss: 0,
    responseCacheUnknown: 0,
  },
  '4hour': {
    fetchCount: 0,
    renderCount: 0,
    fetchP95Ms: 0,
    renderP95Ms: 0,
    responseCacheHit: 0,
    responseCacheMiss: 0,
    responseCacheUnknown: 0,
  },
  '1day': {
    fetchCount: 0,
    renderCount: 0,
    fetchP95Ms: 0,
    renderP95Ms: 0,
    responseCacheHit: 0,
    responseCacheMiss: 0,
    responseCacheUnknown: 0,
  },
  '1week': {
    fetchCount: 0,
    renderCount: 0,
    fetchP95Ms: 0,
    renderP95Ms: 0,
    responseCacheHit: 0,
    responseCacheMiss: 0,
    responseCacheUnknown: 0,
  },
};

function computeP95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

function pushPerfSample(values: number[], ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  values.push(Math.round(ms * 100) / 100);
  if (values.length > CHART_PERF_SAMPLE_MAX) {
    values.shift();
  }
}

export function recordChartFetchPerf(interval: ChartInterval, durationMs: number, cacheHeader: string | null): void {
  const samples = chartPerfSamples[interval];
  const summary = chartPerfSummary[interval];
  pushPerfSample(samples.fetchMs, durationMs);
  summary.fetchCount += 1;
  summary.fetchP95Ms = computeP95(samples.fetchMs);
  if (cacheHeader === 'hit') {
    summary.responseCacheHit += 1;
  } else if (cacheHeader === 'miss') {
    summary.responseCacheMiss += 1;
  } else {
    summary.responseCacheUnknown += 1;
  }
}

export function recordChartRenderPerf(interval: ChartInterval, durationMs: number): void {
  const samples = chartPerfSamples[interval];
  const summary = chartPerfSummary[interval];
  pushPerfSample(samples.renderMs, durationMs);
  summary.renderCount += 1;
  summary.renderP95Ms = computeP95(samples.renderMs);
}

export function exposeChartPerfMetrics(): void {
  if (typeof window === 'undefined') return;
  (window as any).__chartPerfMetrics = {
    getSnapshot: () => ({
      byInterval: chartPerfSummary,
      sampleMax: CHART_PERF_SAMPLE_MAX,
    }),
  };
}
