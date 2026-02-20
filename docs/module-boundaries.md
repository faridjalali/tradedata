# Module Boundaries

This repository uses explicit boundaries to keep coupling low and reduce architecture risk.

## Dependency Rules

- `server/routes/**`
  - May import: `server/services/**`, `server/lib/**`, `server/config.ts`, `server/db.ts`, `shared/**`
  - Must not import: `server/orchestrators/**`, `src/**`
- `server/services/**`
  - May import: `server/lib/**`, `server/config.ts`, `server/db.ts`, `shared/**`, other `server/services/**`
  - Must not import: `server/routes/**`, `src/**`
- `server/orchestrators/**`
  - May import: `server/services/**`, `server/lib/**`, `server/config.ts`, `server/db.ts`, `shared/**`
  - Must not import: `server/routes/**`, `src/**`
- `src/**` (frontend)
  - May import: `src/**`, `shared/**`
  - Must not import: `server/**`
- `shared/**`
  - Must remain side-effect free and transport/framework agnostic.

## Enforced Checks

- ESLint `no-restricted-imports` guards are configured in `eslint.config.mjs`.
- CI runs ESLint and both TypeScript projects on each pull request.

## Runtime Context Endpoints

- `index.ts` may host lightweight operational/context routes that compose existing
  services without introducing new route-module coupling (for example
  `/api/trading-calendar/context` based on `server/services/tradingCalendar.ts`).
- Keep these handlers thin, side-effect free, and dependency-direction compliant.

## Dead Code Policy

- Do not keep no-op placeholders in production paths.
- Remove unreachable branches during feature work when safely possible.
- If code is intentionally retained for migration compatibility, mark it with:
  - A clear owner
  - A removal trigger
  - A target removal date
