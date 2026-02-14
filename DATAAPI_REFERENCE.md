# Tradedata DataAPI Reference

This document is the authoritative handoff for the **DataAPI + divergence** system currently implemented in this repository.

Scope:

- Included: custom chart, divergence pipeline, divergence tables, alert-card hydration, Railway deployment for app + divergence DB.
- Excluded by design: legacy TradingView integrations (fully removed).

## 1) System Overview

Primary runtime:

- Backend: `index.js` (Express + Postgres + scheduler + chart math orchestration)
- Frontend: `src/main.ts`, `src/chart.ts`, `src/divergenceFeed.ts`, `src/divergenceTable.ts`

Data provider:

- Massive (renamed in code as **DataAPI**) via `https://api.massive.com`.

Databases:

- `DATABASE_URL`: primary app DB (legacy `alerts` still exists)
- `DIVERGENCE_DATABASE_URL`: dedicated divergence DB (all DataAPI divergence persistence)

Deployed topology on Railway:

- Service `tradedata` (Node app)
- Service `Postgres` (primary DB)
- Service `Postgres-l-iG` (divergence DB)

## 2) Backend Architecture (DataAPI path)

### 2.1 Route registration

Implemented in `index.js` through modular route files:

- `registerChartRoutes(...)` from `server/routes/chartRoutes.js`
- `registerDivergenceRoutes(...)` from `server/routes/divergenceRoutes.js`
- `registerHealthRoutes(...)` from `server/routes/healthRoutes.js`

### 2.2 Key DataAPI endpoints

Chart:

- `GET /api/chart`
- `GET /api/chart/latest`
- `GET /api/chart/divergence-summary`

Divergence feed + controls:

- `GET /api/divergence/signals`
- `POST /api/divergence/signals/:id/favorite`
- `GET /api/divergence/scan/status`
- `POST /api/divergence/scan`
- `POST /api/divergence/scan/pause`
- `POST /api/divergence/scan/resume`
- `POST /api/divergence/scan/stop`
- `POST /api/divergence/table/run`
- `POST /api/divergence/table/pause`
- `POST /api/divergence/table/resume`
- `POST /api/divergence/table/stop`
- `POST /api/divergence/fetch-all/run`
- `POST /api/divergence/fetch-all/stop`

Ops:

- `GET /healthz`
- `GET /readyz`
- `GET /api/debug/metrics`

## 3) Data Model (Divergence DB)

Initialized automatically on app startup by `initDivergenceDB()` in `index.js`.

### 3.1 Tables

`divergence_symbols`

- Universe of US stocks (long-lived store)
- `ticker` PK
- `exchange`, `asset_type`, `is_active`, `updated_at`

`divergence_scan_jobs`

- Run-level metadata for scan jobs
- Tracks status/progress counts and dates

`divergence_signals`

- Daily bullish/bearish signal rows
- Unique key: `(trade_date, ticker, timeframe, source_interval)`

`divergence_daily_bars`

- Per ticker/day rollup used for divergence summary computation
- PK: `(ticker, trade_date, source_interval)`

`divergence_summaries`

- Materialized divergence table states and MA states
- PK: `(ticker, source_interval)`
- Fields: `state_1d`, `state_3d`, `state_7d`, `state_14d`, `state_28d`, `ma8_above`, `ma21_above`, `ma50_above`, `ma200_above`, `trade_date`

`divergence_publication_state`

- Tracks published trade date by `source_interval`

## 4) Core Logic Definitions

### 4.1 Price candles / timeframe sourcing

Provider aggregation mapping in `index.js` (`DATA_API_AGG_INTERVAL_MAP`):

- `1min`, `5min`, `15min`, `30min`, `1hour`, `4hour`, `1day`, `1week`

Chart lookback:

- `getIntradayLookbackDays()` returns **548 days** (~1.5 years) for all chart intervals.

Direct vs derived candles in `buildChartResultFromRows()`:

- `1day`:
  - preferred: direct `1day` rows from DataAPI
  - fallback: aggregate `4hour -> 1day`
- `1week`:
  - preferred: direct `1week` rows from DataAPI
  - fallback chain: `1day -> 1week`, else `4hour -> 1day -> 1week`

### 4.2 Volume Delta definition

Volume delta is computed against parent bars using lower timeframe source bars:

