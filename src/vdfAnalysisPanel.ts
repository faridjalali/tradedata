import { escapeHtml } from './utils';

// ─── VDF Types ──────────────────────────────────────────────────────────────

export type { VDFZone, VDFDistribution, VDFProximity, VDFCacheEntry } from '../shared/api-types';
import type { VDFZone, VDFDistribution, VDFProximity, VDFCacheEntry } from '../shared/api-types';

// ─── VDF Component Metadata ─────────────────────────────────────────────────

const VDF_COMPONENTS: Array<{ key: string; label: string; defaultWeight: number; tooltip: string }> = [
  {
    key: 's8',
    label: 'Divergence',
    defaultWeight: 35,
    tooltip:
      'Overall price-down + delta-up divergence. The PRIMARY thesis signal. Score = 0 when price is rising or delta is negative.',
  },
  {
    key: 's6',
    label: 'Absorption',
    defaultWeight: 25,
    tooltip:
      'Percentage of days where price fell but delta was positive. Day-by-day divergence confirmation: institutions buying the dip.',
  },
  {
    key: 's1',
    label: 'Net Delta',
    defaultWeight: 15,
    tooltip: 'Total net buying as % of total volume. Supporting signal: is there net buying?',
  },
  {
    key: 's2',
    label: 'Delta Slope',
    defaultWeight: 10,
    tooltip: 'Trend of cumulative weekly delta. Supporting signal: is buying building over time?',
  },
  {
    key: 's3',
    label: 'Delta Shift',
    defaultWeight: 5,
    tooltip: 'Is buying stronger now than before? Compares avg daily delta in the zone to the pre-context period.',
  },
  {
    key: 's4',
    label: 'Accum Ratio',
    defaultWeight: 5,
    tooltip: 'Fraction of weeks with positive delta. High ratio = persistent buying across multiple weeks.',
  },
  {
    key: 's5',
    label: 'Buy vs Sell',
    defaultWeight: 3,
    tooltip: 'Ratio of large buy days to large sell days. Detects if big-volume days lean bullish or bearish.',
  },
  {
    key: 's7',
    label: 'Vol Decline',
    defaultWeight: 2,
    tooltip: 'Volume declining from first-third to last-third of the zone. Supply drying up = fewer sellers remain.',
  },
];

const VDF_DEFAULT_WEIGHTS: Record<string, number> = {};
VDF_COMPONENTS.forEach((c) => {
  VDF_DEFAULT_WEIGHTS[c.key] = c.defaultWeight;
});

// ─── Module State ───────────────────────────────────────────────────────────

let vdfAnalysisPanelEl: HTMLDivElement | null = null;
const vdfWeights: Record<string, number> = { ...VDF_DEFAULT_WEIGHTS };
let lastRenderedVDFEntry: VDFCacheEntry | null = null;
let lastRenderedVDFTicker = '';

// ─── Weight Management ──────────────────────────────────────────────────────

function loadVDFWeightsFromStorage(): void {
  try {
    const raw = localStorage.getItem('chart_vdf_weights');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const c of VDF_COMPONENTS) {
          if (typeof parsed[c.key] === 'number') vdfWeights[c.key] = parsed[c.key];
        }
      }
    }
  } catch {
    /* */
  }
}

function getVDFWeightTotal(): number {
  return VDF_COMPONENTS.reduce((s, c) => s + (vdfWeights[c.key] || 0), 0);
}

function recomputeVDFZoneScore(zone: VDFZone): number {
  if (!zone.components) return zone.score;
  const total = getVDFWeightTotal();
  if (total <= 0) return 0;
  let rawScore = 0;
  for (const c of VDF_COMPONENTS) {
    const val = (zone.components as Record<string, number>)[c.key] || 0;
    rawScore += val * ((vdfWeights[c.key] || 0) / total);
  }
  const concordancePenalty = zone.concordancePenalty ?? 1.0;
  const durationMultiplier = zone.durationMultiplier ?? 1.0;
  return rawScore * concordancePenalty * durationMultiplier;
}

