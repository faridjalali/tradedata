# Engineering Instructions

Guidelines for AI coding agents and contributors working on this codebase. Follow these practices to maintain consistency, correctness, and quality.

---

## Project Overview

Real-time market data visualization platform. Fastify API server + vanilla TypeScript frontend with Lightweight Charts. PostgreSQL for persistence, LRU caches for performance, background orchestrators for data pipeline jobs.

**Stack:** Fastify 5 / TypeScript 5.9 / PostgreSQL (pg) / Vite / Pino / Zod / LRU-cache / Lightweight Charts

---

## Architecture

### Directory Structure

```
index.ts                          # Server entry: plugin registration, hooks, routes, startup/shutdown
server/
  config.ts                       # All env-var constants, startup validation
  db.ts                           # PostgreSQL connection pools (primary + divergence)
  middleware.ts                    # Auth, validation wrappers, request metadata
  schemas.ts                      # Zod schemas for all input validation
  logger.ts                       # Pino structured logging, console redirect
  chartMath.ts                    # Pure math functions (RSI, RMA, OHLCV aggregation)
  routes/                         # HTTP route handlers (chart, divergence, health)
  services/                       # Business logic, external API calls, caching
  orchestrators/                  # Multi-step background job coordination
  lib/                            # Shared utilities (dateUtils, dbMonitor, mapWithConcurrency, ScanState)
src/                              # Frontend TypeScript modules
shared/
  api-types.ts                    # Single source of truth for frontend <-> backend type contract
public/                           # Static assets (CSS, icons)
test/                             # Node.js built-in test runner tests
```

### Dependency Direction

Strict unidirectional flow. Never create circular imports.

```
Routes -> Services -> Lib/Utils -> Config
                  \-> DB
Orchestrators -> Services -> Lib/Utils
```

- Routes call services. Routes never contain business logic.
- Services handle domain logic, caching, external API calls.
- Orchestrators coordinate multi-step background workflows (fetch, build, scan).
- Lib contains pure utilities with no side effects.
- Config is read-only after startup.

### Module Registration Pattern

Routes and services receive dependencies via options objects, not global imports:

```typescript
registerChartRoutes({ app, parseChartRequestParams, getOrBuildChartResult, ... });
registerDivergenceRoutes({ app, isDivergenceConfigured, divergencePool, ... });
```

This keeps modules testable and decoupled from the wiring in `index.ts`.

---

## TypeScript

### Strictness

Both `tsconfig.json` (frontend) and `tsconfig.server.json` (backend) use `"strict": true`. The frontend additionally enforces `"noUnusedLocals"` and `"noUnusedParameters"`.

Always run both checks:
```bash
npx tsc --noEmit                              # frontend
npx tsc --noEmit --project tsconfig.server.json  # backend
```

### Shared Types

`shared/api-types.ts` is the single source of truth for the frontend-backend contract. Frontend imports directly; backend references via JSDoc or imports.

When adding a new API endpoint or modifying response shapes, update `shared/api-types.ts` first.

### Zod Schemas

All user input (query params, request bodies, path params) is validated through Zod schemas in `server/schemas.ts`. Schemas provide:
- Type coercion (`z.coerce.number()`)
- Defaults (`z.default('SPY')`)
- Constraints (`z.min(1).max(200)`)
- Custom refinements for date validation

Parse with `safeParse()` and return the first validation issue to the client:

```typescript
const result = schema.safeParse(input);
if (!result.success) {
  const firstIssue = result.error.issues[0];
  return reply.code(400).send({ error: firstIssue?.message || 'Validation failed' });
}
```

### Avoiding `any`

Minimize `any`. Acceptable uses:
- `catch (err: any)` blocks where error shape is unknown
- Deliberate pragmatic cases documented with a comment

For everything else, use specific types, `unknown`, or generics. When working with database rows, define explicit interfaces rather than using `Record<string, any>`.

---

## Security

### Authentication

