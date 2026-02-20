# Catvue — Market Divergence & Volume Analysis Platform

Real-time market data visualization platform for detecting volume-price divergence signals, analyzing volume distribution patterns (VDF), and monitoring market breadth. Built with Fastify, TypeScript, PostgreSQL, and Lightweight Charts.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [User Interface](#user-interface)
- [API Reference](#api-reference)
- [Data Model](#data-model)
- [Background Jobs](#background-jobs)
- [Caching Architecture](#caching-architecture)
- [Configuration Reference](#configuration-reference)
- [Operations & Runbook](#operations--runbook)
- [Development](#development)
- [Deployment](#deployment)

---

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL (single database via `DIVERGENCE_DATABASE_URL`)
- A market data API key

### Install & Run

```bash
npm ci
cp server/.env.example .env
# Edit .env with your DIVERGENCE_DATABASE_URL, DATA_API_KEY, etc.

npm run build        # Build frontend (Vite)
npm start            # Start server (tsx index.ts)
```

### Development Mode

```bash
# Terminal 1: Backend
npm start

# Terminal 2: Frontend dev server with hot reload
npm run dev          # Vite dev server on :5173, proxies /api → :3000
```

### Verify

```bash
npm run typecheck           # Frontend TypeScript check
npm run typecheck:server    # Server TypeScript check
npm test                    # Node.js test runner
npx playwright test         # Browser E2E suite
npm run build               # Vite production build
npm run lint:eslint         # ESLint
npm run format:check        # Prettier check
```

---

## Architecture Overview

### Tech Stack

| Layer           | Technology                                  |
| --------------- | ------------------------------------------- |
| **Server**      | Fastify 5, Node.js 22                       |
| **Language**    | TypeScript 5.9 (strict mode)                |
| **Database**    | PostgreSQL (pg), single divergence pool     |
| **Frontend**    | Preact + TypeScript, Lightweight Charts 4.2 |
| **Build**       | Vite 7 + @preact/preset-vite                |
| **Validation**  | Zod 4                                       |
| **Logging**     | Pino (structured JSON)                      |
| **Caching**     | LRU-cache (multi-tier with SWR)             |
| **HTTP Client** | Undici                                      |

### Directory Structure

```
index.ts                              Entry point: plugins, hooks, routes, startup, shutdown
index.html                            SPA shell

server/
  config.ts                           Centralized env-var constants + startup validation
  db.ts                               PostgreSQL connection pool (divergence-only)
  middleware.ts                        Auth middleware, validation wrappers, request metadata
  schemas.ts                          Zod schemas for all input validation
  logger.ts                           Pino structured logging + console redirect
  chartMath.ts                        Pure math: RSI, RMA, OHLCV aggregation
  db/
    initDb.ts                         Table creation (CREATE TABLE IF NOT EXISTS) on the divergence DB
  routes/
    chartRoutes.ts                    Chart data, mini-bars, VDF status, divergence summary, ticker info
    divergenceRoutes.ts               Scan control, signal queries, table build triggers
    alertRoutes.ts                    Alert listing, favorite toggle
    breadthRoutes.ts                  Market breadth data endpoint
    healthRoutes.ts                   /healthz, /readyz, /api/admin/status, /api/debug/metrics
  services/
    chartEngine.ts                    Multi-tier chart cache, SWR, data assembly
    chartIndicators.ts                Pure indicator math: RSI, RMA, volume delta, VD RSI
    chartPrewarm.ts                   Background interval pre-warming
    chartRequestService.ts            Chart request parsing + orchestration
    sessionAuth.ts                    Cookie-based session management
    dataApi.ts                        Market data API client with rate limiting
    metricsService.ts                 Chart timing + run metrics tracking
    miniBarService.ts                 Mini-chart bar caching (memory + DB)
    divergenceService.ts              Divergence state classification
    divergenceDbService.ts            Divergence DB queries + batch upserts
    divergenceStateService.ts         Divergence state normalization
    tickerHistoryService.ts           Ticker-level history + summary building
    vdfService.ts                     VDF detection + scan orchestration
    vdfDetector.ts                    Orchestrator: imports sub-modules, exports detectVDF
    vdfTypes.ts                       VDF shared type definitions (interfaces)
    vdfMath.ts                        Pure math: mean, std, linear regression
    vdfAggregation.ts                 1-min bar aggregation to daily/weekly buckets
    vdfScoring.ts                     8-component zone scoring with concordance gates
    vdfZoneDetection.ts               Accumulation zone clustering, distribution detection
    vdfProximitySignals.ts            7 proximity signals → composite score + level
    scanControlService.ts             Scan lifecycle (pause/stop/resume) management
    schedulerService.ts               Daily scan scheduler (4:20 PM ET)
    tradingCalendar.ts                US market holiday/early-close calendar
  orchestrators/
    dailyScanOrchestrator.ts          Daily divergence signal scan
    fetchDailyOrchestrator.ts         Daily OHLCV + MA backfill
    fetchWeeklyOrchestrator.ts        Weekly bar backfill
    tableBuildOrchestrator.ts         Divergence table construction
  lib/
    dateUtils.ts                      Timezone conversions, trading day math
    dbMonitor.ts                      Slow query detection
    mapWithConcurrency.ts             Configurable parallel worker pool
    ScanState.ts                      Reusable scan lifecycle state machine

src/                                  Frontend modules
  main.ts                             View switching, navigation, global state
  admin.ts                            Admin page: health, operations, metrics, history, prefs
  chart.ts                            Multi-pane chart rendering, tools, overlays
  divergenceFeed.ts                   Alert feed with filtering, sorting, pagination
  divergenceTable.ts                  Divergence summary badges
  divergenceScanControl.ts            Scan lifecycle UI: buttons, polling, status updates
  divergenceScanStatusFormat.ts       Pure status text formatters (no DOM deps)
  vdfAnalysisPanel.ts                 VDF analysis panel with zone details
  breadth.ts                          Market breadth comparison chart
  logs.ts                             Run metrics/history builders (reused by admin.ts)
  ticker.ts                           Ticker detail view
  theme.ts                            4 themes (dark, light, beige, claude)
  timezone.ts                         5 timezone options
  components.ts                       Reusable UI building blocks
  utils.ts                            Shared DOM helpers
  chartApi.ts                         Chart data fetch client
  divergenceApi.ts                    Divergence data fetch client

shared/
  api-types.ts                        Single source of truth: frontend <-> backend types

test/                                 Node.js built-in test runner
public/                               Static CSS, icons
```

### Module Dependency Flow

```
Routes → Services → Lib/Utils → Config
                 └→ DB
Orchestrators → Services → Lib/Utils
```

Routes never contain business logic. Services never import routes. No circular dependencies.

### Engineering Guardrails

- Module boundaries: `docs/module-boundaries.md`
- Ownership rules: `.github/CODEOWNERS`
- Pull request checklist: `.github/pull_request_template.md`
- Release/rollback runbook: `docs/release-runbook.md`

---

## User Interface

### Views

The application has three main views accessible from the header navigation:

#### 1. Alerts View (Default)

Two-column layout showing daily and weekly divergence signals.

**Each column provides:**

- Date range controls: 1, 5, 30 days, or custom date range (C button)
- Sort modes: Favorite, Date, Volume, Score
- Infinite scroll pagination (100 alerts per page)

**Each alert card displays:**

- Ticker symbol (clickable to open detail view)
- Divergence state dots for 1, 3, 7, 14, 28-day lookback periods (green = bullish, red = bearish, gray = neutral)
- Trading volume
- VDF score (when detected)
- Moving average dots: 8 EMA, 21 EMA, 50 SMA, 200 SMA (green = price above, red = price below)
- Trade date
- Mini candlestick chart on hover (desktop) or inline (mobile)

**Favorite system:** Star icon toggles bookmark status, persisted to database.

#### 2. Ticker Detail View

Opens when clicking an alert card. Shows:

**Left/right panels:** All daily and weekly alerts for the selected ticker.

**Multi-pane chart with 4 synchronized panes:**

| Pane             | Height | Content                                            |
| ---------------- | ------ | -------------------------------------------------- |
| Volume Delta     | 200px  | Cumulative volume delta histogram (green/red bars) |
| Price            | 400px  | OHLC candlestick chart with optional MA overlays   |
| RSI              | 200px  | Relative Strength Index (14-period default)        |
| Volume Delta RSI | 220px  | RSI of volume delta ratio                          |

**Chart intervals:** 5min, 15min, 30min, 1hour, 4hour, 1day (default), 1week

**Chart controls:**

- Refresh button (forces re-fetch, clears cache)
- Previous/Next ticker navigation (cycles through visible alert list)
- Fullscreen toggle (Escape to exit)
- Trendline drawing and eraser tools
- Divergence plotting tool (mark divergence between price and indicators)
- Per-pane settings: MA toggles, VD source interval, RSI length
- Ticker badge tooltip: click shows company info (name, SIC, market cap, description), auto-dismisses after 4s; click again opens ticker's website

**VDF Analysis Panel** (collapsible, appears when VDF data available):

- Detection status, composite score, tier (Marginal/Weak/Moderate/Strong)
- Accumulation zones with date ranges, scores, price change %, absorption %
- 8-component score breakdown with weighted contributions
- Distribution clusters
- Proximity signals with severity levels (imminent/high/elevated)
- Chart overlays for zones and proximity markers

**Divergence summary badges:** Below price pane, shows bullish/bearish/neutral state for 5 lookback periods.

#### 3. Breadth View

Market breadth analysis across 21 ETFs (SPY, QQQ, DIA, MDY, IWM, 11 sector ETFs, SMH, XBI, XHB, XRT, XAR, KRE). Four chart sections:

**Section 1 — SPY vs Metric:** Normalized line chart comparing SPY breadth against SVIX, RSP, or MAGS. Timeframe selector: Today, 5, 10, 20, 30 days. Green fill = healthy, red fill = weak.

**Section 2 — MA % History + Gauges:** Select any ETF from the 21-button row. Four gauge cards show current % of stocks above 21/50/100/200 MA (color-coded green/yellow/red). Line chart shows 60-day history of all four MA percentages with a 50% annotation line.

**Section 3 — Comparative Breadth:** Lock-then-pick compare mode. Click a ticker, click Compare to lock it, then click a second ticker to overlay both as solid vs dashed lines. Timeframe selector: 5d, 10d, 20d, 30d. Shows indexed price + MA breadth lines normalized to 100.

**Section 4 — ETF Bar Rankings:** Horizontal bar chart showing all 21 ETFs ranked by % of stocks above the selected MA (21/50/100/200), sorted descending. Bars are color-coded (green ≥60%, yellow 30–60%, red <30%) with percentage labels at bar ends.

**Refresh button** (top-right): POSTs to `/api/breadth/ma/recompute` to trigger a full server-side bootstrap, then reloads all charts.

**Admin "Breadth" button:** Full parity with Fetch Daily/Weekly/Analyze — run button, stop button, and `Ran MM/DD` status text in the Operations section. Triggers a full bootstrap via `POST /api/breadth/ma/recompute`. Status polled automatically by the scan control polling loop. Stop button sends `POST /api/breadth/ma/recompute/stop` to cancel mid-run. Long-running operation (5-10 min).

**Persistence:** MA line toggle choices (which of the 21/50/100/200 lines are hidden) persist in localStorage across ticker switches and page reloads.

#### 4. Admin View

Unified administrative page consolidating system health, operations, metrics, and history. Accessed via `#/admin` hash route (`#/logs` redirects here for backward compatibility).

**Section 1 — System Health:** 2×2 card grid showing Server (uptime, status), Database (pool stats), Circuit Breaker (state), and Scan Data (configured, last scan, warnings). Auto-refreshes on 10-second polling.

**Section 2 — Operations:** Four FetchButton rows (Fetch Daily, Fetch Weekly, Analyze, Breadth) with run/stop buttons and status text. Same `FetchButton` abstraction as before.

**Section 3 — Run Metrics:** Latest Fetch Daily, Fetch Weekly, VDF Scan, and Runtime Config cards. Same data as the previous Logs view.

**Section 4 — Recent Runs:** Paginated history of completed runs with expandable failed/recovered ticker details.

**Activity dot:** Pulsing indicator on the Admin nav item when any background operation is running.

### Global Features

- **Search bar:** Type-to-search ticker lookup
- **Settings gear:** Settings dropdown (theme, minichart, timezone)
- **Site lock:** Optional 8-digit passcode gate
- **4 themes:** Dark (default), Light, Beige, Claude
- **5 timezones:** Pacific, Mountain, Central, Eastern, UTC
- **Responsive:** Mobile-optimized with collapsible sections

---

## API Reference

### Authentication

**Session-based site lock** (when `SITE_LOCK_PASSCODE` is set):

- `POST /api/auth/verify` — Submit passcode, receive session cookie
- `GET /api/auth/check` — Verify current session
- `POST /api/auth/logout` — Destroy session

All `/api/*` endpoints (except auth, health) require a valid session when site lock is enabled. Sessions last 24 hours via `HttpOnly; SameSite=Strict` cookie (`Secure` in production).

**Secret-based auth** (for scan control endpoints):

- Provide via query `?secret=...` or header `x-divergence-secret`
- Controlled by `DIVERGENCE_SCAN_SECRET` env var

### Rate Limiting

Default: 300 requests per 15-minute window (configurable via `API_RATE_LIMIT_MAX`).

**Exempt paths:** `/api/health*`, `/api/ready*`, `/api/divergence/scan/status`

### Chart Endpoints

#### `GET /api/chart`

Fetch full chart data (bars + indicators) for a ticker.

| Param                 | Type   | Default | Description                                   |
| --------------------- | ------ | ------- | --------------------------------------------- |
| `ticker`              | string | SPY     | Stock symbol                                  |
| `interval`            | string | 4hour   | 5min, 15min, 30min, 1hour, 4hour, 1day, 1week |
| `format`              | string | json    | `json` or `tuple` (compact array format)      |
| `vdRsiLength`         | number | 14      | RSI period (1-200)                            |
| `vdSourceInterval`    | string | 1min    | Volume delta source granularity               |
| `vdRsiSourceInterval` | string | 1min    | VD RSI source granularity                     |

**Response:** `{ interval, timezone, bars[], rsi[], volumeDeltaRsi: { rsi[] }, volumeDelta[] }`

**Headers:** `X-Chart-Cache: hit|miss`, `Cache-Control` with `max-age` + `stale-while-revalidate`

**Errors:** 400 (invalid params), 502 (upstream failure)

#### `GET /api/chart/latest`

Same params as `/api/chart`. Returns only the most recent data point for each indicator.

**Response:** `{ interval, timezone, latestBar, latestRsi, latestVolumeDeltaRsi, latestVolumeDelta }`

#### `GET /api/chart/mini-bars`

| Param    | Type   | Description             |
| -------- | ------ | ----------------------- |
| `ticker` | string | Stock symbol (required) |

**Response:** `{ ticker, bars[] }`

**Cache:** `max-age=300` (5 minutes). Falls back: memory cache -> DB -> live API.

#### `GET /api/chart/mini-bars/batch`

| Param                 | Type   | Description                       |
| --------------------- | ------ | --------------------------------- |
| `ticker` or `tickers` | string | Comma-separated symbols (max 200) |

**Response:** `{ results: { [ticker]: bars[] } }`

#### `GET /api/chart/vdf-status`

| Param    | Type    | Default | Description                             |
| -------- | ------- | ------- | --------------------------------------- |
| `ticker` | string  |         | Required                                |
| `force`  | boolean | false   | Bypass cache                            |
| `mode`   | string  | scan    | `chart` (1yr data) or `scan` (3mo data) |

**Response:** VDF analysis object with zones, proximity, score.

**Cache:** `no-store`

#### `GET /api/chart/ticker-info`

Fetch company reference info for a ticker (name, description, SIC, market cap).

| Param    | Type   | Description             |
| -------- | ------ | ----------------------- |
| `ticker` | string | Stock symbol (required) |

**Response:** `{ results: { name, sic_description, market_cap, description, homepage_url, ticker, ... } }`

**Errors:** 400 (missing/invalid ticker), 404 (not found), 502 (upstream failure)

#### `GET /api/chart/divergence-summary`

| Param                 | Type    | Description                       |
| --------------------- | ------- | --------------------------------- |
| `ticker` or `tickers` | string  | Comma-separated symbols (max 200) |
| `vdSourceInterval`    | string  | Source interval (default: 1min)   |
| `refresh`             | boolean | Force refresh                     |

**Response:** `{ sourceInterval, refreshedAt, summaries: [{ ticker, tradeDate, states, expiresAtMs }] }`

### Alert Endpoints

#### `GET /api/alerts`

| Param                | Type   | Description         |
| -------------------- | ------ | ------------------- |
| `days`               | number | Lookback days       |
| `start_date`         | string | YYYY-MM-DD          |
| `end_date`           | string | YYYY-MM-DD          |
| `vd_source_interval` | string | Enrichment interval |

**Response:** Array of alert objects enriched with divergence states, MA states, and VDF data.

#### `POST /api/alerts/:id/favorite`

**Body:** `{ is_favorite?: boolean }`

**Response:** Updated alert object.

#### `GET /api/divergence/signals`

| Param                | Type   | Description         |
| -------------------- | ------ | ------------------- |
| `days`               | number | Lookback days       |
| `start_date`         | string | YYYY-MM-DD          |
| `end_date`           | string | YYYY-MM-DD          |
| `timeframe`          | string | `1d`, `1w`, or both |
| `vd_source_interval` | string | Enrichment interval |

**Response:** Array of divergence signal objects.

#### `POST /api/divergence/signals/:id/favorite`

**Body:** `{ is_favorite?: boolean }`

### Scan Control Endpoints

All scan control endpoints require secret-based auth.

| Endpoint                            | Method | Description                            |
| ----------------------------------- | ------ | -------------------------------------- |
| `/api/divergence/scan`              | POST   | Start daily divergence scan            |
| `/api/divergence/scan/pause`        | POST   | Pause running scan                     |
| `/api/divergence/scan/resume`       | POST   | Resume paused scan                     |
| `/api/divergence/scan/stop`         | POST   | Stop running scan                      |
| `/api/divergence/scan/status`       | GET    | Get combined status (no secret needed) |
| `/api/divergence/table/run`         | POST   | Start table build                      |
| `/api/divergence/table/pause`       | POST   | Pause table build                      |
| `/api/divergence/table/resume`      | POST   | Resume table build                     |
| `/api/divergence/table/stop`        | POST   | Stop table build                       |
| `/api/divergence/fetch-daily/run`   | POST   | Start daily data fetch                 |
| `/api/divergence/fetch-daily/stop`  | POST   | Stop daily data fetch                  |
| `/api/divergence/fetch-weekly/run`  | POST   | Start weekly data fetch                |
| `/api/divergence/fetch-weekly/stop` | POST   | Stop weekly data fetch                 |
| `/api/divergence/vdf-scan/run`      | POST   | Start VDF scan                         |
| `/api/divergence/vdf-scan/stop`     | POST   | Stop VDF scan                          |

**Common responses:** 202 (started), 401 (unauthorized), 409 (conflict/already running), 503 (DB not configured)

### Breadth Endpoints

| Endpoint                           | Method | Auth    | Description                                                                                                                                   |
| ---------------------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/breadth`                     | GET    | Session | SPY vs comparison ticker (intraday or daily)                                                                                                  |
| `/api/breadth/ma`                  | GET    | Session | MA % history + snapshots for all indices                                                                                                      |
| `/api/breadth/ma/bootstrap`        | POST   | Secret  | Start breadth bootstrap (fire-and-forget)                                                                                                     |
| `/api/breadth/ma/recompute`        | POST   | Session | Full breadth bootstrap — re-fetches ALL history from data API (5-10 min). Returns `{ status: 'started' }` or `{ status: 'already_running' }`. |
| `/api/breadth/ma/recompute/status` | GET    | Session | Poll bootstrap progress: `{ running: boolean, status: string }`                                                                               |
| `/api/breadth/ma/refresh`          | POST   | Secret  | Recompute today's breadth snapshot only                                                                                                       |

### Utility Endpoints

| Endpoint                        | Method | Description                      |
| ------------------------------- | ------ | -------------------------------- |
| `/api/logs/run-metrics`         | GET    | Run metrics history              |
| `/api/trading-calendar/context` | GET    | Current trading calendar context |

### Health Endpoints

| Endpoint                 | Auth         | Description                              |
| ------------------------ | ------------ | ---------------------------------------- |
| `GET /healthz`           | None         | Liveness probe (always 200)              |
| `GET /readyz`            | None         | Readiness probe (checks DB)              |
| `GET /api/admin/status`  | Session      | Composed health + readiness for admin UI |
| `GET /api/debug/metrics` | Debug secret | Server metrics, cache sizes, memory      |

---

## Data Model

### Primary Database

#### `alerts`

Stores price/signal alerts.

| Column           | Type          | Description         |
| ---------------- | ------------- | ------------------- |
| id               | SERIAL PK     |                     |
| ticker           | VARCHAR(20)   | Stock symbol        |
| signal_type      | VARCHAR(10)   | Alert type          |
| price            | DECIMAL(15,2) | Price at signal     |
| message          | TEXT          | Alert message       |
| timestamp        | TIMESTAMPTZ   | Alert time          |
| is_favorite      | BOOLEAN       | Bookmarked          |
| timeframe        | VARCHAR(10)   | Signal timeframe    |
| signal_direction | INTEGER       | Direction indicator |
| signal_volume    | INTEGER       | Volume at signal    |
| intensity_score  | INTEGER       | Intensity metric    |
| combo_score      | INTEGER       | Combined score      |

**Index:** `idx_alerts_timestamp` (timestamp DESC)

**Retention:** Auto-pruned after `ALERT_RETENTION_DAYS` (default 30).

#### `run_metrics_history`

Stores execution metrics for background jobs.

| Column      | Type                | Description                      |
| ----------- | ------------------- | -------------------------------- |
| id          | SERIAL PK           |                                  |
| run_id      | VARCHAR(120) UNIQUE | Run identifier                   |
| run_type    | VARCHAR(40)         | fetchDaily, fetchWeekly, vdfScan |
| status      | VARCHAR(40)         | running, completed, failed       |
| snapshot    | JSONB               | Full metrics snapshot            |
| started_at  | TIMESTAMPTZ         |                                  |
| finished_at | TIMESTAMPTZ         |                                  |
| created_at  | TIMESTAMPTZ         |                                  |

**Index:** `idx_run_metrics_history_created` (created_at DESC)

**Retention:** Capped at 200 records.

### Database

All tables are created in the divergence database configured by `DIVERGENCE_DATABASE_URL`.

#### `divergence_signals`

Detected volume divergence signals.

| Column          | Type          | Description         |
| --------------- | ------------- | ------------------- |
| id              | SERIAL PK     |                     |
| ticker          | VARCHAR(20)   | Stock symbol        |
| signal_type     | VARCHAR(10)   | bullish or bearish  |
| trade_date      | DATE          | Signal date         |
| price           | DECIMAL(15,4) | Close price         |
| prev_close      | DECIMAL(15,4) | Previous close      |
| volume_delta    | DECIMAL(20,4) | Volume delta metric |
| timeframe       | VARCHAR(10)   | 1d or 1w            |
| source_interval | VARCHAR(10)   | Data source (1min)  |
| timestamp       | TIMESTAMPTZ   | Creation time       |
| is_favorite     | BOOLEAN       | Bookmarked          |
| scan_job_id     | INTEGER       | Link to scan job    |

**Unique constraint:** (trade_date, ticker, timeframe, source_interval)

#### `divergence_scan_jobs`

Scan execution tracking and audit trail.

| Column             | Type        | Description                        |
| ------------------ | ----------- | ---------------------------------- |
| id                 | SERIAL PK   |                                    |
| run_for_date       | DATE        | Scheduled date                     |
| scanned_trade_date | DATE        | Actual trade date scanned          |
| status             | VARCHAR(20) | running, completed, failed, paused |
| started_at         | TIMESTAMPTZ |                                    |
| finished_at        | TIMESTAMPTZ |                                    |
| total_symbols      | INTEGER     | Tickers to process                 |
| processed_symbols  | INTEGER     | Tickers completed                  |
| bullish_count      | INTEGER     | Bullish signals found              |
| bearish_count      | INTEGER     | Bearish signals found              |
| error_count        | INTEGER     | Failures                           |
| notes              | TEXT        |                                    |

#### `divergence_symbols`

Master ticker universe for scanning.

| Column     | Type           | Description        |
| ---------- | -------------- | ------------------ |
| ticker     | VARCHAR(20) PK | Stock symbol       |
| exchange   | VARCHAR(40)    | NYSE, NASDAQ, etc. |
| asset_type | VARCHAR(40)    | Stock type         |
| is_active  | BOOLEAN        | Currently scanned  |
| updated_at | TIMESTAMPTZ    |                    |

#### `divergence_daily_bars`

Daily OHLCV data with computed volume deltas.

| Column          | Type          | Description |
| --------------- | ------------- | ----------- |
| ticker          | VARCHAR(20)   |             |
| trade_date      | DATE          |             |
| source_interval | VARCHAR(10)   |             |
| close           | DECIMAL(15,4) |             |
| prev_close      | DECIMAL(15,4) |             |
| volume_delta    | DECIMAL(20,4) |             |
| scan_job_id     | INTEGER       |             |
| updated_at      | TIMESTAMPTZ   |             |

**Primary key:** (ticker, trade_date, source_interval)

#### `divergence_summaries`

Multi-timeframe divergence state + MA position per ticker.

| Column          | Type        | Description            |
| --------------- | ----------- | ---------------------- |
| ticker          | VARCHAR(20) |                        |
| source_interval | VARCHAR(10) |                        |
| trade_date      | DATE        |                        |
| state_1d        | VARCHAR(10) | 1-day divergence state |
| state_3d        | VARCHAR(10) | 3-day state            |
| state_7d        | VARCHAR(10) | 7-day state            |
| state_14d       | VARCHAR(10) | 14-day state           |
| state_28d       | VARCHAR(10) | 28-day state           |
| ma8_above       | BOOLEAN     | Price > 8 EMA          |
| ma21_above      | BOOLEAN     | Price > 21 EMA         |
| ma50_above      | BOOLEAN     | Price > 50 SMA         |
| ma200_above     | BOOLEAN     | Price > 200 SMA        |
| scan_job_id     | INTEGER     |                        |
| updated_at      | TIMESTAMPTZ |                        |

**Primary key:** (ticker, source_interval)

#### `divergence_publication_state`

Tracks which trade dates are fully scanned and ready.

| Column               | Type           | Description          |
| -------------------- | -------------- | -------------------- |
| source_interval      | VARCHAR(10) PK |                      |
| published_trade_date | DATE           | Latest complete date |
| last_scan_job_id     | INTEGER        |                      |
| updated_at           | TIMESTAMPTZ    |                      |

#### `vdf_results`

Volume Distribution Frequency analysis results.

| Column           | Type        | Description              |
| ---------------- | ----------- | ------------------------ |
| ticker           | VARCHAR(20) |                          |
| trade_date       | VARCHAR(10) | Date string              |
| is_detected      | BOOLEAN     | VDF pattern found        |
| composite_score  | REAL        | Overall score (0-1)      |
| status           | TEXT        | Computation status       |
| weeks            | INTEGER     | Lookback weeks           |
| result_json      | TEXT        | Full JSON result         |
| best_zone_score  | REAL        | Highest zone score       |
| proximity_score  | REAL        | Distance to distribution |
| proximity_level  | VARCHAR(10) | none, far, near, at      |
| num_zones        | INTEGER     | Accumulation zones found |
| has_distribution | BOOLEAN     | Distribution detected    |
| updated_at       | TIMESTAMPTZ |                          |

**Primary key:** (ticker, trade_date)

#### `mini_chart_bars`

Cached daily bars for mini-chart rendering.

| Column      | Type             | Description    |
| ----------- | ---------------- | -------------- |
| ticker      | VARCHAR(20)      |                |
| trade_date  | DATE             |                |
| open_price  | DOUBLE PRECISION |                |
| high_price  | DOUBLE PRECISION |                |
| low_price   | DOUBLE PRECISION |                |
| close_price | DOUBLE PRECISION |                |
| bar_time    | BIGINT           | Unix timestamp |
| updated_at  | TIMESTAMPTZ      |                |

**Primary key:** (ticker, trade_date)

### Entity Relationships

```
divergence_scan_jobs ──→ divergence_signals (via scan_job_id)
                     ──→ divergence_daily_bars (via scan_job_id)
                     ──→ divergence_summaries (via scan_job_id)

divergence_daily_bars ──→ divergence_summaries (aggregated into)
divergence_summaries  ──→ alerts enrichment (joined at query time)
vdf_results          ──→ alerts/signals enrichment (joined at query time)
mini_chart_bars      ──→ UI rendering (standalone cache)
```

---

## Background Jobs

### Job Summary

| Job               | Trigger            | Schedule                      | Concurrency                | Data                              |
| ----------------- | ------------------ | ----------------------------- | -------------------------- | --------------------------------- |
| **Daily Scan**    | Scheduler + manual | 4:20 PM ET on trading days    | Configurable (default 128) | Live divergence signals           |
| **Table Build**   | Post-scan + manual | After daily scan              | Configurable (default 24)  | Historical bar backfill + summary |
| **Fetch Daily**   | Manual             | On-demand                     | Adaptive                   | 90+ days daily bars + MA states   |
| **Fetch Weekly**  | Manual             | On-demand (post-Friday close) | Adaptive                   | 90+ days weekly bars              |
| **VDF Scan**      | Manual             | On-demand                     | Hard-capped at 3           | 220 days 1-min bars per ticker    |
| **Alert Pruning** | Boot timer         | Every 24 hours                | N/A                        | Deletes old alerts                |

### Daily Divergence Scan

**File:** `server/orchestrators/dailyScanOrchestrator.ts`

**What it does:** Scans the full ticker universe for volume-price divergence signals on the latest trading day.

**Workflow:**

1. Loads active tickers from `divergence_symbols` table
2. Computes divergence signals per ticker (configurable concurrency)
3. Upserts results into `divergence_signals`
4. Two retry passes for failed tickers (half, then quarter concurrency)
5. Rebuilds summaries and publishes trade date

**Trigger:** Scheduled at 4:20 PM ET on trading days by `schedulerService.ts`, or manually via `POST /api/divergence/scan`.

**Lifecycle:** Supports pause/stop/resume. Progress saved at ticker level for resumption.

### Table Build

**File:** `server/orchestrators/tableBuildOrchestrator.ts`

**What it does:** Backfills historical daily bars and rebuilds divergence summaries for all tickers.

**Workflow:**

1. **Backfill phase:** Downloads daily divergence bars for each ticker (45-60 day lookback)
2. **Summarize phase:** Aggregates daily bars into divergence state summaries
3. Publishes completed trade dates

**Trigger:** Automatically after daily scan completes, or manually via `POST /api/divergence/table/run`.

**Lifecycle:** Supports pause/stop/resume with separate resume states for each phase.

### Fetch Daily / Fetch Weekly

**Files:** `server/orchestrators/fetchDailyOrchestrator.ts`, `fetchWeeklyOrchestrator.ts`

**What they do:** Fetch and update divergence signals with full MA state computation for all tickers.

**Trigger:** Manual via admin page operation buttons or API.

**Weekly constraint:** Only processes after Friday market close (4:16 PM ET).

### VDF Scan

**Files:** `server/services/vdfService.ts` (orchestration) → `vdfDetector.ts` → sub-modules

**What it does:** Runs Volume Distribution Frequency analysis across the ticker universe.

**Processing per ticker:**

- Fetches ~220 days of 1-minute intraday data (8 API slices)
- Detects accumulation zones, distribution clusters, proximity signals
- Stores results in `vdf_results` table

**Concurrency:** Hard-capped at 3 (vs 24-128 for other scans) due to large per-ticker memory footprint. Cache swept every 100 tickers.

**VDF module layers:**

| Module                   | Responsibility                                                   |
| ------------------------ | ---------------------------------------------------------------- |
| `vdfTypes.ts`            | Shared interfaces (Bar1m, DailyAggregate, ScoredZone, etc.)      |
| `vdfMath.ts`             | Pure math: `mean()`, `std()`, `linReg()`                         |
| `vdfAggregation.ts`      | Aggregate 1-min bars into daily and ISO-week buckets             |
| `vdfScoring.ts`          | 8-component zone scoring (delta trend, absorption, concordance)  |
| `vdfZoneDetection.ts`    | Greedy zone clustering; distribution cluster detection           |
| `vdfProximitySignals.ts` | 7 signals → composite score → `none/elevated/high/imminent`      |
| `vdfDetector.ts`         | Orchestrator: chains all sub-modules, returns `DetectVDFOptions` |

### Scan Lifecycle

All background jobs share the same lifecycle via `ScanState`:

```
idle → running → [paused] → running → completed / completed-with-errors / stopped / failed
```

- **Pause:** Saves checkpoint, can resume from exact position
- **Stop:** Terminates and clears resume state
- **Resume:** Restarts from saved checkpoint
- **Status polling:** `GET /api/divergence/scan/status` returns combined status for all jobs

### Scheduled Pipeline

```
schedulerService.ts
  └─ Calculates next trading day at 4:20 PM ET
  └─ Sets setTimeout
       └─ runScheduledDivergencePipeline()
            ├─ runDailyDivergenceScan()
            └─ (on success) runDivergenceTableBuild()
       └─ Reschedules next run
```

Controlled by `DIVERGENCE_SCANNER_ENABLED` (currently `false` by default).

---

## Caching Architecture

### Server-Side Caches

| Cache                      | Max Entries | TTL              | Purpose                     |
| -------------------------- | ----------- | ---------------- | --------------------------- |
| `CHART_DATA_CACHE`         | 6000        | Request-scoped   | Raw chart data from API     |
| `CHART_QUOTE_CACHE`        | 4000        | 300s             | Latest closing prices       |
| `CHART_FINAL_RESULT_CACHE` | 4000        | Configurable SWR | Assembled chart responses   |
| `VD_RSI_LOWER_TF_CACHE`    | 6000        | Request-scoped   | Lower-timeframe VD RSI data |
| `VD_RSI_RESULT_CACHE`      | 6000        | Request-scoped   | Computed VD RSI results     |
| `miniBarsCacheByTicker`    | 2000        | Memory lifetime  | Mini-chart bars             |
| `activeSessions`           | Unbounded   | 24h per session  | Session tokens              |

### Stale-While-Revalidate (SWR) Pattern

Chart responses use a timed cache entry:

```
┌─────────┬──────────────────┬───────────────┐
│  FRESH  │ STALE (serve +   │   EXPIRED     │
│ (serve) │  bg revalidate)  │ (block+fetch) │
└─────────┴──────────────────┴───────────────┘
0        freshUntil       staleUntil        ∞
```

Default: 15s fresh, 45s stale window. Prevents thundering herd on cache misses.

### Request Deduplication

In-flight request map prevents duplicate concurrent fetches. If two requests arrive for the same chart, the second waits for the first to complete.

### Pre-Warming

After a chart interval loads, `chartPrewarm.ts` pre-builds related intervals in the background:

- 4hour → [1day, 1week]
- 1day → [4hour, 1week]
- 1week → [1day, 4hour]

### Frontend Cache

`chartDataCache` in `chart.ts` caches fetched data keyed by `ticker:interval`, persisted to `sessionStorage`. The refresh button explicitly evicts the entry before re-fetching.

---

## Configuration Reference

### Required

| Variable                  | Description                  |
| ------------------------- | ---------------------------- |
| `DIVERGENCE_DATABASE_URL` | PostgreSQL connection string |

### Recommended

| Variable             | Default | Description                                 |
| -------------------- | ------- | ------------------------------------------- |
| `DATA_API_KEY`       |         | Market data provider API key                |
| `SITE_LOCK_PASSCODE` |         | Enables passcode gate (any non-empty value) |

### Server

| Variable              | Default | Description                                     |
| --------------------- | ------- | ----------------------------------------------- |
| `PORT`                | 3000    | Server listen port                              |
| `CORS_ORIGIN`         | `*`     | Allowed CORS origins (comma-separated)          |
| `LOG_LEVEL`           | info    | Pino log level: trace, debug, info, warn, error |
| `REQUEST_LOG_ENABLED` | false   | Log every HTTP request                          |

### Authentication

| Variable               | Default | Description                               |
| ---------------------- | ------- | ----------------------------------------- |
| `BASIC_AUTH_ENABLED`   | false   | Enable HTTP Basic auth                    |
| `BASIC_AUTH_USERNAME`  | shared  | Basic auth username                       |
| `BASIC_AUTH_PASSWORD`  |         | Basic auth password (required if enabled) |
| `BASIC_AUTH_REALM`     | Catvue  | Basic auth realm                          |
| `DEBUG_METRICS_SECRET` |         | Secret for `/api/debug/metrics`           |

### Rate Limiting

| Variable             | Default | Description                       |
| -------------------- | ------- | --------------------------------- |
| `API_RATE_LIMIT_MAX` | 300     | Max requests per 15-minute window |

### Divergence System

| Variable                               | Default | Description                               |
| -------------------------------------- | ------- | ----------------------------------------- |
| `DIVERGENCE_DATABASE_URL`              |         | PostgreSQL used by all persistence layers |
| `DIVERGENCE_SCAN_CONCURRENCY`          | 128     | Parallel tickers during scan              |
| `DIVERGENCE_SCAN_SPREAD_MINUTES`       | 0       | Delay between batches                     |
| `DIVERGENCE_TABLE_BUILD_CONCURRENCY`   | 24      | Parallel tickers during table build       |
| `DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS`   | 60      | Days of history to backfill               |
| `DIVERGENCE_TABLE_MIN_COVERAGE_DAYS`   | 29      | Minimum days required for summary         |
| `DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS`   | 50      | Days for fetch daily/weekly               |
| `DIVERGENCE_FETCH_TICKER_TIMEOUT_MS`   | 60000   | Per-ticker fetch timeout                  |
| `DIVERGENCE_FETCH_MA_TIMEOUT_MS`       | 30000   | MA computation timeout                    |
| `DIVERGENCE_STALL_TIMEOUT_MS`          | 90000   | Stall detection threshold                 |
| `DIVERGENCE_STALL_MAX_RETRIES`         | 3       | Stall retry count                         |
| `DIVERGENCE_MIN_UNIVERSE_SIZE`         | 500     | Min tickers for valid universe            |
| `DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE` | 2000    | DB batch write size                       |
| `DIVERGENCE_SCAN_SECRET`               |         | Secret for scan control endpoints         |

### Chart Tuning

| Variable                            | Default | Description                            |
| ----------------------------------- | ------- | -------------------------------------- |
| `CHART_TIMING_SAMPLE_MAX`           | 240     | Max timing samples retained            |
| `CHART_RESULT_CACHE_TTL_SECONDS`    |         | Override cache TTL                     |
| `CHART_RESPONSE_MAX_AGE_SECONDS`    |         | Override Cache-Control max-age         |
| `CHART_RESPONSE_SWR_SECONDS`        |         | Override stale-while-revalidate window |
| `CHART_RESPONSE_COMPRESS_MIN_BYTES` |         | Min response size for compression      |
| `CHART_QUOTE_CACHE_MS`              | 300000  | Quote cache duration (5 min)           |

### Cache Sizing

| Variable                               | Default | Description |
| -------------------------------------- | ------- | ----------- |
| `VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES`    | 6000    |             |
| `VD_RSI_RESULT_CACHE_MAX_ENTRIES`      | 6000    |             |
| `CHART_DATA_CACHE_MAX_ENTRIES`         | 6000    |             |
| `CHART_QUOTE_CACHE_MAX_ENTRIES`        | 4000    |             |
| `CHART_FINAL_RESULT_CACHE_MAX_ENTRIES` | 4000    |             |

### Monitoring

| Variable                    | Default | Description                   |
| --------------------------- | ------- | ----------------------------- |
| `SLOW_QUERY_THRESHOLD_MS`   | 500     | Log queries slower than this  |
| `RUN_METRICS_SAMPLE_CAP`    | 1200    | Max metrics samples in memory |
| `RUN_METRICS_HISTORY_LIMIT` | 40      | Max history entries in memory |

---

## Operations & Runbook

### Startup Sequence

1. Load environment variables (`dotenv`)
2. Validate startup environment (fail-fast on missing required vars)
3. Initialize Fastify with plugins (CORS, Helmet, compression, rate limiting, cookies, static files)
4. Register hooks (auth, logging, shutdown guard)
5. Register routes (chart, divergence, health, auth, alerts, logs)
6. Initialize database schema (create tables if needed)
7. Load trading calendar
8. Start alert pruning timer
9. Schedule next divergence scan
10. Begin listening on configured port

### Graceful Shutdown

On `SIGTERM` or `SIGINT`:

1. Set `isShuttingDown` flag (new requests get 503)
2. Clear all scheduled timers
3. Send stop signal to all running scans
4. Destroy trading calendar
5. Close HTTP listener
6. Drain database connection pools
7. Exit with code 0

Safety net: 15-second force-exit timeout.

### Health Checks

- **Liveness:** `GET /healthz` — Always 200 if process is alive. Use for container restart decisions.
- **Readiness:** `GET /readyz` — Checks database connectivity and runtime health. Use for load balancer routing.

### Monitoring

**Structured logs:** All output is JSON via Pino. Key fields: `level`, `time`, `msg`.

**Key log patterns to watch:**

- `[slow-query]` — Queries exceeding threshold
- `[query-error]` — Failed database queries
- `[startup-env]` — Missing or invalid configuration
- `[chart-prewarm]` — Pre-warm failures
- `Unhandled promise rejection` — Unexpected async errors
- `Uncaught exception` — Fatal errors (triggers shutdown)

**Debug metrics:** `GET /api/debug/metrics` returns server uptime, memory usage, cache sizes, and divergence status.

### Common Operations

**Force refresh chart data:**
Click the refresh button in the chart controls, or clear server caches by restarting.

**Run a manual divergence scan:**

```bash
curl -X POST "https://your-server/api/divergence/scan?secret=YOUR_SECRET"
```

**Check scan status:**

```bash
curl "https://your-server/api/divergence/scan/status"
```

**Stop a running scan:**

```bash
curl -X POST "https://your-server/api/divergence/scan/stop?secret=YOUR_SECRET"
```

**Run fetch daily (backfill daily signals):**

```bash
curl -X POST "https://your-server/api/divergence/fetch-daily/run?secret=YOUR_SECRET"
```

**Run VDF scan:**

```bash
curl -X POST "https://your-server/api/divergence/vdf-scan/run?secret=YOUR_SECRET"
```

**Run full breadth bootstrap (re-fetch all history):**

```bash
curl -X POST "https://your-server/api/breadth/ma/recompute"
# Poll progress:
curl "https://your-server/api/breadth/ma/recompute/status"
```

### Troubleshooting

**"Bad Request" on scan control buttons:**
Fastify rejects empty JSON bodies by default. The custom content-type parser handles this. If the issue recurs, check that the parser is registered before route registration in `index.ts`.

**Auth failures during passcode verification:**
`/api/auth/verify` is guarded by brute-force backoff/lockout. Repeated invalid attempts return `429` with `Retry-After`. Check IP/user-agent attempt history and `DIVERGENCE_SCAN_SECRET`/passcode configuration.

**Slow chart loads:**
Check for `[slow-query]` entries in logs. Verify cache hit rates via `X-Chart-Cache` response header. Check `CHART_FINAL_RESULT_CACHE_MAX_ENTRIES` sizing.

**Scan stalls:**
The stall watchdog (`DIVERGENCE_STALL_TIMEOUT_MS`) detects stuck tickers and retries with exponential backoff. If stalls are frequent, consider increasing `DIVERGENCE_FETCH_TICKER_TIMEOUT_MS` or reducing concurrency.

**Database connection exhaustion:**
The divergence PostgreSQL pool is capped at 20 connections with 30s idle timeout. If `connectionTimeoutMillis` errors appear, check for long-running queries (increase `statement_timeout`) or reduce scan concurrency.

---

## Development

### Commands

| Command                    | Description                           |
| -------------------------- | ------------------------------------- |
| `npm start`                | Start server (`tsx index.ts`)         |
| `npm run dev`              | Vite dev server with HMR (port 5173)  |
| `npm run build`            | Production frontend build             |
| `npm test`                 | Run all tests                         |
| `npm run typecheck`        | Frontend TypeScript check             |
| `npm run typecheck:server` | Server TypeScript check               |
| `npm run lint`             | Server typecheck + frontend typecheck |
| `npm run lint:eslint`      | ESLint                                |
| `npm run format`           | Prettier (write)                      |
| `npm run format:check`     | Prettier (check only)                 |

### Dev Workflow

```bash
# Start backend
npm start

# In another terminal, start frontend dev server
npm run dev

# Open http://localhost:5173
# Frontend requests to /api/* are proxied to :3000
```

### Testing

Tests use Node.js built-in test runner. No external framework.

```bash
npm test                          # Run all tests
tsx --test test/chartEngine.test.ts   # Run single test file
```

Test files cover: chart math, RSI calculations, data API client, date utilities, DB monitoring, route handlers, health checks, divergence service logic.

### CI Pipeline

GitHub Actions runs on push to `main` and PRs:

1. `npm ci`
2. ESLint
3. Frontend typecheck
4. Server typecheck
5. Tests
6. Build

All steps must pass before merge.

---

## Deployment

### Railway / Cloud Deployment

The project runs as a single Node.js process. No separate worker processes.

**Required environment variables:** `DIVERGENCE_DATABASE_URL`, `DATA_API_KEY`

**Build command:** `npm ci && npm run build`

**Start command:** `npm start`

**Health check:** `GET /healthz`

**Readiness check:** `GET /readyz`

### Database Setup

The application auto-creates tables on startup using `CREATE TABLE IF NOT EXISTS`. No separate migration step is needed.

Set `DIVERGENCE_DATABASE_URL` to the PostgreSQL connection string used by the application.

### Security Considerations

- Set `SITE_LOCK_PASSCODE` for production to gate access
- Set `DIVERGENCE_SCAN_SECRET` to protect scan control endpoints
- Set `DEBUG_METRICS_SECRET` to protect the metrics endpoint
- Configure `CORS_ORIGIN` to restrict allowed origins
- SSL is enforced for database connections (configurable via `DB_SSL_REJECT_UNAUTHORIZED`)
- All session cookies are `HttpOnly; SameSite=Strict` (`Secure` in production)
- Security headers via Helmet: CSP, HSTS, referrer policy, frame guard