function getVDFComponentLabels(): Array<[string, string, string]> {
  const total = getVDFWeightTotal();
  return VDF_COMPONENTS.map((c) => {
    const w = vdfWeights[c.key] || 0;
    const pct = total > 0 ? Math.round((w / total) * 100) : 0;
    return [c.key, c.label, `${pct}%`] as [string, string, string];
  });
}

// ─── Formatting & Color Helpers ─────────────────────────────────────────────

function formatVDFDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function vdfScoreTier(score: number): string {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Moderate';
  if (score >= 40) return 'Weak';
  return 'Marginal';
}

function vdfScoreTierClass(score: number): string {
  if (score >= 80) return 'is-strong';
  if (score >= 60) return 'is-moderate';
  if (score >= 40) return 'is-weak';
  return 'is-marginal';
}

function vdfProximityLevelClass(level: string): string {
  if (level === 'imminent') return 'is-imminent';
  if (level === 'high') return 'is-high';
  if (level === 'elevated') return 'is-elevated';
  return 'is-none';
}

function vdfComponentStrengthClass(value: number): string {
  if (value >= 0.7) return 'is-high';
  if (value >= 0.4) return 'is-mid';
  return 'is-low';
}

// ─── HTML Builders ──────────────────────────────────────────────────────────

function buildComponentBarsHtml(components: Record<string, number>): string {
  return getVDFComponentLabels()
    .map(([key, label, weight]: [string, string, string]) => {
      const val = Number(components[key]) || 0;
      const pct = Math.max(0, Math.min(100, Math.round(val * 100)));
      const strengthClass = vdfComponentStrengthClass(val);
      return `<div class="vdf-ap-comp-row">
      <span class="vdf-ap-comp-label">${escapeHtml(label)} (${weight})</span>
      <progress class="vdf-ap-comp-bar ${strengthClass}" max="100" value="${pct}"></progress>
      <span class="vdf-ap-comp-value">${val.toFixed(2)}</span>
    </div>`;
    })
    .join('');
}

function buildZoneHtml(zone: VDFZone, index: number, isBest: boolean): string {
  const recomputed = recomputeVDFZoneScore(zone);
  const scoreInt = Math.round(recomputed * 100);
  const serverScoreInt = Math.round(zone.score * 100);
  const isCustomWeights = !VDF_COMPONENTS.every((comp) => vdfWeights[comp.key] === comp.defaultWeight);
  const label = isBest ? `Zone ${index + 1} (Primary)` : `Zone ${index + 1}`;
  const tierClass = vdfScoreTierClass(scoreInt);

  let metricsLine = '';
  const parts: string[] = [];
  if (zone.overallPriceChange !== null && zone.overallPriceChange !== undefined)
    parts.push(`Price: ${zone.overallPriceChange >= 0 ? '+' : ''}${zone.overallPriceChange.toFixed(1)}%`);
  if (zone.netDeltaPct !== null && zone.netDeltaPct !== undefined)
    parts.push(`Net Delta: ${zone.netDeltaPct >= 0 ? '+' : ''}${zone.netDeltaPct.toFixed(1)}%`);
  if (zone.absorptionPct !== null && zone.absorptionPct !== undefined)
    parts.push(`Absorption: ${zone.absorptionPct.toFixed(1)}%`);
  if (parts.length) metricsLine = `<div class="vdf-ap-card-metrics">${escapeHtml(parts.join(' | '))}</div>`;

  let detailLine = '';
  const dParts: string[] = [];
  if (zone.accumWeeks !== null && zone.accumWeeks !== undefined && zone.weeks)
    dParts.push(`Accum weeks: ${zone.accumWeeks}/${zone.weeks} (${Math.round((zone.accumWeeks / zone.weeks) * 100)}%)`);
  if (zone.durationMultiplier !== null && zone.durationMultiplier !== undefined)
    dParts.push(`Duration: ${zone.durationMultiplier.toFixed(3)}x`);
  if (zone.concordancePenalty !== null && zone.concordancePenalty !== undefined && zone.concordancePenalty < 1.0)
    dParts.push(`Concordance: ${zone.concordancePenalty.toFixed(3)}x`);
  if (dParts.length) detailLine = `<div class="vdf-ap-card-details">${escapeHtml(dParts.join(' | '))}</div>`;

  let componentsHtml = '';
  if (zone.components) {
    componentsHtml = `<div class="vdf-ap-components"><div class="vdf-ap-subsection">Components</div>${buildComponentBarsHtml(zone.components as unknown as Record<string, number>)}</div>`;
  }

  const scoreDiffHtml =
    isCustomWeights && serverScoreInt !== scoreInt
      ? `<span class="vdf-ap-score-diff">(was ${serverScoreInt})</span>`
      : '';

  return `<div class="vdf-ap-card">
    <div class="vdf-ap-card-head">
      <span class="vdf-ap-card-title">${escapeHtml(label)}</span>
      <span><span class="vdf-ap-score ${tierClass}">${scoreInt}</span>${scoreDiffHtml}</span>
    </div>
    <div class="vdf-ap-card-date">${formatVDFDate(zone.startDate)} \u2192 ${formatVDFDate(zone.endDate)} (${zone.windowDays} trading days${zone.weeks ? `, ${zone.weeks} wk` : ''})</div>
    ${metricsLine}
    ${detailLine}
    ${componentsHtml}
  </div>`;
}