- **Session auth** (`server/services/sessionAuth.ts`): Cookie-based sessions with 24-hour TTL, `HttpOnly; SameSite=Lax` cookies. In-memory `Map` with auto-cleanup every 15 minutes.
- **Basic auth** (`server/middleware.ts`): Optional HTTP Basic auth with timing-safe string comparison via `crypto.timingSafeEqual()`.
- **Site lock**: Optional passcode gate controlled by `SITE_LOCK_PASSCODE` env var.

Never bypass timing-safe comparison for credential checks. Never log credentials or session tokens.

### Secret Management

- All secrets come from environment variables, loaded once at startup via `server/config.ts`.
- `validateStartupEnvironment()` runs at boot to catch missing required vars and warn about invalid optional ones.
- API keys are redacted before they appear in any log output.
- Never hardcode secrets. Never commit `.env` files.

### Security Headers

Fastify Helmet provides:
- Content Security Policy (strict `self` + explicit CDN allowlist)
- HSTS (1-year max-age, includeSubDomains)
- Referrer-Policy: `strict-origin-when-cross-origin`
- X-Frame-Options: `SAMEORIGIN`

### Rate Limiting

`@fastify/rate-limit` with configurable max requests per window (default 300/15min via `API_RATE_LIMIT_MAX`).

Critical paths are exempt to prevent self-denial during heavy operations:
- `/api/auth/*` (session verification polling)
- `/api/health`, `/api/ready` (health checks)
- `/api/divergence/scan/status` (scan progress polling)

When adding endpoints that will be polled frequently, consider whether they need rate-limit exemption.

### Input Validation

- Always use parameterized queries (`$1, $2, ...`) for SQL. Never interpolate user input into query strings.
- Validate all inputs at the boundary via Zod schemas.
- Sanitize query strings before logging (extract safe metadata only via `extractSafeRequestMeta()`).

### CORS

Configurable via `CORS_ORIGIN` env var. Credentials enabled when origin is specified. Default allows all origins for development.

---

## Database

### Connection Pools

Defined in `server/db.ts`. Two optional pools:
- **Primary pool**: Required. Main application data (alerts, chart cache).
- **Divergence pool**: Optional. Large-scale scan data (configured via `DIVERGENCE_DATABASE_URL`).

Pool settings: max 20 connections, 2s connection timeout, 30s idle timeout, 30s statement timeout. These prevent runaway queries and connection leaks.

### Query Patterns

- Always use parameterized queries.
- Batch inserts with `ON CONFLICT DO UPDATE` for upserts.
- Use `withDivergenceClient()` for transactional access to the divergence pool.
- Connection pool instrumented via `server/lib/dbMonitor.ts` for slow query detection (default 500ms threshold).

### Schema Management

Tables created with `CREATE TABLE IF NOT EXISTS` at startup. Column migrations applied conditionally. Indexes created with `IF NOT EXISTS`.

When adding new tables or columns:
1. Add `CREATE TABLE IF NOT EXISTS` in the init function.
2. Add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for migrations.
3. Add indexes after table creation.

---

## Caching

### Multi-Tier LRU Strategy

The project uses `lru-cache` extensively with a timed-entry pattern:

```typescript
interface TimedCacheEntry {
  value: unknown;
  freshUntil: number;   // Serve directly (Cache-Control max-age equivalent)
  staleUntil: number;   // Serve stale while revalidating in background
}
```

This implements Stale-While-Revalidate (SWR): fresh data is served instantly, stale data triggers a background refresh, and expired data forces a synchronous fetch.

### Request Deduplication

In-flight request maps prevent duplicate concurrent fetches. If two requests arrive for the same chart data, the second waits for the first:

```typescript
const inFlight = CHART_IN_FLIGHT_REQUESTS.get(requestKey);
if (inFlight) { await inFlight; return; }
```

### Pre-Warming

`server/services/chartPrewarm.ts` pre-builds related intervals after a chart loads (e.g., loading 4hour triggers background builds of 1day and 1week). Each target is awaited sequentially to avoid resource spikes.

