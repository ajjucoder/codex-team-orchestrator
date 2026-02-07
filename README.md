# Codex Team Orchestrator

Production-ready multi-agent orchestration runtime for Codex with:
- Codex-led control plane and worker-specialist teams
- Shared message bus, task board, artifact exchange, and arbitration
- Swappable YAML behavior profiles (`fast`, `default`, `deep`)
- Adaptive fan-out under strict `max_threads=6`
- Structured observability and replay
- Installer, verifier, and benchmark tooling

## Trigger

Use the phrase `use agent teams` to activate team-mode orchestration.

## Repository Layout

- `mcp/`: runtime server, schemas, and persistence
- `profiles/`: swappable policy profiles
- `skills/agent-teams/`: skill pack and references
- `scripts/`: install/verify/smoke/benchmark/release tooling
- `benchmarks/`: fixed eval set and harness
- `docs/`: implementation and ticket-level evidence

## Quick Start

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
./scripts/verify.sh
./scripts/check-config.sh
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
```

## TypeScript Workflow

The repository is TypeScript-first for runtime, tests, benchmarks, and Node script entrypoints:

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm test
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
```

`npm run test:unit:ts` and `npm run test:integration:ts` remain as explicit TS aliases.

## Release

```bash
./scripts/release-ready.sh
```

This runs full validation and builds a versioned archive in `dist/`.
