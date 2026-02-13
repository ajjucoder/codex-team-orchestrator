# Release Checklist

1. Run `npm run lint`
2. Run `npm run typecheck`
3. Run `npm run test:unit`
4. Run `npm run test:integration`
5. Run `./scripts/verify.sh`
6. Run `./scripts/check-config.sh`
7. Run `./scripts/release-ready.sh` (migration + deterministic contract gate)
8. Validate benchmark report and gate outcome
9. Package release via `./scripts/package-release.sh`
10. Validate generated archive contents and checksums
11. Confirm release notes and runbook links:
    - `docs/ATX_RUNTIME_ARCHITECTURE.md`
    - `docs/ATX_OPERATIONS_RUNBOOK.md`
    - `docs/ATX_RELEASE_READINESS.md`