### Frontend Cache

`chartDataCache` in `src/chart.ts` caches fetched chart data in a `Map` keyed by `ticker:interval`. Persisted to `sessionStorage` for cross-navigation reuse. The refresh button explicitly evicts the cache entry before re-fetching.

---

## Error Handling

### Structured Error Types

Custom error interfaces carry HTTP status and classification flags:

```typescript
interface DataApiError extends Error {
  httpStatus?: number;
  isDataApiPaused?: boolean;
  isDataApiRateLimited?: boolean;
  isTaskTimeout?: boolean;
}
```

### Route Error Pattern

Routes catch errors and map them to appropriate HTTP responses:

```typescript
try {
  const result = await service.doWork(...);
  return reply.send(result);
} catch (err) {
  if (isRateLimitedError(err)) return reply.code(429).send({ error: 'Rate limited' });
  if (isPausedError(err)) return reply.code(503).send({ error: 'Service paused' });
  return reply.code(500).send({ error: 'Internal error' });
}
```

### Result Pattern

Functions that can fail return discriminated unions:

```typescript
{ ok: true as const, data: T }
{ ok: false as const, error: string }
```

### Graceful Degradation

- Cache miss falls back to API fetch; API failure falls back to stale cache.
- Background jobs are best-effort; failures are logged but never crash the server.
- Pre-warm errors are swallowed with optional logging.

---

## Performance

### Concurrency Control

`server/lib/mapWithConcurrency.ts` provides a configurable worker pool for batch operations:

```typescript
await mapWithConcurrency(tickers, concurrency, worker, onSettled, shouldStop);
```

Features:
- Configurable parallelism
- Per-item callback for progress reporting
- Graceful stop via `shouldStop()` predicate
- Adaptive concurrency based on API rate limits (`resolveAdaptiveFetchConcurrency()`)

### Background Jobs

Long-running operations (divergence scans, data fetches, table builds) run as background orchestrators. Each uses `ScanState` for lifecycle management:
- Start/stop/pause/resume semantics
- Progress tracking (total, processed, errors)
- Resume state persistence for interrupted jobs
- Retry passes with decreasing concurrency (full -> half -> quarter)

### Response Compression

`@fastify/compress` compresses responses above a configurable minimum size. Chart data responses set explicit `Cache-Control` headers with `max-age` and `stale-while-revalidate`.

### Graceful Shutdown

```
SIGTERM/SIGINT -> set isShuttingDown flag -> reject new requests with 503
  -> clear scheduled timers -> drain in-flight requests
  -> close DB pools -> exit
  -> 15-second force-exit safety net
```

When adding new interval timers or background processes, ensure they are cleaned up in the shutdown handler.

---

## Observability

### Structured Logging

All logging goes through Pino (`server/logger.ts`). Console methods are redirected to Pino so every `console.log/warn/error` produces structured JSON:

```json
{"level":"info","time":"2025-01-15T10:30:00.000Z","msg":"[chart] SPY 4hour cache hit"}
```

Use `logStructured(level, event, fields)` for structured events with metadata. Use standard console methods for simple messages.

### Database Monitoring

`server/lib/dbMonitor.ts` wraps pool queries with timing. Slow queries (>500ms by default) are logged with duration and sanitized SQL excerpt (first 200 chars).

### Health Endpoints

- `GET /healthz` - Liveness: always 200 if process is running.
- `GET /readyz` - Readiness: checks DB connectivity and divergence pool status.
- `GET /api/debug/metrics` - Debug metrics (protected by `DEBUG_METRICS_SECRET`).

### Request Tracking

Each request gets a unique ID via `createRequestId()`. Request metadata (method, path, query keys, ticker, interval) is extracted safely for logging without exposing sensitive data.

---

## Frontend

### Architecture

Vanilla TypeScript with direct DOM manipulation. No framework. Modules are organized by feature:

