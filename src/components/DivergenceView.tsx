import { useStore } from 'zustand';
import { divergenceStore } from '../store/divergenceStore';
import { createAlertSortFn } from '../utils';
import { Alert } from '../types';
import { fetchDivergenceSignalsByTimeframe, setColumnFeedMode, setColumnCustomDates } from '../divergenceFeedRender';
import { DIVERGENCE_LOOKBACK_DAYS } from '../divergenceTable';
import type { ColumnKey, ColumnFeedMode } from '../store/divergenceStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFormatAlertCardDate(rawDate: string | null | undefined): string {
  const value = String(rawDate || '').trim();
  if (!value) return '';

  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnlyMatch) {
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    if (Number.isFinite(month) && month > 0 && Number.isFinite(day) && day > 0) {
      return `${month}/${day}`;
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
}

/** Apply column feed mode date filter */
function filterToLatestNDates(alerts: Alert[], n: number): Alert[] {
  const dates = new Set<string>();
  for (const a of alerts) {
    const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
    if (d) dates.add(d);
  }
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  const topN = new Set(sorted.slice(0, n));
  return alerts.filter((a) => {
    const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
    return d ? topN.has(d) : false;
  });
}

function applyColumnDateFilter(alerts: Alert[], mode: ColumnFeedMode): Alert[] {
  if (mode === '1') return filterToLatestNDates(alerts, 1);
  if (mode === '5') return filterToLatestNDates(alerts, 5);
  if (mode === '30') return filterToLatestNDates(alerts, 30);
  return alerts; // 'custom' — server already filtered
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function AlertCard({ alert }: { alert: Alert }) {
  const timeStr = formatFormatAlertCardDate(alert.signal_trade_date || alert.divergence_trade_date || alert.timestamp) || '--';
  const source = 'DataAPI';
  const maStates = alert.ma_states || {};

  let isBull = false;
  let isBear = false;

  if (alert.signal_direction !== undefined && alert.signal_direction !== null) {
    const dir = Number(alert.signal_direction);
    isBull = dir === 1;
    isBear = dir === -1;
  } else {
    isBull = !!(alert.signal_type && alert.signal_type.toLowerCase().includes('bull'));
    isBear = !isBull;
  }

  const cardClass = isBull ? 'bullish-card' : isBear ? 'bearish-card' : '';

  const isFav = alert.is_favorite === true || String(alert.is_favorite).toLowerCase() === 'true';
  const starClass = isFav ? 'fav-icon filled' : 'fav-icon';

  const checkmarkVisibility = isFav ? 'visible' : 'hidden';
  const checkmarkOpacity = isFav ? '1' : '0';

  return (
    <div className={`alert-card ${cardClass}`} data-ticker={alert.ticker} data-source={source}>
      <div className="card-group card-group-id">
        <svg
          className={starClass}
          data-id={alert.id}
          data-source={source}
          viewBox="0 0 24 24"
          width="15"
          height="15"
          stroke="currentColor"
          strokeWidth="2.25"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <polyline
            className="check-mark"
            points="7.5 12.5 10.5 15.5 16.5 9.5"
            style={{ visibility: checkmarkVisibility, opacity: checkmarkOpacity }}
          />
        </svg>
        <h3>{alert.ticker}</h3>
      </div>
      <div className="card-group card-group-divvol">
        <span className="div-dot-row" data-ticker={alert.ticker} title={`Divergence (${DIVERGENCE_LOOKBACK_DAYS.join(', ')}d)`}>
          {DIVERGENCE_LOOKBACK_DAYS.map((days) => {
            const state = String(alert.divergence_states?.[days] || 'neutral').toLowerCase();
            const cls = state === 'bullish' ? 'is-bullish' : state === 'bearish' ? 'is-bearish' : 'is-neutral';
            return <span key={days} className={`div-dot ${cls}`} data-days={days} />;
          })}
        </span>
      </div>
      <div className="card-group card-group-badges">
        {alert.vdf_detected && alert.vdf_score ? (
          <span 
            className={`vdf-score-badge${alert.vdf_proximity === 'imminent' ? ' vdf-imminent' : alert.vdf_proximity === 'high' ? ' vdf-high' : ''}`} 
            title="Score"
          >
            {alert.vdf_score}
          </span>
        ) : alert.vdf_detected ? (
          <span className="vdf-tag">VDF</span>
        ) : (
          <span className="vdf-score-placeholder" />
        )}
        {alert.bull_flag_confidence !== null && alert.bull_flag_confidence !== undefined && alert.bull_flag_confidence >= 50 ? (
          <span className="bull-flag-badge" title={`Bull flag (${alert.bull_flag_confidence}%)`}>B</span>
        ) : (
          <span className="bull-flag-placeholder" />
        )}
      </div>
      <span className="ma-dot-row" title="8 EMA - 21 EMA - 50 SMA - 200 SMA">
        <span className={`ma-dot ${maStates.ema8 ? 'is-up' : 'is-down'}`} />
        <span className={`ma-dot ${maStates.ema21 ? 'is-up' : 'is-down'}`} />
        <span className={`ma-dot ${maStates.sma50 ? 'is-up' : 'is-down'}`} />
        <span className={`ma-dot ${maStates.sma200 ? 'is-up' : 'is-down'}`} />
      </span>
      <span className="alert-time">{timeStr}</span>
    </div>
  );
}

function DivergenceColumn({ columnKey, title, timeframe }: { columnKey: ColumnKey, title: string, timeframe: '1d' | '1w' }) {
  const columnState = useStore(divergenceStore, (s) => s.columns[columnKey]);
  const allSignals = useStore(divergenceStore, (s) => s.signals);

  let signals = allSignals.filter((a) => (a.timeframe || '').trim() === timeframe);
  signals = applyColumnDateFilter(signals, columnState.feedMode);
  
  if (columnState.sortMode === 'favorite') {
    signals = signals.filter((a) => a.is_favorite);
  }

  signals.sort(createAlertSortFn(columnState.sortMode === 'favorite' ? 'time' : columnState.sortMode, columnState.sortDirection));

  const total = signals.length;
  const slice = signals.slice(0, columnState.visibleCount);

  const handleFeedModeClick = (mode: ColumnFeedMode) => {
    setColumnFeedMode(columnKey, mode, true);
  };

  const handleCustomDateApply = () => {
    const fromInput = document.querySelector(`.column-tf-controls[data-column="${columnKey}"] .column-tf-from`) as HTMLInputElement | null;
    const toInput = document.querySelector(`.column-tf-controls[data-column="${columnKey}"] .column-tf-to`) as HTMLInputElement | null;
    if (fromInput?.value && toInput?.value) {
      setColumnCustomDates(columnKey, fromInput.value, toInput.value);
      fetchDivergenceSignalsByTimeframe(timeframe);
    }
  };

  const setDivergenceSort = (mode: any) => {
    const store = divergenceStore.getState();
    const s = store.getColumn(columnKey);
    let newSort = s.sortMode;
    let newDir = s.sortDirection;
    let newPreFav = s.preFavSortMode;
    let newPreFavDir = s.preFavSortDirection;
  
    if (mode === 'favorite' && s.sortMode === 'favorite') {
      newSort = s.preFavSortMode ?? 'score';
      newDir = s.preFavSortDirection;
      newPreFav = null;
    } else if (mode === 'favorite') {
      newPreFav = s.sortMode;
      newPreFavDir = s.sortDirection;
      newSort = 'favorite';
      newDir = 'desc';
    } else if (mode === s.sortMode) {
      newDir = s.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      newSort = mode;
      newDir = 'desc';
      newPreFav = null;
    }
  
    store.setColumnSort(columnKey, newSort, newDir);
    store.setColumnPreFavSort(columnKey, newPreFav, newPreFavDir);
    store.setColumnVisibleCount(columnKey, 100);
  };

  const handleShowMore = () => {
    divergenceStore.getState().incrementColumnVisibleCount(columnKey);
  };

  return (
    <div className="column">
      <div className="column-header">
        <div className="header-title-group">
          <h2>{title}</h2>
          <div className="column-tf-controls" data-column={columnKey}>
            <button className={`pane-btn ${columnState.feedMode === '1' ? 'active' : ''}`} data-tf="1" onClick={() => handleFeedModeClick('1')} title="Last fetch day">1</button>
            <button className={`pane-btn ${columnState.feedMode === '5' ? 'active' : ''}`} data-tf="5" onClick={() => handleFeedModeClick('5')} title="Last 5 fetch days">5</button>
            <button className={`pane-btn ${columnState.feedMode === '30' ? 'active' : ''}`} data-tf="30" onClick={() => handleFeedModeClick('30')} title="Last 30 fetch days">30</button>
            <button className={`pane-btn ${columnState.feedMode === 'custom' ? 'active' : ''}`} data-tf="custom" onClick={() => handleFeedModeClick('custom')} title="Custom date range">C</button>
            <div className={`column-tf-custom-panel header-dropdown-panel ${columnState.feedMode === 'custom' ? 'open' : 'hidden'}`}>
              <input type="date" className="glass-input column-tf-from" defaultValue={columnState.customFrom} />
              <span className="column-tf-sep">to</span>
              <input type="date" className="glass-input column-tf-to" defaultValue={columnState.customTo} />
              <button className="pane-btn column-tf-apply" onClick={handleCustomDateApply}>&#x203A;</button>
            </div>
          </div>
        </div>
        <div className={`header-sort-controls divergence-${columnKey}-sort`}>
          <button className={`pane-btn ${columnState.sortMode === 'favorite' ? 'active' : ''}`} data-sort="favorite" onClick={() => setDivergenceSort('favorite')} title="Favorites only">
            <svg viewBox="0 0 24 24" fill="none" width="13" height="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
          <button className={`pane-btn ${columnState.sortMode === 'time' ? 'active' : ''}`} data-sort="time" onClick={() => setDivergenceSort('time')} title="Sort by Date">D</button>
          <button className={`pane-btn ${columnState.sortMode === 'volume' ? 'active' : ''}`} data-sort="volume" onClick={() => setDivergenceSort('volume')} title="Sort by Volume">V</button>
          <button className={`pane-btn ${columnState.sortMode === 'score' ? 'active' : ''}`} data-sort="score" onClick={() => setDivergenceSort('score')} title="Sort by Score">S</button>
        </div>
      </div>
      <div id={`divergence-${columnKey}-container`} className="alerts-list">
        {slice.map((alert) => (
          <AlertCard key={`${alert.id}-${alert.ticker}`} alert={alert} />
        ))}
        {total > slice.length && (
          <button className="pane-btn show-more-btn" onClick={handleShowMore}>
             ▼ Show {Math.min(100, total - slice.length)} more ({slice.length}/{total})
          </button>
        )}
      </div>
    </div>
  );
}

export function DivergenceView() {
  return (
    <div id="divergence-dashboard-view" className="split-view">
      <DivergenceColumn columnKey="daily" title="Daily" timeframe="1d" />
      <DivergenceColumn columnKey="weekly" title="Weekly" timeframe="1w" />
    </div>
  );
}