function buildDistributionHtml(dist: VDFDistribution, index: number): string {
  let detail = '';
  const parts: string[] = [];
  if (dist.priceChangePct !== null && dist.priceChangePct !== undefined)
    parts.push(`Price ${dist.priceChangePct >= 0 ? '+' : ''}${dist.priceChangePct.toFixed(1)}%`);
  if (dist.netDeltaPct !== null && dist.netDeltaPct !== undefined)
    parts.push(`Delta ${dist.netDeltaPct >= 0 ? '+' : ''}${dist.netDeltaPct.toFixed(1)}%`);
  if (parts.length) detail = parts.join(' while ') + ' \u2014 selling into strength.';

  return `<div class="vdf-ap-dist-card">
    <div class="vdf-ap-dist-title">Cluster ${index + 1}: ${formatVDFDate(dist.startDate)} \u2192 ${formatVDFDate(dist.endDate)} (${dist.spanDays} days)</div>
    ${detail ? `<div class="vdf-ap-dist-detail">${escapeHtml(detail)}</div>` : ''}
  </div>`;
}

function buildProximityHtml(prox: VDFProximity): string {
  if (prox.level === 'none' && prox.compositeScore === 0) return '';
  const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
  const levelClass = vdfProximityLevelClass(prox.level);

  const signalRows = prox.signals
    .map(
      (sig) =>
        `<div class="vdf-ap-prox-row">
      <span class="vdf-ap-prox-detail">\u2713 ${escapeHtml(sig.detail)}</span>
      <span class="vdf-ap-prox-points ${levelClass}">+${sig.points}</span>
    </div>`,
    )
    .join('');

  return `<div class="vdf-ap-prox">
    <div class="vdf-ap-prox-summary">
      <span class="vdf-ap-prox-total ${levelClass}">${prox.compositeScore} pts</span>
      <span class="vdf-ap-prox-level ${levelClass}">${escapeHtml(levelLabel)}</span>
    </div>
    ${signalRows}
  </div>`;
}

// ─── Panel Lifecycle ────────────────────────────────────────────────────────

export function ensureVDFAnalysisPanel(): HTMLDivElement {
  if (vdfAnalysisPanelEl) return vdfAnalysisPanelEl;
  const chartContent = document.getElementById('chart-content');
  if (!chartContent) return document.createElement('div');
  const panel = document.createElement('div');
  panel.id = 'vdf-analysis-panel';
  panel.className = 'vdf-ap-panel is-hidden';
  chartContent.insertBefore(panel, chartContent.firstChild);
  vdfAnalysisPanelEl = panel;
  return panel;
}

