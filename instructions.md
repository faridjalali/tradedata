# Engineering Instructions

Guidelines for AI coding agents and contributors working on this codebase.
Every line of code must meet the standard described in the **Code Quality Mandate** section.

---

## Standing Instructions

1. **After every prompt: update `instructions.md`** to document any new patterns, decisions, or conventions.
2. **After every prompt: update `README.md`** to keep it current with all changes made.
3. Commit both updates as part of the same task.

---

## Code Quality Mandate

All code in this repository must meet the level expected of a principal-engineer code review
at Google or Apple. Any addition or modification that would not pass such a review must be
fixed before committing. This is not aspirational — it is the minimum bar.

### The Non-Negotiable Rules

1. **`catch (err: unknown)`, always.**
   TypeScript 4+ defaults catch bindings to `unknown`. Using `catch (err: any)` defeats
   type safety. Narrow the error explicitly:
   ```typescript
   } catch (err: unknown) {
     const message = err instanceof Error ? err.message : String(err);
   }
   ```

2. **No `any` except bounded, documented escape hatches.**
   Acceptable uses (comment required explaining why):
   - CDN globals that cannot be imported (e.g., `declare const Chart: any; // LightweightCharts CDN`)
   - Runtime monkey-patching where public API is absent (e.g., `instrumentPool` in `dbMonitor.ts`)
   - `() => null as any` when satisfying a complex return type in tests
   Unacceptable uses: `Record<string, any>` for known shapes, `(x: any)` parameters,
   `(err as any).prop`, `const x: any = ...`. Use `unknown` + narrowing, generics, or proper interfaces.
   For custom error properties use `Object.assign(new Error(...), { httpStatus: 400 }) as HttpError`.
   For Fastify request augmentation use `declare module 'fastify' { interface FastifyRequest { ... } }`.
   For accessing unknown API response payloads, cast to the expected return type directly:
   `const payload = await res.json() as ExpectedType | null`.

3. **No dead code.** Unused functions, variables, imports, and type aliases must be deleted.
   This applies to test helpers too — if a helper is not called in a test, remove it.

4. **Tests must be deterministic.** Never use `setTimeout(r, 0)` to yield and hope state
   has changed. Use explicit synchronization (Promise gates, counters, event flags):
   ```typescript
   // BAD — race condition
   await new Promise((r) => setTimeout(r, 0));
   assert.ok(vdfScan.isRunning); // might be false

   // GOOD — deterministic
   const running = new Promise<void>((r) => (signalRunning = r));
   getTickers: async () => { signalRunning(); await block; return []; }
   await running; // guaranteed: isRunning is true
   ```

5. **Tests must be silent.** Tests that produce unexpected DB errors, stack traces, or
   console noise indicate incomplete dependency injection. Inject no-op stubs for all
   I/O that tests don't care about (DB writes, network, metrics persistence).

6. **Named constants for every magic number.** Concurrency limits, multipliers, thresholds,
   timeouts, retry divisors — every bare number in infrastructure code needs a named constant
   with a comment explaining the rationale.

7. **JSDoc on every exported function and class.** One sentence minimum. Public lifecycle
   methods get full param/return documentation.

8. **Dependency direction is a hard constraint.** `lib/` must never import from `services/`.
   `services/` must never import from `routes/`. `config.ts` is the bottom of the stack.
   New violations are immediate reverts.

9. **All env vars go through `config.ts`.** Never call `process.env.ANYTHING` outside
   `server/config.ts`. Add a named, clamped, documented constant there first.

10. **Verification checklist is mandatory before every commit:**
    ```bash
    npx tsc --noEmit
    npx tsx --test test/*.test.ts
    npx vite build
    ```
    All three must exit 0. No exceptions.

---

## Application Overview

**Tradedata** is a real-time market data visualization and divergence-detection platform.

### What It Does

- **Chart view**: Fetch and render OHLCV data for any ticker across multiple timeframes
  (1min, 4hour, 1day, 1week). Overlays: RSI, EMA, volume, VDF zone highlights.
- **Breadth view**: Market breadth analysis — percentage of S&P 500 stocks above key
  moving averages (21/50/100/200-day). Trend gauges + history chart. Normalized
  comparison chart overlaying SPY/QQQ/SMH breadth performance.
- **Divergence feed**: Live feed of VDF (Volume Distribution Formation) divergence alerts
  detected across the universe of tracked symbols.
- **Scan control panel**: Start/stop/resume background scans (fetch-daily, fetch-weekly,
  VDF scan, table build). Real-time progress, error counts, retry status.

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 ESM |
| HTTP server | Fastify 5 |
| Database | PostgreSQL via `pg` (two optional pools) |
| Frontend build | Vite 7 |
| Frontend charts | Lightweight Charts (CDN) + Chart.js (CDN, breadth only) |
| Logging | Pino (structured JSON) |
| Validation | Zod |
| Caching | lru-cache |
| Testing | Node.js built-in `test` + `tsx` for TypeScript |

---

## Architecture

### Directory Structure