- Parent bar timeframe = chart interval (or forced `1day` in summary builds)
- Lower timeframe source = user-selected source interval (default `1min`)
- Signed contribution rule per source bar is implemented in `computeVolumeDeltaByParentBars()` and associated helpers.
- Cumulative-volume normalization is handled by `normalizeIntradayVolumesFromCumulativeIfNeeded()`.

### 4.3 Divergence signal definition (single bar)

Implemented in `classifyDivergenceSignal()`:

- Bullish divergence: `volume_delta > 0` AND `close < prev_close`
- Bearish divergence: `volume_delta < 0` AND `close > prev_close`
- Otherwise: neutral/no signal

### 4.4 Divergence table states (1/3/7/14/28)

Canonical classification logic:

- `classifyDivergenceStateMapFromDailyRows()` (DB-backed path)
- `computeDivergenceSummaryStatesFromDailyResult()` (chart-result path)

For each lookback window N days:

1. Compare latest close vs start close of window.
2. Compute summed volume delta over bars strictly **after** start close up to latest close.
3. Assign:
   - bullish if endClose < startClose and sumDelta > 0
   - bearish if endClose > startClose and sumDelta < 0
   - neutral otherwise

### 4.5 As-of date for daily candle availability

`resolveLastClosedDailyCandleDate()`:

- Uses ET calendar/time.
- Treats daily candle as available at/after **4:16 PM ET** (Massive delay-aware threshold).
- Before threshold or on weekends, uses previous trading day.

### 4.6 MA dots (alert cards)

Per ticker during fetch-all:

- Fetches DataAPI indicator latest values:
  - EMA 8, EMA 21, SMA 50, SMA 200
- Compares latest close to each indicator:
  - above => green dot
  - below => red dot
- Stored in `divergence_summaries` as booleans.

### 4.7 Score sorting definition

Frontend score logic in `src/divergenceTable.ts` (`computeDivergenceScoreFromStates`):

- Weights: `1d=3`, `3d=3`, `7d=2`, `14d=2`, `28d=1`
- Bullish adds weight; bearish subtracts weight.
- MA states currently add +/-1 each when provided.

Tie-break behavior in feed sorting is handled by `createAlertSortFn(...)` in `src/utils.ts`.

## 5) Job Pipelines

### 5.1 Scheduled daily pipeline

Scheduler in `index.js`:

- `getNextDivergenceScanUtcMs()` schedules weekday runs at **4:20 PM ET**.
- `runScheduledDivergencePipeline()` executes:
  1. `runDailyDivergenceScan(...)`
  2. if completed, `runDivergenceTableBuild(...)`

### 5.2 `Run Fetch` (`runDailyDivergenceScan`)

Purpose:

- Scan universe for daily bullish/bearish divergence signals.
- Upsert `divergence_daily_bars`, `divergence_signals`, then rebuild/publish summaries for scan date.

Key controls:

- Pause/resume/stop flags and resume state
- Concurrency and progress-write controls

### 5.3 `Run Table` (`runDivergenceTableBuild`)

Purpose:

- Build/rebuild divergence summaries from stored daily bars.
- Supports backfill and summarization phases.

Behavior:

- Backfills missing ticker history as needed.
- Summarizes all requested tickers.
- Flushes summary rows in batches.
- Persists resume state for pause/stop/failure recovery.

### 5.4 `Fetch All Data` (`runDivergenceFetchAllData`)

Purpose:

- Iterate all `divergence_symbols`.
- Build ticker daily rows + summary states + MA states.
- Upsert incrementally while run is in progress.
- Sync 1-day signal cards from summary rows.

Behavior:

- On fresh run: clears same-day `divergence_signals` for the source interval and repopulates.
- Persists resumable state and supports hard stop.
- Uses on-the-fly flush batching to avoid holding all results until completion.

## 6) Frontend Architecture (DataAPI/Divergence)

### 6.1 Main view and nav

`src/main.ts`:

- Default landing view is `divergence` (header label `Alerts`).
- TV button is hidden in nav (`index.html`), but legacy logic remains in code.
- Page settings panel (global settings) contains:
  - Timezone dropdown
  - `Fetch All Data` button
  - `Stop` button
  - Fetch-all status text

### 6.2 Divergence feed module

`src/divergenceFeed.ts` responsibilities:

