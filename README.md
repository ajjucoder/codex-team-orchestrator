# Codex Team Orchestrator

Production-ready multi-agent orchestration runtime for Codex with:
- Codex-led control plane and worker-specialist teams
- Shared message bus, task board, artifact exchange, and arbitration
- Swappable YAML behavior profiles (`fast`, `default`, `deep`)
- Adaptive fan-out under strict `max_threads=6`
- Structured observability and replay
- Installer, verifier, and benchmark tooling

## Trigger

Use the phrase `use agents team` to activate team-mode orchestration.
Legacy alias `use agent teams` is also supported.

## Use With Any Coding Agent

You can hand this repository to Claude Code, Codex, or any coding AI agent and ask it to install the team orchestrator in that environment.

Copy/paste this instruction to your coding agent:

```text
Use this repository as the source of truth and install the Agent Teams skill.
1) Run: ./scripts/install.sh
2) Validate: ./scripts/check-config.sh
3) (Optional) Validate tests: npm run test:unit:ts && npm run test:integration:ts
4) Confirm skill exists at: ~/.codex/skills/agent-teams/SKILL.md (or equivalent CODEX_HOME)
5) In a new chat, trigger with: "use agents team <objective>"
```

Notes:
- Works with default `CODEX_HOME` and custom `CODEX_HOME`.
- Trigger alias `use agent teams` remains backward-compatible.
- Start a fresh chat after install so the updated skill is loaded.

## Repository Layout

- `mcp/`: runtime server, schemas, and persistence
- `profiles/`: swappable policy profiles
- `skills/agent-teams/`: skill pack and references
- `scripts/`: install/verify/smoke/benchmark/release tooling
- `benchmarks/`: fixed eval set and harness
- `docs/`: implementation and ticket-level evidence

## Verification Evidence

- Agent-team communication and coordination verification:
  - `docs/agent-teams-verification.md`

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
