import { escapeHtml } from './utils';
import { getThemeColors } from './theme';

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

function vdfScoreColor(score: number): string {
  if (score >= 80) return '#26a69a';
  if (score >= 60) return '#8bc34a';
  const c = getThemeColors();
  return c.textPrimary;
}

function vdfProximityColor(level: string): string {
  if (level === 'imminent') return '#f44336';
  if (level === 'high') return '#ff9800';
  if (level === 'elevated') return '#ffc107';
  const c = getThemeColors();
  return c.textSecondary;
}

// ─── HTML Builders ──────────────────────────────────────────────────────────

function buildComponentBarsHtml(components: Record<string, number>): string {
  const c = getThemeColors();
  return getVDFComponentLabels()
    .map(([key, label, weight]: [string, string, string]) => {
      const val = Number(components[key]) || 0;
      const pct = Math.max(0, Math.min(100, Math.round(val * 100)));
      const barColor = val >= 0.7 ? '#26a69a' : val >= 0.4 ? '#8bc34a' : c.textMuted;
      return `<div style="display:grid;grid-template-columns:130px 1fr 36px;gap:6px;align-items:center;margin:2px 0;">
      <span style="color:${c.textSecondary};font-size:11px;white-space:nowrap;">${escapeHtml(label)} (${weight})</span>
      <div style="height:4px;background:${c.surfaceElevated};border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;"></div>
      </div>
      <span style="color:${c.textPrimary};font-size:11px;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;text-align:right;">${val.toFixed(2)}</span>
    </div>`;
    })
    .join('');
}

function buildZoneHtml(zone: VDFZone, index: number, isBest: boolean): string {
  const c = getThemeColors();
  const recomputed = recomputeVDFZoneScore(zone);
  const scoreInt = Math.round(recomputed * 100);
  const serverScoreInt = Math.round(zone.score * 100);
  const isCustomWeights = !VDF_COMPONENTS.every((comp) => vdfWeights[comp.key] === comp.defaultWeight);
  const label = isBest ? `Zone ${index + 1} (Primary)` : `Zone ${index + 1}`;
  const color = vdfScoreColor(scoreInt);

  let metricsLine = '';
  const parts: string[] = [];
  if (zone.overallPriceChange !== null && zone.overallPriceChange !== undefined)
    parts.push(`Price: ${zone.overallPriceChange >= 0 ? '+' : ''}${zone.overallPriceChange.toFixed(1)}%`);
  if (zone.netDeltaPct !== null && zone.netDeltaPct !== undefined)
    parts.push(`Net Delta: ${zone.netDeltaPct >= 0 ? '+' : ''}${zone.netDeltaPct.toFixed(1)}%`);
  if (zone.absorptionPct !== null && zone.absorptionPct !== undefined)
    parts.push(`Absorption: ${zone.absorptionPct.toFixed(1)}%`);
  if (parts.length)
    metricsLine = `<div style="margin:4px 0;color:${c.textSecondary};font-size:12px;">${parts.join(' &nbsp;|&nbsp; ')}</div>`;

  let detailLine = '';
  const dParts: string[] = [];
  if (zone.accumWeeks !== null && zone.accumWeeks !== undefined && zone.weeks)
    dParts.push(`Accum weeks: ${zone.accumWeeks}/${zone.weeks} (${Math.round((zone.accumWeeks / zone.weeks) * 100)}%)`);
  if (zone.durationMultiplier !== null && zone.durationMultiplier !== undefined)
    dParts.push(`Duration: ${zone.durationMultiplier.toFixed(3)}x`);
  if (zone.concordancePenalty !== null && zone.concordancePenalty !== undefined && zone.concordancePenalty < 1.0)
    dParts.push(`Concordance: ${zone.concordancePenalty.toFixed(3)}x`);
  if (dParts.length)
    detailLine = `<div style="margin:2px 0;color:${c.textSecondary};font-size:12px;">${dParts.join(' &nbsp;|&nbsp; ')}</div>`;

  let componentsHtml = '';
  if (zone.components) {
    componentsHtml = `<div style="margin-top:8px;"><div style="color:${c.textSecondary};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Components</div>${buildComponentBarsHtml(zone.components as unknown as Record<string, number>)}</div>`;
  }

  const scoreDiffHtml =
    isCustomWeights && serverScoreInt !== scoreInt
      ? `<span style="font-size:10px;color:${c.textMuted};margin-left:4px;">(was ${serverScoreInt})</span>`
      : '';

  return `<div style="background:${c.cardBg};border:1px solid ${c.surfaceElevated};border-radius:4px;padding:12px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-weight:600;font-size:13px;color:${c.textPrimary};">${escapeHtml(label)}</span>
      <span><span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${color};">${scoreInt}</span>${scoreDiffHtml}</span>
    </div>
    <div style="color:${c.textPrimary};font-size:12px;">${formatVDFDate(zone.startDate)} \u2192 ${formatVDFDate(zone.endDate)} (${zone.windowDays} trading days${zone.weeks ? `, ${zone.weeks} wk` : ''})</div>
    ${metricsLine}
    ${detailLine}
    ${componentsHtml}
  </div>`;
}