```
index.ts                            # Entry point: plugin registration, startup, shutdown
server/
  config.ts                         # All env-var constants; never read process.env elsewhere
  db.ts                             # PostgreSQL pools: primary (required) + divergence (optional)
  middleware.ts                     # Auth wrappers, request metadata extraction
  schemas.ts                        # Zod schemas for all HTTP input validation
  logger.ts                         # Pino setup; redirects console.* to Pino
  chartMath.ts                      # Pure math: RSI, RMA, OHLCV aggregation, normalization
  routes/                           # HTTP route handlers — thin layer, no business logic
    chartRoutes.ts                  # Chart data endpoints
    divergenceRoutes.ts             # Scan control + alert feed endpoints
    healthRoutes.ts                 # /healthz, /readyz, /api/debug/metrics
  services/                         # Domain logic, caching, external API calls
    dataApi.ts                      # HTTP client: market data, rate limiting, circuit breaker
    chartEngine.ts                  # Chart data orchestration: fetch → calculate → cache
    vdfService.ts                   # VDF detection: run scan, store results, get status
    vdfDetector.ts                  # Pure VDF algorithm (no I/O)
    divergenceDbService.ts          # Divergence DB queries (symbols, results)
    scanControlService.ts           # ScanState instances + normalizers for all scan jobs
    metricsService.ts               # Run metrics tracking + DB persistence
    chartPrewarm.ts                 # Background pre-warming of adjacent intervals
    sessionAuth.ts                  # Cookie-based session management (in-memory)
  orchestrators/                    # Multi-step background jobs
    fetchDailyOrchestrator.ts       # Fetch daily OHLCV for all symbols, build divergence table
    fetchWeeklyOrchestrator.ts      # Fetch weekly OHLCV, same pipeline as daily
    tableBuildOrchestrator.ts       # Build/rebuild divergence summary table
    dailyScanOrchestrator.ts        # Daily divergence detection scan
  lib/                              # Pure utilities — no side effects, no service imports
    ScanState.ts                    # ScanState class + runRetryPasses
    mapWithConcurrency.ts           # Configurable parallel worker pool
    errors.ts                       # isAbortError — pure predicate, lib-safe
    dateUtils.ts                    # ET timezone helpers, date arithmetic
    dbMonitor.ts                    # Query timing wrapper, slow-query logging
    circuitBreaker.ts               # HTTP circuit breaker
    apiSchemas.ts                   # Zod schemas for external API response validation
src/                                # Frontend TypeScript (compiled by Vite)
  main.ts                           # View router, global event handlers, scan control wiring
  chart.ts                          # Lightweight Charts integration, indicator rendering
  breadth.ts                        # Breadth analysis charts (Chart.js), comparison view
  divergenceFeed.ts                 # Alert feed polling, VDF status display
  utils.ts                          # DOM helpers, fetch wrappers
  theme.ts                          # Dark/light theme switching
  components.ts                     # Shared UI elements (refresh buttons, gauges)
shared/
  api-types.ts                      # Single source of truth for frontend ↔ backend types
public/
  style.css                         # All CSS; theming via CSS custom properties
index.html                          # Single-page app shell; all views are in-DOM, toggled by CSS
test/                               # Node.js built-in test runner
```

### Dependency Direction

Strict unidirectional. Circular imports are forbidden.

```
Routes → Services → Lib/Utils → Config
                 ↘ DB
Orchestrators → Services → Lib/Utils
Frontend → shared/api-types
```

- **Routes**: HTTP boundary only. No business logic. Call services; return results.
- **Services**: Domain logic, caching, external API calls. Allowed to import from `lib/` and `db.ts`.
- **Orchestrators**: Multi-step workflows. Coordinate services. Hold no persistent state of their own.
- **Lib**: Pure utilities. Zero side effects. Never imports from `services/`. `lib/errors.ts` keeps
  `isAbortError` here precisely to enforce this constraint.
- **Config**: Bottom of the stack. Only source of `process.env` access.

### Module Registration Pattern

Entry-point wiring passes dependencies as options objects — not direct imports — so modules
remain independently testable:

```typescript
// index.ts
registerChartRoutes({ app, parseChartRequestParams, getOrBuildChartResult, ... });
registerDivergenceRoutes({ app, isDivergenceConfigured, divergencePool, ... });
```

---

## Data Flow

### Chart Request (Happy Path)

```
Browser GET /api/chart?ticker=SPY&interval=4hour
  → chartRoutes.ts: validate params via Zod
  → chartEngine.getOrBuildChartResult(ticker, interval, options)
      → check CHART_DATA_CACHE (LRU, timed entry)
        hit: return cached (fresh) or serve stale + trigger background refresh
        miss: fetch from dataApi → calculate indicators → cache → return
  → HTTP 200 with chart data + Cache-Control headers
```

### Background Orchestrator (Fetch-Daily)

```
POST /api/divergence/fetch-daily/start
  → divergenceRoutes: validate, call fetchDailyOrchestrator.runFetchDailyData()
  → Orchestrator:
      1. Fetch universe: getStoredDivergenceSymbolTickers()
      2. mapWithConcurrency(tickers, concurrency, worker, onSettled, shouldStop)
         worker: fetchDailyBarsForTicker() → upsert to divergence DB
      3. Retry failed tickers (runRetryPasses, 2 passes at ½ and ¼ concurrency)
      4. Build divergence summary table
      5. markCompleted / markStopped / markFailed on ScanState
  → GET /api/divergence/fetch-daily/status polls progress
```

### VDF Scan

```
POST /api/divergence/vdf-scan/start
  → vdfService.runVDFScan({ resume? })
  → For each ticker:
      getVDFStatus(ticker, { force, noCache, signal })
        → dataApiIntradayChartHistory: fetch 220 days of 1-min bars
        → detectVDF(bars): pure algorithm, returns { is_detected, zones, scores }
        → upsert result to vdf_results table
  → Cap concurrency at 3 (memory pressure: each ticker ~9GB cache buildup at higher)
  → Retry 2 passes for failed tickers
  → Save resume state on stop so scan can continue from where it left off
```

---

## Key Services

### `server/services/dataApi.ts`

The sole gateway to the upstream market-data provider.