export function toggleVDFAnalysisPanel(): void {
  if (!vdfAnalysisPanelEl) return;
  const body = vdfAnalysisPanelEl.querySelector('.vdf-ap-body') as HTMLElement | null;
  if (!body) return;
  const isCollapsed = body.classList.toggle('is-collapsed');
  const chevron = vdfAnalysisPanelEl.querySelector('.vdf-ap-chevron') as HTMLElement | null;
  if (chevron) chevron.textContent = isCollapsed ? '\u25b8' : '\u25be';
}

export function clearVDFAnalysisPanel(): void {
  if (!vdfAnalysisPanelEl) return;
  vdfAnalysisPanelEl.classList.add('is-hidden');
  vdfAnalysisPanelEl.innerHTML = '';
}

export function renderVDFAnalysisPanel(entry: VDFCacheEntry | null, ticker: string): void {
  lastRenderedVDFEntry = entry;
  lastRenderedVDFTicker = ticker;
  loadVDFWeightsFromStorage();
  const panel = ensureVDFAnalysisPanel();

  if (!entry) {
    // Show panel in grayed-out placeholder state (visible like other panes before data arrives)
    panel.innerHTML = `<div class="vdf-ap-header is-static is-muted">
      <div class="vdf-ap-header-left">
        <span class="vdf-ap-chevron">\u25b8</span>
        <span class="vdf-ap-title">Analysis</span>
        ${ticker ? `<span class="vdf-ap-ticker">${escapeHtml(ticker)}</span>` : ''}
      </div>
    </div>`;
    panel.classList.remove('is-hidden');
    return;
  }

  // Use best zone recomputed score for the header
  const bestZone = entry.zones[0];
  const recomputedBestScore = bestZone ? Math.round(recomputeVDFZoneScore(bestZone) * 100) : 0;
  const score = entry.is_detected ? recomputedBestScore : Math.round(entry.composite_score * 100);
  const tier = vdfScoreTier(score);
  const tierClass = vdfScoreTierClass(score);
  const metrics = entry.details?.metrics;

  // Always default to collapsed when the ticker analysis panel is rendered.
  const collapsed = true;

  const chevron = collapsed ? '\u25b8' : '\u25be';

  // Header
  const headerHtml = `<div class="vdf-ap-header" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}">
    <div class="vdf-ap-header-left">
      <span class="vdf-ap-chevron">${chevron}</span>
      <span class="vdf-ap-title">Analysis</span>
      <span class="vdf-ap-ticker">${escapeHtml(ticker)}</span>
    </div>
    <div class="vdf-ap-header-right">
      ${
        entry.is_detected
          ? `<span class="vdf-ap-status ${tierClass}">${escapeHtml(tier)}</span>`
          : `<span class="vdf-ap-status">Not detected</span>`
      }
    </div>
  </div>`;

  // Body
  let bodyHtml = '';

  if (!entry.is_detected) {
    let scanInfo = '';
    if (metrics?.scanStart && metrics?.scanEnd) {
      scanInfo = ` Scan: ${formatVDFDate(metrics.scanStart)} \u2192 ${formatVDFDate(metrics.scanEnd)}`;
      if (metrics.totalDays) scanInfo += ` (${metrics.totalDays} trading days)`;
      scanInfo += '.';
    }
    bodyHtml = `<div class="vdf-ap-empty">No accumulation patterns detected in the scan period.${scanInfo}</div>`;
  } else {
    const zoneCount = entry.zones.length;
    let assessParts = `Volume-delta accumulation <span class="vdf-ap-tier ${tierClass}">${escapeHtml(tier)}</span> (score: ${score}).`;
    assessParts += ` ${zoneCount} accumulation zone${zoneCount !== 1 ? 's' : ''} detected`;
    if (entry.weeks) assessParts += ` spanning up to ${entry.weeks} weeks`;
    assessParts += '.';
    if (metrics?.scanStart && metrics?.scanEnd) {
      assessParts += ` Scan: ${formatVDFDate(metrics.scanStart)} \u2192 ${formatVDFDate(metrics.scanEnd)}`;
      if (metrics.totalDays) assessParts += ` (${metrics.totalDays} trading days)`;
      assessParts += '.';
    }
    if (entry.distribution.length > 0) {
      assessParts += ` <span class="vdf-ap-dist-emphasis">${entry.distribution.length} distribution cluster${entry.distribution.length !== 1 ? 's' : ''}</span> also found.`;
    }

    const assessHtml = `<div class="vdf-ap-assess">${assessParts}</div>`;

    // Chart legend
    const legendItems: string[] = [];
    legendItems.push(
      '<span class="vdf-ap-legend-item"><span class="vdf-ap-legend-chip is-accum"></span>Accumulation</span>',
    );
    if (entry.distribution.length > 0) {
      legendItems.push(
        '<span class="vdf-ap-legend-item"><span class="vdf-ap-legend-chip is-dist"></span>Distribution</span>',
      );
    }
    const hasAbsorption = entry.zones.some((z) => (z.absorptionPct || 0) >= 5);
    if (hasAbsorption) {
      legendItems.push(
        '<span class="vdf-ap-legend-item"><span class="vdf-ap-legend-chip is-absorb"></span>Absorption</span>',
      );
    }
    legendItems.push(
      '<span class="vdf-ap-legend-item"><span class="vdf-ap-legend-chip is-bounds"></span>Zone bounds</span>',
    );
    const proxLegend = entry.proximity;
    if (proxLegend && proxLegend.level !== 'none' && proxLegend.compositeScore > 0) {
      const levelClass = vdfProximityLevelClass(proxLegend.level);
      legendItems.push(
        `<span class="vdf-ap-legend-item"><span class="vdf-ap-legend-chip is-prox ${levelClass}"></span>Proximity</span>`,
      );
    }
    const legendHtml = `<div class="vdf-ap-legend">${legendItems.join('')}</div>`;

    // Zones section
    let zonesHtml = '';
    if (entry.zones.length > 0) {
      zonesHtml = '<div class="vdf-ap-section-title">Accumulation Zones</div>';
      zonesHtml += entry.zones.map((z, i) => buildZoneHtml(z, i, i === 0)).join('');
    }

    // Distribution section
    let distHtml = '';
    if (entry.distribution.length > 0) {
      distHtml = '<div class="vdf-ap-section-title">Distribution Clusters</div>';
      distHtml += entry.distribution.map((d, i) => buildDistributionHtml(d, i)).join('');
    }

    // Proximity section
    let proxHtml = '';
    const prox = entry.proximity;
    if (prox && (prox.level !== 'none' || prox.compositeScore > 0)) {
      const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
      proxHtml = `<div class="vdf-ap-section-title">Proximity Signals (${prox.compositeScore} pts \u2014 ${escapeHtml(levelLabel)})</div>`;
      proxHtml += buildProximityHtml(prox);
    }

    bodyHtml = `<div class="vdf-ap-content">${assessHtml}${legendHtml}${zonesHtml}${distHtml}${proxHtml}</div>`;
  }

  panel.innerHTML = `${headerHtml}<div class="vdf-ap-body${collapsed ? ' is-collapsed' : ''}">${bodyHtml}</div>`;
  panel.classList.remove('is-hidden');

  // Bind header click for toggle
  const header = panel.querySelector('.vdf-ap-header') as HTMLElement | null;
  if (header) {
    header.addEventListener('click', () => {
      toggleVDFAnalysisPanel();
    });
    header.addEventListener('keydown', (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleVDFAnalysisPanel();
    });
  }
}

// Re-render VDF panel when theme changes so dynamic sections stay in sync.
window.addEventListener('themechange', () => {
  if (!vdfAnalysisPanelEl || vdfAnalysisPanelEl.classList.contains('is-hidden')) return;
  if (lastRenderedVDFTicker) {
    renderVDFAnalysisPanel(lastRenderedVDFEntry, lastRenderedVDFTicker);
  }
});
