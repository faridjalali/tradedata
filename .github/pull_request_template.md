## Summary

- What changed:
- Why:
- Risk level (`low` / `medium` / `high`):

## Review Checklist

- [ ] I removed dead code paths introduced by this change.
- [ ] I verified module boundaries (no cross-layer imports outside allowed paths).
- [ ] I updated docs for any architecture or behavior change.
- [ ] I added or updated tests for changed behavior.
- [ ] I validated failure paths and error handling for touched code.
- [ ] I verified no secrets/tokens were added to code, logs, or fixtures.

## Validation

- [ ] `npm run lint:eslint`
- [ ] `npm run typecheck`
- [ ] `npm run typecheck:server`
- [ ] `npm test`
- [ ] `npm run build`

## Notes for Reviewers

- Ownership area(s) touched:
- Follow-up work (if any):