- `chart.ts` - Lightweight Charts integration, multi-pane rendering
- `main.ts` - View switching, global navigation
- `divergenceFeed.ts` - Real-time alert feed
- `utils.ts` - Shared DOM helpers
- `theme.ts` - Dark/light theme via CSS custom properties
- `components.ts` - Reusable UI elements

### CSS Conventions

- CSS custom properties for theming (30+ variables in `:root`).
- Dark mode by default with semantic color names.
- Component-scoped class names (e.g., `.pane-btn`, `.refresh-btn`, `.vd-zone-overlay`).
- Shared utility classes for common patterns:
  - `.pane-btn` - Standard toolbar button
  - `.pane-btn.refresh-btn` - Refresh button with loading animation
  - `.pane-btn.refresh-btn.loading svg` - Triggers `@keyframes refresh-spin`

### Shared UI Patterns

When creating buttons or UI elements that appear in multiple places, extract shared helpers:

```typescript
// Shared refresh button helpers (used by divergence, VDF, and chart refresh buttons)
function createRefreshSvgIcon(): SVGSVGElement { ... }
function setRefreshButtonLoading(btn: HTMLElement, loading: boolean): void { ... }
```

All three refresh buttons use the same SVG icon, CSS class, and loading animation. When adding new instances of existing patterns, always use the shared helper.

### State Management

- Global mutable state is kept in module-level variables (e.g., `currentChartTicker`, `currentChartInterval`).
- Session-level cache persisted to `sessionStorage`.
- View switching via CSS class toggling (`.hidden`).

---

## Testing

### Framework

Node.js built-in `test` module. No external test framework.

```bash
npm test                    # Runs: node --test test/*.test.ts
```

### Test Organization

Tests live in `/test/` and mirror the server module structure:

```
test/chartEngine.test.ts      # RSI/RMA calculations, interval parsing
test/dataApi.test.ts           # URL building, error classification
test/dateUtils.test.ts         # Timezone conversions, date math
test/chartMath.test.ts         # OHLCV aggregation, normalization
test/dbMonitor.test.ts         # Query timing instrumentation
test/divergenceRoutes.test.ts  # Route handler integration tests
test/divergenceService.test.ts # Service logic unit tests
test/healthRoutes.test.ts      # Health endpoint tests
test/healthService.test.ts     # Health payload building
```

### Test Patterns

