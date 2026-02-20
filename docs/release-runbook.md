# Release Runbook

This project is not enterprise-grade, but releases should still follow a consistent safety checklist.

## Pre-Release Checklist

1. Ensure CI is green on the target commit:
   - `dependency-review` (PRs)
   - `security`
   - `verify`
   - `required-pr-checks`
2. Run local validation:
   - `npm run lint:eslint`
   - `npm run typecheck`
   - `npm run typecheck:server`
   - `npm test`
   - `npm run build`
3. Run smoke checks against the deployed target:
   - `BASE_URL=https://catvue.com npm run release:smoke`
4. Verify market-session context correctness:
   - `curl -sS https://catvue.com/api/trading-calendar/context | jq '.isTodayTradingDay, .isTodayEarlyClose, .isRegularHoursEt, .closeTimeEt'`
5. Verify admin-operations status endpoints:
   - `curl -sS https://catvue.com/api/admin/operations/status | jq '.scheduler, .warmup, .breadthConstituents'`
   - `curl -sS https://catvue.com/api/breadth/constituents/status | jq '.sourceUrlConfigured, .totalTickers'`

## Deployment Steps

1. Merge approved PR into `main`.
2. Deploy `main` using the standard Railway deployment flow.
3. Re-run smoke checks on production:
   - `BASE_URL=https://catvue.com npm run release:smoke`
4. Re-check trading-calendar context payload:
   - `curl -sS https://catvue.com/api/trading-calendar/context | jq '.isRegularHoursEt, .nextRegularOpenEt'`
5. Verify scheduler state and constituent coverage post-release:
   - `curl -sS https://catvue.com/api/admin/operations/status | jq '.scheduler.enabled, .breadthConstituents.totalTickers'`

## Rollback Checklist

1. Identify last known good commit:
   - `git log --oneline --decorate -n 20`
2. Roll back deployment target to that commit.
3. Verify core endpoints:
   - `/healthz`
   - `/readyz`
   - `/api/trading-calendar/context`
   - `/api/alerts`
4. Re-run smoke checks:
   - `BASE_URL=https://catvue.com npm run release:smoke`
5. Document incident:
   - What failed
   - Blast radius
   - Corrective action