function buildDistributionHtml(dist: VDFDistribution, index: number): string {
  const c = getThemeColors();
  let detail = '';
  const parts: string[] = [];
  if (dist.priceChangePct !== null && dist.priceChangePct !== undefined)
    parts.push(`Price ${dist.priceChangePct >= 0 ? '+' : ''}${dist.priceChangePct.toFixed(1)}%`);
  if (dist.netDeltaPct !== null && dist.netDeltaPct !== undefined)
    parts.push(`Delta ${dist.netDeltaPct >= 0 ? '+' : ''}${dist.netDeltaPct.toFixed(1)}%`);
  if (parts.length) detail = parts.join(' while ') + ' \u2014 selling into strength.';

  return `<div style="background:rgba(239,83,80,0.06);border:1px solid rgba(239,83,80,0.2);border-radius:4px;padding:10px 12px;margin-bottom:8px;">
    <div style="font-weight:600;font-size:12px;color:#ef5350;margin-bottom:2px;">Cluster ${index + 1}: ${formatVDFDate(dist.startDate)} \u2192 ${formatVDFDate(dist.endDate)} (${dist.spanDays} days)</div>
    ${detail ? `<div style="color:${c.textSecondary};font-size:12px;">${escapeHtml(detail)}</div>` : ''}
  </div>`;
}