- **Token-bucket rate limiter**: configurable via `DATA_API_MAX_REQUESTS_PER_SECOND`.
  Callers await a token before issuing HTTP requests.
- **Circuit breaker** (`lib/circuitBreaker.ts`): opens after repeated failures, prevents
  thundering herd on a degraded upstream. Auto-resets after a cooldown window.
- **Pause mode**: `DATA_API_REQUESTS_PAUSED=true` blocks all outbound calls (useful for
  development/testing without burning API quota).
- **Error classification**: `isAbortError`, `isDataApiRateLimitedError`,
  `isDataApiPausedError`, `isDataApiSubscriptionRestrictedError` — all exported for use
  in services that need to branch on error type.
- **`isAbortError`** is defined in `lib/errors.ts` (not here) so that `mapWithConcurrency`
  can use it without creating a `lib → services` import cycle.

### `server/services/chartEngine.ts`

Orchestrates chart data: fetch raw bars, calculate indicators, cache, serve.

- Multi-tier LRU cache with timed entries (fresh/stale/expired pattern).
- Request deduplication: in-flight map prevents duplicate concurrent fetches.
- `getOrBuildChartResult(ticker, interval, options)` is the main entry point.
- `sweepExpiredTimedCache(cache)` should be called periodically to evict dead entries
  (called by VDF scan worker after every 100 tickers).

### `server/services/vdfService.ts`

Owns VDF scan lifecycle. Exports:

- `vdfScan`: the singleton `ScanState` instance for the VDF scan job.
- `runVDFScan(options)`: orchestrates the scan. Accepts `_deps` for testing (see below).
- `getVDFStatus(ticker, options)`: fetches intraday data and runs `detectVDF`.
- `getStoredVDFResult(ticker, tradeDate)`: reads stored result from DB.
- `VdfScanDeps` interface: injectable I/O for `runVDFScan`. Tests inject stubs to avoid
  all DB and network calls.

### `server/lib/ScanState.ts`

Reusable lifecycle manager for background scan jobs. See the **ScanState API Reference**
section under "New Background Job" for the complete method list.

Also exports:
- `runRetryPasses<TSettled extends TickerWorkerSettled>`: runs up to 2 retry passes over
  failed tickers with halving concurrency. Fully generic, callable from any orchestrator.
- `TickerWorkerSettled` interface: all scan workers must return this shape.

### `server/lib/mapWithConcurrency.ts`

Configurable parallel worker pool. Key properties:

- Guarantees result ordering (index-stable output regardless of completion order).
- Respects `shouldStop()` predicate: checks before starting each item and after `AbortError`.
- `onSettled` callback for per-item progress (errors in callback are swallowed — best-effort).
- Worker exceptions are captured as `{ error: unknown }` entries — never thrown.
- `resolveAdaptiveFetchConcurrency(runType)`: computes concurrency ceiling from RPS limits.

---

## Database

### Primary Pool (`DATABASE_URL`)

Required. Stores:

| Table | Purpose |
|---|---|
| `sessions` | Auth session tokens (in-memory backed but also persisted) |
| `run_metrics_history` | Historical run snapshots (fetch times, error rates, concurrency) |
| `alerts` | Divergence alert records with TTL |

### Divergence Pool (`DIVERGENCE_DATABASE_URL`)

Optional. Large-scale scan data. If not configured, all divergence features are disabled
gracefully (`isDivergenceConfigured()` returns false).

| Table | Purpose |
|---|---|
| `divergence_symbols` | Universe of tracked symbols (ticker, exchange) |
| `daily_bars` | Fetched OHLCV bars for divergence detection |
| `weekly_bars` | Weekly OHLCV bars |
| `vdf_results` | Per-ticker VDF detection output (is_detected, scores, zones) |
| `divergence_summary` | Precomputed divergence table (joined/aggregated view) |

### Query Patterns

- Always parameterized: `query('SELECT ... WHERE ticker = $1', [ticker])`.
- Batch upserts: `INSERT ... ON CONFLICT (ticker, trade_date) DO UPDATE SET ...`.
- Transactional access: `withDivergenceClient(async (client) => { ... })`.
- Schema init: `CREATE TABLE IF NOT EXISTS` at startup; `ADD COLUMN IF NOT EXISTS` for migrations.

---

## TypeScript Standards

### Strictness

`tsconfig.json` (frontend) and `tsconfig.server.json` (backend) both use `"strict": true`.
Frontend additionally enforces `"noUnusedLocals"` and `"noUnusedParameters"`.

Always run both:
```bash
npx tsc --noEmit                                 # frontend
npx tsc --noEmit --project tsconfig.server.json  # backend
```

### Shared Types

`shared/api-types.ts` is the single source of truth for the frontend ↔ backend contract.
Update it first when adding or changing endpoint response shapes.

### Zod Schemas

All HTTP input (query params, bodies, path params) goes through Zod schemas in `server/schemas.ts`:

```typescript
const result = schema.safeParse(input);
if (!result.success) {
  const firstIssue = result.error.issues[0];
  return reply.code(400).send({ error: firstIssue?.message || 'Validation failed' });
}
```

### No `any` — Specific Guidance