- Fetch/render divergence alerts (`fetchDivergenceSignals`, `renderDivergenceOverview`)
- Drive manual control buttons and statuses
- Poll `/api/divergence/scan/status`
- Trigger controlled card-table hydration while fetch-all is running

### 6.3 Divergence summary/table module

`src/divergenceTable.ts` responsibilities:

- Read preferred source interval from chart settings (`custom_chart_settings_v1`)
- Fetch `/api/chart/divergence-summary` in batches
- Normalize states and hydrate mini divergence rows in alert cards
- Compute score from states

Note:

- Client-side map exists for UI reuse, but source of truth is DB-backed API responses.

### 6.4 Custom chart module

`src/chart.ts` major behaviors:

- Renders 4 panes (VD, Price, RSI, VD-RSI) with pane reorder support.
- Period buttons: `5,15,30,1h,4h,1D,1W`.
- Live patching (`/api/chart/latest`) updates last bar in place.
- Prewarm sequence:
  - if `4h` loaded => prefetch `1D`, then `1W`
  - if `1D` loaded => prefetch `4h`, then `1W`
  - if `1W` loaded => prefetch `1D`, then `4h`
- Weekly initial visible range fixed to about 78 bars (~1.5 years).
- Future timeline extension supports forward cursor movement and synchronized crosshair.

Volume delta pane divergence table (`renderVolumeDeltaDivergenceSummary`):

- Uses same `/api/chart/divergence-summary` endpoint.
- Includes manual refresh button.
- Manual/auto refresh writes updated summary back into alert-card table rows via `syncTickerDivergenceSummaryToVisibleCards(...)`.

## 7) Cache and Performance Behavior

Backend caches (timed maps):

- Lower timeframe rows
- VD-RSI results
- raw chart rows
- quote cache (quote fetch currently stubbed)
- final chart result cache

Important note:

- `getCachedDivergenceSummaryEntry`, `setDivergenceSummaryCacheEntry`, and `clearDivergenceSummaryCacheForSourceInterval` are currently implemented as no-op return placeholders in `index.js` (DB is the practical summary source of truth).

Frontend caches:

- Chart data cache in memory + session persistence for fast interval switches.
- Divergence summary in-memory cache for fast alert-card redraws.

## 8) Function Map (high-value functions)

### Backend (`index.js`)

Startup/security:

- `validateStartupEnvironment()`
- `basicAuthMiddleware()`

DataAPI layer:

- `buildDataApiAggregateRangeUrl()`
- `fetchDataApiJson()`
- `fetchDataApiArrayWithFallback()`
- `dataApiIntraday()`
- `dataApiIntradayChartHistory()`
- `dataApiDaily()`
- `fetchDataApiIndicatorLatestValue()`
- `fetchDataApiMovingAverageStatesForTicker()`

Chart build:

- `buildChartResultFromRows()`
- `calculateRSI()`, `calculateVolumeDeltaRsiSeries()`
- `computeVolumeDeltaByParentBars()`
- `parseChartRequestParams()`
- `getOrBuildChartResult()`

Prewarm (extracted to `server/services/chartPrewarm.js`):

- `getPostLoadPrewarmSequence()`
- `schedulePostLoadPrewarmSequence()`
- `prewarmChartResult()`

Divergence summary:

- `classifyDivergenceStateMapFromDailyRows()`
- `buildDivergenceDailyRowsForTicker()`
- `getOrBuildTickerDivergenceSummary()`
- `getDivergenceSummaryForTickers()`

Divergence jobs:

- `runDailyDivergenceScan()`
- `runDivergenceTableBuild()`
- `runDivergenceFetchAllData()`
- `requestStopDivergenceFetchAllData()` and related pause/resume helpers

Scheduler:

- `getNextDivergenceScanUtcMs()`
- `runScheduledDivergencePipeline()`
- `scheduleNextDivergenceScan()`

### Frontend

`src/main.ts`:

- `switchView()`
- `initGlobalSettingsPanel()`
- `initializeSiteLock()`
- `bootstrapApplication()`

`src/divergenceFeed.ts`:

- `syncDivergenceScanUiState()`
- `runManualDivergenceFetchAllData()`
- `stopManualDivergenceFetchAllData()`
- `fetchDivergenceSignals()`
- `renderDivergenceOverview()`

