# Operations Runbook

## Health Endpoints

### `GET /healthz`
Purpose: liveness check (process is running).

Expected response (`200`):

```json
{
  "status": "ok",
  "timestamp": "2026-02-12T20:15:30.123Z",
  "uptimeSeconds": 12345,
  "shuttingDown": false
}
```

Notes:
- This does not verify database connectivity.
- Returns `200` while app process is alive.

### `GET /readyz`
Purpose: readiness check (safe to receive traffic).

Expected response (`200` when ready, `503` when not ready):

```json
{
  "ready": true,
  "shuttingDown": false,
  "primaryDb": true,
  "divergenceDb": true,
  "divergenceConfigured": true,
  "divergenceScanRunning": false,
  "lastScanDateEt": "2026-02-12",
  "errors": {
    "primaryDb": null,
    "divergenceDb": null
  }
}
```

Readiness criteria:
- `shuttingDown === false`
- `primaryDb === true`

## Railway Configuration

Recommended settings:

1. Start command: `npm run start`
2. Healthcheck path: `/readyz`
3. Healthcheck timeout: `5s`
4. Healthcheck interval: `15s`
5. Restart policy: `ON_FAILURE`

Optional fallback:
- Use `/healthz` only if you want pure process liveness and do not want DB readiness gating.

## Environment Requirements

Required at startup:
- `DATABASE_URL`

Recommended:
- `MASSIVE_API_KEY`
- `DIVERGENCE_DATABASE_URL` (if using Divergence features)
- `WEBHOOK_SECRET`
- `DIVERGENCE_SCAN_SECRET`

If `BASIC_AUTH_ENABLED=true`:
- `BASIC_AUTH_PASSWORD` must be set.

## Graceful Shutdown Behavior

On `SIGTERM`/`SIGINT`, server:

1. Marks itself as shutting down.
2. Returns `503` for new requests.
3. Stops divergence scheduler timer.
4. Stops cleanup intervals.
5. Closes HTTP listener.
6. Closes Postgres pools.

If shutdown exceeds 15 seconds, process exits with code `1`.

## Quick Verification Commands

```bash
curl -sS http://127.0.0.1:3000/healthz | jq
curl -sS http://127.0.0.1:3000/readyz | jq
```