| Situation | Correct Pattern |
|---|---|
| Error in `catch` | `catch (err: unknown)` + `err instanceof Error ? err.message : String(err)` |
| Dynamic DB row | Define an explicit interface matching the SELECT columns |
| Unknown JSON shape | `Record<string, unknown>` + explicit narrowing at each property access |
| CDN global (Chart.js, Lightweight Charts) | `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + `declare const LightweightCharts: any; // loaded from CDN` |
| CDN callback params (chart events) | `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + `(param: any) =>` with a comment |
| Resume state bag | `Record<string, unknown>` — wrap all property accesses in `Number()` / `Array.isArray()` |
| Test I/O stubs | `() => null as any` is acceptable with a comment when the return type is complex |
| `Function` type | **Banned.** Always write the explicit signature: `(...args: unknown[]) => Promise<unknown>` or `() => void` |
| OHLCV bar arrays (frontend) | `CandleBar[]` — import from `shared/api-types.ts` |
| Chart interval params (frontend) | `ChartInterval` — import from `shared/api-types.ts` |

### Error Type Narrowing Pattern

```typescript
// Services
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err }, message);
}

// Routes (with type guard)
} catch (err: unknown) {
  if (isDataApiRateLimitedError(err)) return reply.code(429).send({ error: 'Rate limited' });
  return reply.code(500).send({ error: 'Internal error' });
}
```

---

## Security

### Authentication

- **Session auth** (`sessionAuth.ts`): cookie-based, 24h TTL, HttpOnly + SameSite=Lax.
  In-memory `Map` with auto-cleanup every 15 minutes.
- **Basic auth** (`middleware.ts`): timing-safe comparison via `crypto.timingSafeEqual()`.
- **Site lock**: passcode gate, enabled when `SITE_LOCK_PASSCODE` is set.

Never bypass timing-safe comparison. Never log credentials or session tokens.

### Input Validation

- Parameterized SQL only. No string interpolation.
- All query params validated via Zod before use.
- Request metadata stripped to safe fields before logging (`extractSafeRequestMeta()`).

### Security Headers

Fastify Helmet provides: CSP (strict self + CDN allowlist), HSTS (1-year), Referrer-Policy,
X-Frame-Options. Do not relax CSP without a documented reason.

### Rate Limiting

`@fastify/rate-limit`, 300 requests / 15 min by default (`API_RATE_LIMIT_MAX`).
Exempt paths: `/api/auth/*`, `/api/health`, `/api/ready`, `/api/divergence/scan/status`.
Add new polling endpoints to the exempt list.

---

## Caching

### Timed-Entry LRU Pattern

```typescript
interface TimedCacheEntry {
  value: unknown;
  freshUntil: number;   // Serve directly; no revalidation needed
  staleUntil: number;   // Serve stale; trigger background refresh
}
```

Flow: fresh → serve instantly. Stale → serve + async refresh. Expired → synchronous fetch.

### Request Deduplication

In-flight map prevents duplicate concurrent fetches for identical cache keys:

```typescript
const inFlight = CHART_IN_FLIGHT_REQUESTS.get(key);
if (inFlight) { await inFlight; return; }
```

### Pre-Warming

`chartPrewarm.ts` queues adjacent intervals for background build after a chart loads
(e.g., loading 4hour triggers 1day + 1week). Awaited sequentially to avoid resource spikes.

---

## Error Handling

### Structured Error Interfaces

```typescript
interface DataApiError extends Error {
  httpStatus?: number;
  isDataApiPaused?: boolean;
  isDataApiRateLimited?: boolean;
  isTaskTimeout?: boolean;
}
```

Type guards (`isDataApiRateLimitedError`, `isAbortError`, etc.) are used in catch blocks
instead of `instanceof` checks.

### Route Error Pattern

```typescript
try {
  return reply.send(await service.doWork(params));
} catch (err: unknown) {
  if (isRateLimitedError(err)) return reply.code(429).send({ error: 'Rate limited' });
  if (isPausedError(err)) return reply.code(503).send({ error: 'Paused' });
  return reply.code(500).send({ error: 'Internal error' });
}
```

### Graceful Degradation

Cache miss → API fetch → serve. API failure → stale cache if available. Background job
failure → logged, never crashes server. Pre-warm errors → swallowed.

---

## Performance

### Adaptive Concurrency

`resolveAdaptiveFetchConcurrency(runType)` computes concurrency from:
- `DIVERGENCE_TABLE_BUILD_CONCURRENCY` (configured ceiling)
- `DATA_API_MAX_REQUESTS_PER_SECOND` (rate limit budget)
- `ESTIMATED_API_CALLS_PER_TICKER` (per run type)

VDF scan hard-caps at 3 regardless (memory constraint; each ticker loads 220 days of
1-min data, causing massive cache buildup at higher concurrency).

### mapWithConcurrency

```typescript
await mapWithConcurrency(
  items,            // T[]
  concurrency,      // number — clamped to list length
  worker,           // (item: T, index: number) => Promise<R>
  onSettled?,       // (result | { error }, index, item) => void — errors swallowed
  shouldStop?,      // () => boolean — checked before each item
);
// Returns Array<R | { error: unknown }> — index-stable, never throws
```

### Response Compression

`@fastify/compress` above configurable minimum byte size. Chart responses include
`Cache-Control: max-age=N, stale-while-revalidate=M`.

### Graceful Shutdown

```
SIGTERM/SIGINT → set isShuttingDown flag → 503 new requests
  → clear timers → drain in-flight → close DB pools → exit
  → 15-second force-exit safety net
```

Register new timers/intervals in the shutdown handler.

---

## Background Jobs & ScanState

### ScanState Lifecycle

All orchestrators use a `ScanState` instance (from `lib/ScanState.ts`) for lifecycle:

```typescript
// Starting a run
const abort = myScan.beginRun(resumeRequested);
// ... run work ...
myScan.markCompleted(fields);   // or markStopped / markFailed
myScan.cleanup(abort);          // always in finally block
```

### Full ScanState API Reference

```typescript
// Read-only accessors
myScan.isRunning           // true while job owns this state
myScan.isStopping          // true after requestStop() called
myScan.shouldStop          // isStopping || signal.aborted  (use in worker loops)
myScan.signal              // AbortSignal | null
myScan.currentResumeState  // Record<string, unknown> | null — wrap all accesses in Number/Array.isArray

// Status
myScan.readStatus()                    // Readonly<ScanStatusFields> snapshot
myScan.setStatus({ ... })              // Merge partial update
myScan.replaceStatus({ ... })          // Full replace — terminal transitions only
myScan.setExtraStatus({ ... })         // Extra domain fields (e.g. detected_tickers)
myScan.updateProgress(processed, errors)

// Terminal transitions
myScan.markStopped(fields)             // status → 'stopped'
myScan.markCompleted(fields)           // status → 'completed' or 'completed-with-errors'
myScan.markFailed(fields)              // status → 'failed'

// Resume
myScan.saveResumeState(data, concurrency)   // Computes safe nextIndex; persists
myScan.setResumeState(data | null)          // Direct set (mid-run)
myScan.canResume()                          // boolean — check before offering resume to UI

// Lifecycle
myScan.beginRun(resumeRequested)       // Returns AbortController; resets transient state
myScan.requestStop()                   // Returns false if not running; aborts signal
myScan.cleanup(abortRef?)              // Clears isRunning + AbortController — always in finally

// Late-binding (avoids circular imports; call from scanControlService.ts)
myScan.setNormalizeResume(fn)
myScan.setCanResumeValidator(fn)

// Route integration
myScan.buildRouteOptions(runFn)        // Returns { getStatus, requestStop, canResume, run, getIsRunning }
```

### Resume State Pattern

Resume state bags are `Record<string, unknown>`. Wrap every property access in a type-safe coercion:

```typescript
const rs = myScan.currentResumeState;
// ✓ correct
const total = Number(rs?.totalTickers) || 0;
const tickers: string[] = (rs && Array.isArray(rs.tickers)) ? (rs.tickers as string[]) : [];
const nextIndex = Math.max(0, Number(rs?.nextIndex || 0));
// ✗ wrong
const tickers = rs?.tickers || [];   // unknown, causes type error
const idx = rs.nextIndex < total;    // unknown < number, type error
```

### runRetryPasses

```typescript
const stillFailed = await runRetryPasses<VdfSettled>({
  failedTickers,
  baseConcurrency,           // halved on pass 1, quartered on pass 2
  worker,                    // (ticker: string) => Promise<TSettled>
  onRecovered?,              // called for each ticker that succeeds on retry
  onStillFailed?,            // called for each ticker that still fails
  shouldStop?,               // () => boolean — honors scan abort
  metricsTracker?,           // optional — set phase, record recovered
  mapWithConcurrency,        // pass the imported function (enables test injection)
});
```

Workers passed to `runRetryPasses` must **not throw** — catch internally and return
`{ ticker, error }`. The `mapWithConcurrency`-level guard handles unexpected throws.

### Orchestrator Testability (VdfScanDeps Pattern)

Complex orchestrators accept an optional `_deps` parameter to inject I/O stubs:

```typescript
export interface VdfScanDeps {
  isConfigured?: () => boolean;
  getTickers?: () => Promise<string[]>;
  detectTicker?: (ticker: string, signal: AbortSignal) => Promise<unknown>;
  sweepCache?: () => void;
  createMetricsTracker?: typeof createRunMetricsTracker;  // pass () => null to suppress DB writes
}

export async function runVDFScan(options: { resume?: boolean; _deps?: VdfScanDeps } = {}) { ... }
```

Test usage:
```typescript
await runVDFScan({
  _deps: {
    isConfigured: () => true,
    getTickers: async () => ['AAPL', 'MSFT'],
    detectTicker: async (ticker) => ({ is_detected: ticker === 'AAPL' }),
    sweepCache: () => {},
    createMetricsTracker: () => null as any,  // suppresses DB writes
  },
});
```

The `_deps` prefix signals test-only usage. Production callers never pass it.

---

## Observability

### Structured Logging

All logging via Pino. `console.*` methods are redirected to Pino in `server/logger.ts`.

```typescript
// Simple message
console.log('VDF scan started');
// Structured
logStructured('info', 'chart.cache.miss', { ticker, interval, latencyMs });
```

Format: `{"level":"info","time":"...","msg":"...","ticker":"SPY","interval":"4hour"}`

### Database Monitoring

`lib/dbMonitor.ts` wraps pool queries. Slow queries (>500ms) are logged with duration
and first 200 chars of SQL (sanitized).

### Health Endpoints

- `GET /healthz` — liveness (200 if process alive)
- `GET /readyz` — readiness (checks DB connectivity)
- `GET /api/debug/metrics` — protected by `DEBUG_METRICS_SECRET`

---

## Frontend Architecture

### Pages / Views

All views are in `index.html` — shown/hidden by CSS class toggling (`.hidden`). No routing
library. `main.ts` owns the view-switching logic.

| View | Key Module | Description |
|---|---|---|
| Chart | `chart.ts` | Lightweight Charts, multi-pane (OHLCV + RSI + Volume), VDF zones |
| Breadth | `breadth.ts` | MA breadth gauges + history + normalized compare (Chart.js) |
| Divergence Feed | `divergenceFeed.ts` | Auto-polling alert list, VDF status panel |
| Scan Control | `main.ts` | Start/stop/status for all background jobs |

### Chart View (`src/chart.ts`)

- `Lightweight Charts` loaded from CDN (`declare const LightweightCharts: ...`).
- Multi-pane: main OHLCV pane, optional RSI sub-pane, optional Volume sub-pane.
- VDF zone overlays rendered as custom primitives.
- `chartDataCache` (Map in module scope) caches fetched data; persisted to `sessionStorage`.
- Refresh button: clears cache entry → re-fetches → re-renders.
- Pre-warm triggered after render: loads adjacent intervals in background.

### Breadth View (`src/breadth.ts`)

- `Chart.js` loaded from CDN + annotation plugin. Typed via minimal `ChartInstance` interface
  (not `typeof ChartClass` — that conflicts with CDN annotation plugin).
- `ChartTooltipContext`, `ChartLegendItem`, `ChartLegendHandle`: local interfaces for callbacks.
  No `any` in chart callbacks.
- `BREADTH_MA_HISTORY_DAYS = 60`: named constant for history lookback.
- `initBreadthThemeListener()`: call from `main.ts` — do not register at module scope.
- Normalized compare chart: each series divided by its own first value × 100 (starts at 100).
  Supports MA window selection (21/50/100/200) and timeframe (5d/10d/20d/30d).
- **MA line persistence**: Hidden MA lines (toggled via chart legend) are stored in
  `localStorage` key `'breadth-ma-hidden'` as a JSON array of MA numbers (`['100','200']`).
  Applied on chart render via `applyHiddenMAs()`; updated on legend click via `syncHiddenMAs()`.
  Persists across ticker changes and page reloads. Shared across all three breadth charts.
- **Compare mode** (lock-then-pick): Click a ticker → click Compare → ticker A "locks"
  (`.pane-btn.locked` CSS ring, `pointer-events:none`) → click a different ticker from the
  same row as the 2nd leg → dual chart drawn (solid vs dashed lines). Click Compare again →
  exit compare mode, restore ticker A solo chart. No separate second-ETF button row.
  Dual chart has inline ticker labels at the right end of lines via `dualLineLabels` plugin
  (one label per ticker, drawn at the last visible data point of the first unhidden dataset).
- **Refresh button** (`#breadth-refresh-btn`): Top-right of the breadth container, same
  `.pane-btn.refresh-btn` pattern as chart view. Calls `refreshBreadth()` which first POSTs
  to `/api/breadth/ma/recompute` (triggers server-side re-fetch from data API + recompute
  for today's date), then reloads all charts. The recompute endpoint is session-protected
  (no secret needed). Spinner via `setRefreshButtonLoading()`.
- **Settings panel "Breadth" button** (`#breadth-recompute-btn`): Below Analyze in the
  global settings panel. Same `divergence-run-btn` pattern as Fetch Daily/Weekly/Analyze.
  Triggers `POST /api/breadth/ma/recompute` which fires off a full `bootstrapBreadthHistory`
  (long-running: 5-10 min, re-fetches ALL history from data API). The button handler polls
  `GET /api/breadth/ma/recompute/status` every 3s for live progress. Server-side state uses
  module-level `breadthBootstrapRunning` / `breadthBootstrapStatus` flags in `breadthRoutes.ts`.
  The `onProgress` callback in `bootstrapBreadthHistory` updates the status string during both
  fetch and compute phases. When done, button re-enables and breadth charts reload automatically.
- **No subtitle text**: The breadth page charts have no top-right subtitle spans. All three
  were removed (`breadth-subtitle`, `breadth-ma-subtitle`, `breadth-compare-subtitle`).
- **Price line color**: The comparative chart's price line uses `c.textPrimary` (theme-aware)
  instead of hardcoded `#ffffff`.
- **ETF bar rankings** (4th chart section): Horizontal bar chart (`indexAxis: 'y'`) showing all
  21 ETFs ranked by `% > MA` for the selected MA window (21/50/100/200), sorted descending.
  Per-bar colors via `gaugeColor()`. Value labels drawn by an inline Chart.js plugin
  (`afterDatasetsDraw`) — no external datalabels dependency. Reuses `breadthMAData.snapshots`
  (no additional API call). CSS: `.breadth-bars-section`, `.breadth-bars-chart-wrapper` (600px).
- **Index selector** uses `feed-controls-group feed-controls-group--wrap` (wrapping flex) for the
  21-ETF button row. `currentMAIndex` and `currentCompareIndex` are typed as `string` (not a narrow
  union) so new ETFs can be added without touching `breadth.ts`.
- **ETF constituents** live in `server/data/etfConstituents.ts`. `BreadthIndex` is the union of
  all supported tickers. SLY was replaced by IWM (iShares Russell 2000). After adding a new ETF,
  run the bootstrap endpoint to populate history.
- **Snapshot queries** (`getLatestBreadthSnapshots` in `server/data/breadthStore.ts`) filter by
  `ALL_BREADTH_INDICES` so retired index names (e.g. SLY) in the DB are never returned to the frontend.
- **Bootstrap 200 MA buffer**: `bootstrapBreadthHistory` fetches `numDays + 200` trading days of
  close data so the 200-day SMA is valid even for the earliest snapshot date. Snapshots are only
  computed for the last `numDays` dates — the first 200 days serve purely as SMA lookback buffer.
- **Y-axis**: the MA history chart uses Chart.js auto-scaling (no fixed min/max) with `stepSize:10`
  to keep 10% grid intervals. The 50% annotation line remains.

### CSS Conventions

- CSS custom properties for all colors (`--color-accent`, `--bg-primary`, etc.).
- Dark mode by default; light mode via `[data-theme="light"]` attribute on `<html>`.
- Component-scoped class names: `.pane-btn`, `.breadth-gauge`, `.vd-zone-overlay`.
- Shared refresh button: `createRefreshSvgIcon()`, `setRefreshButtonLoading(btn, loading)`.

### DOM Safety Rules

```typescript
// ✓ Safe
el.textContent = userValue;
el.setAttribute('data-value', sanitized);
const span = document.createElement('span');
span.textContent = label;

// ✗ XSS risk
el.innerHTML = `<b>${userValue}</b>`;   // never with any user-controlled data

// ✓ innerHTML only with static string literals
el.innerHTML = '<svg viewBox="0 0 24 24"><path d="..."/></svg>';
```

---

## Testing

### Framework

Node.js built-in `test` module + `tsx` for TypeScript transpilation. No Jest, Mocha, etc.

```bash
npx tsx --test test/*.test.ts
```

### Test Quality Requirements

Tests in this codebase must meet the same standard as production code:

1. **No dead helpers.** Every function defined in a test file must be called.
2. **No timing-based synchronization.** No `setTimeout(r, 0)` as a yield point.
3. **Silent by default.** Inject no-op stubs for all I/O (DB, network, metrics).
   `console.log` from the module under test is acceptable (structured log output);
   `[query-error]` or stack traces from unexpected DB calls are not.
4. **Deterministic.** Tests must pass consistently in any execution order.
5. **Descriptive names.** Test name = behavior + condition + expected outcome.

### Test File Map

```
test/chartEngine.test.ts          # RSI/RMA, interval parsing, aggregation
test/dataApi.test.ts              # URL building, error classification, rate limiting
test/dateUtils.test.ts            # ET timezone conversions, date math
test/chartMath.test.ts            # OHLCV aggregation, normalization
test/dbMonitor.test.ts            # Query timing instrumentation
test/divergenceRoutes.test.ts     # Route handler integration tests
test/divergenceService.test.ts    # Service logic unit tests
test/healthRoutes.test.ts         # Health endpoint tests
test/healthService.test.ts        # Health payload building
test/scanState.test.ts            # ScanState lifecycle (46 tests), runRetryPasses
test/mapWithConcurrency.test.ts   # Concurrency pool: order, limits, stop, errors, callbacks
test/vdfScanOrchestrator.test.ts  # runVDFScan orchestration via VdfScanDeps injection
```

### Test Patterns

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

// Pure function test
test('calculateRSI returns values between 0 and 100', () => {
  const rsi = calculateRSI(closes, 14);
  for (const val of rsi) assert.ok(val >= 0 && val <= 100);
});

// Orchestrator test (inject deps, suppress all I/O)
function baseDeps(overrides = {}) {
  return {
    isConfigured: () => true,
    getTickers: async () => [] as string[],
    detectTicker: async () => ({ is_detected: false }),
    sweepCache: () => {},
    createMetricsTracker: () => null as any,
    ...overrides,
  };
}

// Deterministic "already running" synchronization
test('runVDFScan returns running when already in progress', async () => {
  let releaseGetTickers!: () => void;
  const getTickersCalled = new Promise<void>((r) => (releaseGetTickers = r));
  let releaseWorker!: () => void;
  const workerBlocked = new Promise<void>((r) => (releaseWorker = r));

  const firstRun = runVDFScan({
    _deps: baseDeps({
      getTickers: async () => {
        releaseGetTickers();  // beginRun() already called → isRunning is true
        await workerBlocked;
        return ['AAA'];
      },
    }),
  });

  await getTickersCalled;  // deterministic — no setTimeout
  const concurrent = await runVDFScan({ _deps: baseDeps() });
  assert.equal(concurrent.status, 'running');

  releaseWorker();
  await firstRun;
});
```

---

## Configuration

### Adding New Config

1. Add named constant to `server/config.ts` with clamping and default:
   ```typescript
   export const MY_CONSTANT = Math.max(1, Number(process.env.MY_CONSTANT) || 100);
   ```
2. Add validation in `validateStartupEnvironment()` if required or constrained.
3. Import from `config.ts` — **never** read `process.env` directly elsewhere.

### Key Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | PostgreSQL primary connection string |
| `DATA_API_KEY` | Warn | — | Market data provider API key |
| `PORT` | No | 3000 | HTTP listen port |
| `SITE_LOCK_PASSCODE` | No | — | Enables site-wide passcode gate |
| `SESSION_SECRET` | Warn | passcode | Secret for signing session tokens |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origins |
| `API_RATE_LIMIT_MAX` | No | 300 | Max requests per 15-minute window |
| `DATA_API_MAX_REQUESTS_PER_SECOND` | No | 99 | Upstream API RPS budget (adaptive concurrency) |
| `DIVERGENCE_DATABASE_URL` | No | — | PostgreSQL for scan/divergence data |
| `DIVERGENCE_TABLE_BUILD_CONCURRENCY` | No | 24 | Max parallel tickers during fetch runs |
| `DIVERGENCE_SCAN_CONCURRENCY` | No | 128 | Max parallel tickers during divergence scan |
| `DEBUG_METRICS_SECRET` | No | — | Secret for debug metrics endpoint |
| `DATA_API_REQUESTS_PAUSED` | No | false | Block all outbound market data calls |

---

## Code Style

### Naming

- Files: `camelCase.ts` for modules; `PascalCase.ts` for class files (`ScanState.ts`).
- Functions: descriptive camelCase verbs (`buildChartRequestKey`, `resolveAdaptiveFetchConcurrency`).
- Constants: `UPPER_SNAKE_CASE` for module-level constants (`SESSION_TTL_MS`, `RETRY_PASS_DIVISORS`).
- Interfaces: `PascalCase` (`TickerWorkerSettled`, `VdfScanDeps`, `ScanStatusFields`).
- Private class fields: `_prefixed` (`_running`, `_resumeState`).

### Imports

- `.js` extensions required in server imports (Node.js ESM).
- Order: external packages → local modules. Group with blank lines.
- `import type` for type-only imports.

### Comments

- JSDoc on every exported function, class, interface.
- Inline comments only where logic is non-obvious. No narration of what code does.
- Named constants always have a comment explaining the magic number's rationale.

---

## Adding New Features

### New API Endpoint

1. Define response type in `shared/api-types.ts`.
2. Add Zod validation schema in `server/schemas.ts`.
3. Add service function in `server/services/*.ts`.
4. Add route handler in `server/routes/*.ts` — thin, no business logic.
5. Register route in `index.ts`.
6. Add tests in `test/`.
7. Run verification checklist.

### New Background Job

1. Create orchestrator in `server/orchestrators/`.
2. Create `ScanState` instance in `server/services/scanControlService.ts`.
3. Register normalizer and canResume validator via `setNormalizeResume` / `setCanResumeValidator`.
4. Expose via `buildRouteOptions` in the route handler.
5. Add `_deps` interface for I/O injection (see `VdfScanDeps` pattern).
6. Use `mapWithConcurrency` for parallel work; `runRetryPasses` for retries.
7. Register cleanup in the shutdown handler in `index.ts`.
8. Write orchestrator tests using injected deps.

### New Frontend View

1. Add the view's HTML container to `index.html` (hidden by default).
2. Add a module `src/myView.ts` with all rendering and event logic.
3. Wire view switching in `main.ts`.
4. Export `initMyViewThemeListener()` — do **not** register at module scope.
5. Use DOM APIs (`createElement`, `textContent`) not `innerHTML` for user-controlled data.
6. Use CSS custom properties for all colors.

---

## Deployment (Railway)

### Required Services

Create in one Railway project/environment:
1. `tradedata` app service (this repo)
2. Primary Postgres service (`DATABASE_URL`)
3. Separate divergence Postgres service (`DIVERGENCE_DATABASE_URL`)

### Service Settings

| Setting | Value |
|---|---|
| Start command | `npm run start` |
| Healthcheck path | `/readyz` |
| Healthcheck timeout | `5s` |
| Healthcheck interval | `15s` |
| Restart policy | `ON_FAILURE` |

### Health Response Shapes

`GET /healthz` (liveness — always 200 while process is alive):
```json
{ "status": "ok", "timestamp": "...", "uptimeSeconds": 12345, "shuttingDown": false }
```

`GET /readyz` (readiness — 503 if `primaryDb` is not `true` or `shuttingDown` is `true`):
```json
{
  "ready": true,
  "degraded": false,
  "shuttingDown": false,
  "primaryDb": true,
  "divergenceDb": true,
  "divergenceConfigured": true,
  "divergenceScanRunning": false,
  "lastScanDateEt": "2026-02-12",
  "circuitBreaker": "CLOSED",
  "dbPool": { "total": 2, "idle": 2, "waiting": 0, "max": 10 },
  "warnings": ["..."],
  "errors": { "primaryDb": null, "divergenceDb": null }
}
```
Notes: `dbPool` is omitted when pool stats are unavailable; `warnings` is omitted when `degraded` is false.

Quick verification:
```bash
curl -sS http://localhost:3000/healthz | jq
curl -sS http://localhost:3000/readyz | jq
```

### Required / Recommended Env Vars

See the **Configuration** section for the full variable list. For a Railway deploy, the minimum viable set is:

```
DATABASE_URL=<primary postgres>
DIVERGENCE_DATABASE_URL=<divergence postgres>
DATA_API_KEY=<provider key>
SITE_LOCK_PASSCODE=<passcode>          # enables auth gate
DIVERGENCE_SCAN_SECRET=<secret>        # protects scan endpoints
DATA_API_MAX_REQUESTS_PER_SECOND=95    # tune to your API plan
```

### Backup Workflow

```bash
# After validating locally (tsc + tests + build):
git push origin main
# Mirror to backup repo:
git push --mirror https://github.com/faridjalali/tradedata-backup.git
```

---

## Anti-Patterns

| Pattern | Why it's wrong | Correct alternative |
|---|---|---|
| `catch (err: any)` | Defeats type safety | `catch (err: unknown)` + `instanceof Error` check |
| `Record<string, any>` for known shapes | Loses all type safety | Define an explicit interface |
| `Function` type | No signature — as loose as `any` | Write the explicit signature: `(...args: unknown[]) => void` |
| `bars: any[]` in frontend | Loses OHLCV type safety | `CandleBar[]` from `shared/api-types.ts` |
| `interval: any` in frontend | Loses interval constraint | `ChartInterval` from `shared/api-types.ts` |
| `process.env.X` outside config.ts | Config is scattered, untestable | Add constant to config.ts |
| `setTimeout(r, 0)` for test sync | Race condition, flaky | Promise gate resolved by the code under test |
| Unused test helpers | Dead code | Delete them |
| DB errors in test output | Missing dep injection | Inject `createMetricsTracker: () => null as any` |
| Module-level `window.addEventListener` | Side effect on import | Export `initXxxListener()`, call from main.ts |
| `innerHTML` with non-literal strings | XSS risk | `textContent` or `createElement` |
| `export let mutableSet` | Leaks mutable state | Unexport; provide read-only accessor if needed |
| Reading `process.env` in lib/ | lib/ must have no external deps | Import constant from config.ts |
| Magic number in concurrency/retry | Unreadable, untunable | Named constant + comment explaining the value |
| `lib/` importing from `services/` | Circular dep risk | Move the pure predicate to `lib/` |
| `err.message` without narrowing | Throws on non-Error | `err instanceof Error ? err.message : String(err)` |