`src/divergenceTable.ts`:

- `getTickerDivergenceSummary()`
- `hydrateAlertCardDivergenceTables()`
- `syncTickerDivergenceSummaryToVisibleCards()`
- `computeDivergenceScoreFromStates()`

`src/chart.ts`:

- `renderCustomChart()`
- `refreshLatestChartDataInPlace()`
- `renderVolumeDeltaDivergenceSummary()`
- `refreshActiveTickerDivergenceSummary()`

## 9) Railway Rebuild / Recreate Guide (DataAPI + Divergence DB)

### 9.1 Required services

Create in one Railway project/environment:

1. `tradedata` app service (this repo)
2. Primary Postgres service
3. Separate divergence Postgres service

### 9.2 Required env variables for `tradedata`

Minimum:

- `DATABASE_URL` -> primary Postgres connection string
- `DIVERGENCE_DATABASE_URL` -> divergence Postgres connection string
- `DATA_API_KEY` -> Massive API key

Recommended operational env:

- `DATA_API_REQUESTS_PAUSED=false`
- `DATA_API_MAX_REQUESTS_PER_SECOND=95` (or tuned value)
- `DATA_API_RATE_BUCKET_CAPACITY=95`
- `DIVERGENCE_SCANNER_ENABLED=true`
- `DIVERGENCE_SCAN_SECRET=<secret>`
- `DIVERGENCE_SCAN_CONCURRENCY`
- `DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY`
- `DIVERGENCE_TABLE_BUILD_CONCURRENCY` (default 24)
- `DIVERGENCE_SUMMARY_BUILD_CONCURRENCY`
- `DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE`
- `DIVERGENCE_STALL_TIMEOUT_MS`
- `DIVERGENCE_STALL_CHECK_INTERVAL_MS`
- `DIVERGENCE_STALL_RETRY_BASE_MS`
- `DIVERGENCE_STALL_MAX_RETRIES`

Security (optional):

- `BASIC_AUTH_ENABLED=true|false`
- `BASIC_AUTH_USERNAME`
- `BASIC_AUTH_PASSWORD`
- `BASIC_AUTH_REALM`

Do not commit real secrets in git. Keep values in Railway variables.

### 9.3 Deploy settings

- Start command: `npm run start`
- Recommended healthcheck path: `/readyz`
- Restart policy: `ON_FAILURE`

### 9.4 DB bootstrap behavior

No manual migration step is required for divergence DB in normal cases.
On startup, app runs:

- `initDB()` for primary DB (`alerts` table compatibility)
- `initDivergenceDB()` for divergence tables/indexes

If divergence schema is missing, startup auto-creates it.

### 9.5 Railway CLI examples

List vars:

```bash
./bin/railway variable list
```

Set vars (example):

```bash
./bin/railway variable set DATA_API_KEY=<your_key>
./bin/railway variable set DIVERGENCE_DATABASE_URL=<postgres_url>
```

Restart service:

```bash
./bin/railway restart --service tradedata
```

Status:

```bash
./bin/railway status --json
```

## 10) Operations Checklist

### Health checks

- `GET /healthz` => process liveness
- `GET /readyz` => DB readiness + divergence readiness context

### Manual control flow (UI)

Global settings panel:

- `Fetch All Data` starts complete rebuild over `divergence_symbols`
- Stop button sends immediate stop request
- Status text shows progress or latest run date

### Data correctness checkpoints

- Verify `divergence_trade_date` on card equals latest closed daily candle date.
- Verify 1/3/7/14/28 states against `divergence_daily_bars` and latest close trend.
- Verify MA dots align with latest close vs EMA/SMA values.

## 11) Known Legacy / Cleanup Notes

These remain in code but are not part of target long-term architecture:

- Some variable names/messages still mention old labels in isolated places (non-critical).

## 12) Backup Workflow

Preferred workflow (manual stable checkpoints):

1. Validate locally (`npm run lint`, `npm test`, optional `npm run build`).
2. Commit to `tradedata`.
3. Push to `origin`.
4. Mirror or push same commit to `tradedata-backup`.

Example mirror push:

```bash
git push --mirror https://github.com/faridjalali/tradedata-backup.git
```

---

If architecture changes, update this file first so future agents can reconstruct behavior and environment without reverse-engineering all modules.