function buildProximityHtml(prox: VDFProximity): string {
  if (prox.level === 'none' && prox.compositeScore === 0) return '';
  const c = getThemeColors();
  const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
  const levelColor = vdfProximityColor(prox.level);

  const signalRows = prox.signals
    .map(
      (sig) =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:12px;">
      <span style="color:${c.textPrimary};">\u2713 ${escapeHtml(sig.detail)}</span>
      <span style="color:${levelColor};font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-weight:600;white-space:nowrap;margin-left:12px;">+${sig.points}</span>
    </div>`,
    )
    .join('');

  return `<div style="margin-top:4px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${levelColor};">${prox.compositeScore} pts</span>
      <span style="font-size:11px;font-weight:600;color:${levelColor};border:1px solid ${levelColor};border-radius:3px;padding:0 5px;line-height:16px;">${levelLabel}</span>
    </div>
    ${signalRows}
  </div>`;
}

// ─── Panel Lifecycle ────────────────────────────────────────────────────────

export function ensureVDFAnalysisPanel(): HTMLDivElement {
  if (vdfAnalysisPanelEl) return vdfAnalysisPanelEl;
  const c = getThemeColors();
  const chartContent = document.getElementById('chart-content');
  if (!chartContent) return document.createElement('div');
  const panel = document.createElement('div');
  panel.id = 'vdf-analysis-panel';
  panel.style.cssText = `width:100%;border-radius:6px;border:1px solid ${c.borderColor};background:${c.bgColor};color:${c.textPrimary};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;overflow:hidden;display:none;`;
  chartContent.insertBefore(panel, chartContent.firstChild);
  vdfAnalysisPanelEl = panel;
  return panel;
}

export function toggleVDFAnalysisPanel(): void {
  if (!vdfAnalysisPanelEl) return;
  const body = vdfAnalysisPanelEl.querySelector('.vdf-ap-body') as HTMLElement | null;
  if (!body) return;
  const isCollapsed = body.style.display === 'none';
  body.style.display = isCollapsed ? 'block' : 'none';
  const chevron = vdfAnalysisPanelEl.querySelector('.vdf-ap-chevron') as HTMLElement | null;
  if (chevron) chevron.textContent = isCollapsed ? '\u25be' : '\u25b8';
  try {
    localStorage.setItem('chart_vdf_panel_collapsed', isCollapsed ? '0' : '1');
  } catch {
    /* */
  }
}

export function clearVDFAnalysisPanel(): void {
  if (!vdfAnalysisPanelEl) return;
  vdfAnalysisPanelEl.style.display = 'none';
  vdfAnalysisPanelEl.innerHTML = '';
}

export function renderVDFAnalysisPanel(entry: VDFCacheEntry | null, ticker: string): void {
  lastRenderedVDFEntry = entry;
  lastRenderedVDFTicker = ticker;
  loadVDFWeightsFromStorage();
  const panel = ensureVDFAnalysisPanel();
  const c = getThemeColors();

  if (!entry) {
    // Show panel in grayed-out placeholder state (visible like other panes before data arrives)
    panel.innerHTML = `<div class="vdf-ap-header" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;user-select:none;border-bottom:1px solid ${c.surfaceElevated};opacity:0.45;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="vdf-ap-chevron" style="font-size:12px;color:${c.textSecondary};width:12px;">\u25b8</span>
        <span style="font-weight:600;color:${c.textPrimary};">Analysis</span>
        ${ticker ? `<span style="color:${c.textSecondary};font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:12px;">${escapeHtml(ticker)}</span>` : ''}
      </div>
    </div>`;
    panel.style.display = 'block';
    return;
  }

  // Use best zone recomputed score for the header
  const bestZone = entry.zones[0];
  const recomputedBestScore = bestZone ? Math.round(recomputeVDFZoneScore(bestZone) * 100) : 0;
  const score = entry.is_detected ? recomputedBestScore : Math.round(entry.composite_score * 100);
  const tier = vdfScoreTier(score);
  const color = vdfScoreColor(score);
  const metrics = entry.details?.metrics;

  let collapsed = true;
  try {
    collapsed = localStorage.getItem('chart_vdf_panel_collapsed') !== '0';
  } catch {
    /* */
  }

  const chevron = collapsed ? '\u25b8' : '\u25be';
  const bodyDisplay = collapsed ? 'none' : 'block';

  // Header
  const headerHtml = `<div class="vdf-ap-header" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none;border-bottom:1px solid ${c.surfaceElevated};">
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="vdf-ap-chevron" style="font-size:12px;color:${c.textSecondary};width:12px;">${chevron}</span>
      <span style="font-weight:600;color:${c.textPrimary};">Analysis</span>
      <span style="color:${c.textSecondary};font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:12px;">${escapeHtml(ticker)}</span>
    </div>
    <div style="display:flex;align-items:center;">
      ${
        entry.is_detected
          ? `<span style="font-size:11px;color:${c.textMuted};">${escapeHtml(tier)}</span>`
          : `<span style="font-size:11px;color:${c.textMuted};">Not detected</span>`
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
    bodyHtml = `<div style="padding:14px;color:${c.textSecondary};font-size:13px;">No accumulation patterns detected in the scan period.${scanInfo}</div>`;
  } else {
    const zoneCount = entry.zones.length;
    let assessParts = `Volume-delta accumulation <span style="color:${color};font-weight:600;">${tier}</span> (score: ${score}).`;
    assessParts += ` ${zoneCount} accumulation zone${zoneCount !== 1 ? 's' : ''} detected`;
    if (entry.weeks) assessParts += ` spanning up to ${entry.weeks} weeks`;
    assessParts += '.';
    if (metrics?.scanStart && metrics?.scanEnd) {
      assessParts += ` Scan: ${formatVDFDate(metrics.scanStart)} \u2192 ${formatVDFDate(metrics.scanEnd)}`;
      if (metrics.totalDays) assessParts += ` (${metrics.totalDays} trading days)`;
      assessParts += '.';
    }
    if (entry.distribution.length > 0) {
      assessParts += ` <span style="color:#ef5350;">${entry.distribution.length} distribution cluster${entry.distribution.length !== 1 ? 's' : ''}</span> also found.`;
    }

    const assessHtml = `<div style="margin-bottom:16px;font-size:13px;color:${c.textPrimary};">${assessParts}</div>`;

    // Chart legend
    const swatchStyle =
      'display:inline-block;width:14px;height:5px;border-radius:1px;vertical-align:middle;margin-right:5px;';
    const dashStyle =
      'display:inline-block;width:14px;height:0;border-top:1px dashed;vertical-align:middle;margin-right:5px;';
    const glowStyle =
      'display:inline-block;width:3px;height:12px;border-radius:1px;vertical-align:middle;margin-right:5px;';
    const legendItems: string[] = [];
    legendItems.push(
      `<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(38,166,154,0.7);"></span>Accumulation</span>`,
    );
    if (entry.distribution.length > 0) {
      legendItems.push(
        `<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(239,83,80,0.65);"></span>Distribution</span>`,
      );
    }
    const hasAbsorption = entry.zones.some((z) => (z.absorptionPct || 0) >= 5);
    if (hasAbsorption) {
      legendItems.push(
        `<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(255,167,38,0.7);"></span>Absorption</span>`,
      );
    }
    legendItems.push(
      `<span style="white-space:nowrap;"><span style="${dashStyle}border-color:rgba(38,166,154,0.4);"></span>Zone bounds</span>`,
    );
    const proxLegend = entry.proximity;
    if (proxLegend && proxLegend.level !== 'none' && proxLegend.compositeScore > 0) {
      const plc = vdfProximityColor(proxLegend.level);
      legendItems.push(
        `<span style="white-space:nowrap;"><span style="${glowStyle}background:${plc};box-shadow:0 0 4px ${plc};"></span>Proximity</span>`,
      );
    }
    const legendHtml = `<div style="display:flex;flex-wrap:wrap;gap:12px 16px;padding:8px 12px;background:${c.cardBg};border:1px solid ${c.surfaceElevated};border-radius:4px;margin-bottom:16px;font-size:11px;color:${c.textSecondary};">${legendItems.join('')}</div>`;

    // Zones section
    const sectionStyle = `font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${c.textSecondary};margin:16px 0 8px;border-bottom:1px solid ${c.surfaceElevated};padding-bottom:4px;`;
    let zonesHtml = '';
    if (entry.zones.length > 0) {
      zonesHtml = `<div style="${sectionStyle}">Accumulation Zones</div>`;
      zonesHtml += entry.zones.map((z, i) => buildZoneHtml(z, i, i === 0)).join('');
    }

    // Distribution section
    let distHtml = '';
    if (entry.distribution.length > 0) {
      distHtml = `<div style="${sectionStyle}">Distribution Clusters</div>`;
      distHtml += entry.distribution.map((d, i) => buildDistributionHtml(d, i)).join('');
    }

    // Proximity section
    let proxHtml = '';
    const prox = entry.proximity;
    if (prox && (prox.level !== 'none' || prox.compositeScore > 0)) {
      const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
      proxHtml = `<div style="${sectionStyle}">Proximity Signals (${prox.compositeScore} pts \u2014 ${levelLabel})</div>`;
      proxHtml += buildProximityHtml(prox);
    }

    bodyHtml = `<div style="padding:14px;">${assessHtml}${legendHtml}${zonesHtml}${distHtml}${proxHtml}</div>`;
  }

  panel.innerHTML = `${headerHtml}<div class="vdf-ap-body" style="display:${bodyDisplay};">${bodyHtml}</div>`;
  panel.style.display = 'block';

  // Bind header click for toggle
  const header = panel.querySelector('.vdf-ap-header');
  if (header) {
    header.addEventListener('click', () => {
      toggleVDFAnalysisPanel();
    });
  }
}

// Re-render VDF panel when theme changes so inline colors update
window.addEventListener('themechange', () => {
  if (!vdfAnalysisPanelEl || vdfAnalysisPanelEl.style.display === 'none') return;
  // Update the outer panel container styles immediately
  const c = getThemeColors();
  vdfAnalysisPanelEl.style.cssText = `width:100%;border-radius:6px;border:1px solid ${c.borderColor};background:${c.bgColor};color:${c.textPrimary};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;overflow:hidden;display:block;`;
  // Re-render content with new theme colors
  if (lastRenderedVDFTicker) {
    renderVDFAnalysisPanel(lastRenderedVDFEntry, lastRenderedVDFTicker);
  }
});
