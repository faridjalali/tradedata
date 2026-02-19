/**
 * Barrel re-export — preserves the original public API so consumers
 * (main.ts, ticker.ts) don't need to change their imports.
 */

// Wire scan-control callbacks at import time (before any consumer calls)
import { initScanControl } from './divergenceScanControl';
import {
  renderDivergenceContainer,
  renderDivergenceOverview,
  fetchDivergenceSignals,
  fetchDivergenceSignalsByTimeframe,
} from './divergenceFeedRender';

initScanControl({
  renderDivergenceContainer,
  renderDivergenceOverview,
  fetchDivergenceSignals,
  fetchDivergenceSignalsByTimeframe,
});

// --- Re-exports: feed rendering, sorting, filtering, column config ---

export type { ColumnFeedMode } from './divergenceFeedRender';
export {
  getColumnFeedMode,
  setColumnFeedMode,
  setColumnCustomDates,
  filterToLatestNDates,
  initializeDivergenceSortDefaults,
  setDivergenceDailySort,
  setDivergenceWeeklySort,
  fetchDivergenceSignals,
  fetchDivergenceSignalsByTimeframe,
  renderDivergenceOverview,
  renderDivergenceContainer,
} from './divergenceFeedRender';

// --- Re-exports: scan control ---

export {
  syncDivergenceScanUiState,
  initFetchButtons,
  runManualDivergenceScan,
  togglePauseResumeManualDivergenceScan,
  stopManualDivergenceScan,
  runManualDivergenceTableBuild,
  togglePauseResumeManualDivergenceTableBuild,
  stopManualDivergenceTableBuild,
  hydrateDivergenceTablesNow,
  shouldAutoRefreshDivergenceFeed,
} from './divergenceScanControl';

// --- Re-exports: event delegation ---

export { setupDivergenceFeedDelegation } from './divergenceFeedEvents';