- **Pure function tests**: Direct input/output assertions. No mocks needed.
- **Route tests**: Create Fastify instance, register routes with mock dependencies, test HTTP responses.
- **No external mock libraries**: Tests use simple function stubs and direct assertions.

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('calculateRSI returns values between 0 and 100', () => {
  const rsi = calculateRSI(closes, 14);
  for (const val of rsi) {
    assert.ok(val >= 0 && val <= 100);
  }
});
```

### What to Test

- Core math and calculation logic (RSI, RMA, aggregation).
- Input validation and schema parsing.
- Route handlers with various input combinations.
- Error classification and response mapping.
- Health check payload construction.

---

## CI/CD

### GitHub Actions Pipeline

Runs on push to `main` and pull requests:

```
1. npm ci
2. npx eslint .
3. npx tsc --noEmit                              (frontend typecheck)
4. npx tsc --noEmit --project tsconfig.server.json  (server typecheck)
5. node --test test/*.test.ts
6. npm run build                                  (vite build)
```

All steps must pass. Never merge with typecheck errors or failing tests.

### Verification Checklist

Before committing any change, run:

```bash
npx tsc --noEmit                              # Frontend types
npx tsc --noEmit --project tsconfig.server.json  # Server types
npm test                                       # All tests pass
npm run build                                  # Vite build succeeds
```

---

## Configuration

### Environment Variables

All config is centralized in `server/config.ts`. Every env var has:
- A sensible default (or is required with startup validation).
- Range clamping for numeric values (`Math.max(min, Number(val) || default)`).
- Type coercion and normalization.

When adding new configuration:
1. Add the constant to `server/config.ts` with default and range clamping.
2. Add validation in `validateStartupEnvironment()` if the value is required or has constraints.
3. Export and import from `config.ts` - never read `process.env` directly in other modules.

### Key Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `DATA_API_KEY` | Warn | - | Market data API key |
| `PORT` | No | 3000 | Server listen port |
| `SITE_LOCK_PASSCODE` | No | - | Enables site-wide passcode gate |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origins |
| `LOG_LEVEL` | No | info | Pino log level |
| `API_RATE_LIMIT_MAX` | No | 300 | Max requests per 15-minute window |
| `DIVERGENCE_DATABASE_URL` | No | - | Separate DB for scan data |
| `DEBUG_METRICS_SECRET` | No | - | Secret for debug metrics endpoint |

---

## Code Style

### General Principles

- **Small, composable modules.** Each file has a clear single responsibility.
- **Prefer boring, proven patterns.** No clever abstractions for one-time operations.
- **Minimal changes.** Only modify what the task requires. Don't refactor surrounding code, add unsolicited comments, or "improve" working code.
- **No over-engineering.** Three similar lines are better than a premature abstraction. Don't design for hypothetical future requirements.
- **Delete unused code.** No backwards-compatibility shims, no `_unused` variables, no `// removed` comments.

### Naming

- Files: `camelCase.ts` for modules, `PascalCase.ts` for classes (e.g., `ScanState.ts`).
- Functions: `camelCase`. Descriptive verbs (`buildChartRequestKey`, `validateSession`, `extractSafeRequestMeta`).
- Constants: `UPPER_SNAKE_CASE` for true constants (`SESSION_TTL_MS`, `CHART_TIMING_SAMPLE_MAX`).
- Interfaces: `PascalCase` (`TimedCacheEntry`, `PrewarmDeps`, `ScanStatusFields`).

### Imports

- Use `.js` extensions in server imports (Node.js ESM resolution).
- Group imports: external packages first, then local modules.
- Use `import type` for type-only imports.

---

## Adding New Features

### New API Endpoint

1. Define types in `shared/api-types.ts`.
2. Add Zod schema in `server/schemas.ts` for input validation.
3. Add service function in appropriate `server/services/*.ts` file.
4. Add route handler in appropriate `server/routes/*.ts` file.
5. Register route in `index.ts`.
6. Add tests in `test/`.
7. Run full verification checklist.

### New Background Job

1. Create orchestrator in `server/orchestrators/`.
2. Use `ScanState` for lifecycle management.
3. Use `mapWithConcurrency` for parallel work.
4. Implement retry passes with `runRetryPasses`.
5. Wire up start/stop/status in route handler.
6. Add cleanup in the shutdown handler.

### New Frontend Component

1. Check if a shared helper already exists (e.g., `createRefreshSvgIcon`, `setRefreshButtonLoading`).
2. Add HTML element in `index.html` (prefer empty containers populated by JS).
3. Add event handlers and rendering in the appropriate `src/*.ts` module.
4. Use CSS custom properties for colors. Add component styles in `public/style.css`.
5. Follow existing patterns for loading states (`.loading` class toggle, CSS animations).

---

## Anti-Patterns to Avoid

- **Reading `process.env` outside `config.ts`.** All env vars go through config.
- **SQL string interpolation.** Always use parameterized queries.
- **Logging secrets or tokens.** Redact before logging.
- **Circular imports.** Maintain strict dependency direction.
- **Framework-less error handling in routes.** Fastify catches thrown errors; use it.
- **Polling without rate-limit consideration.** If an endpoint will be polled frequently, exempt it from rate limiting.
- **Inline SVG in HTML for dynamic elements.** Populate from JS using shared helpers.
- **Blocking the event loop with synchronous operations.** Use async/await, background jobs, and connection pooling.
- **Adding `any` without justification.** Use `unknown` and narrow, or define proper interfaces.
- **Skipping the verification checklist.** Every change must pass typecheck + tests + build.
