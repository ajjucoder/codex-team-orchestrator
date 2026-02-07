# TypeScript Strictness Escapes (Updated)

Strict mode is enabled globally in `tsconfig.json` (`strict: true`, `noImplicitAny: true`).

## Current Escape Status
- `@ts-nocheck`: none in `mcp/`, `benchmarks/`, `scripts/`, `tests/`
- `@ts-ignore`: none in `mcp/`, `benchmarks/`, `scripts/`, `tests/`
- `@ts-expect-error`: none in `mcp/`, `benchmarks/`, `scripts/`, `tests/`

## Verification
- `npm run typecheck`: pass
- `npm test`: pass
- `./scripts/verify.sh`: pass

## Notes
- Runtime/source TS compilation is strict and JS/MJS source globs were removed from `tsconfig.json`.
- Test execution remains validated through Node test runs (`npm test` / `verify.sh`).
