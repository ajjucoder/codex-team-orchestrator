# Release Checklist

1. Run `npm run lint`
2. Run `npm run test:unit`
3. Run `npm run test:integration`
4. Run `./scripts/verify.sh`
5. Run `./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive`
6. Run `./scripts/check-config.sh`
7. Package release via `./scripts/package-release.sh`
8. Validate generated archive contents and checksums
