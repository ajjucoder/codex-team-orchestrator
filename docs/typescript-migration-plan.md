# Codex Team Orchestrator - Full TypeScript Refactor Plan

## Goal
Migrate the entire orchestrator codebase from JavaScript to TypeScript with no behavior regression, full test coverage parity, and stricter compile-time safety for team orchestration flows.

Primary outcomes:
1. Runtime behavior remains equivalent to current JavaScript implementation.
2. All runtime modules under `mcp/`, `benchmarks/`, and test suites run from TypeScript sources.
3. Type safety is enforced in CI and local verification (`strict` mode by final milestone).
4. Existing reliability guarantees remain intact: max thread cap, compact messaging, DAG task readiness, resumable runs.

## Non-Goals
1. No language/runtime rewrite to Go/Bun in this plan.
2. No protocol redesign of MCP tools.
3. No intentional orchestration-policy changes unless required to preserve behavior.

## Migration Constraints (Non-Negotiable)
1. Preserve all existing tool contracts and JSON schema behavior.
2. Preserve SQLite migration history compatibility.
3. Keep benchmark gate semantics unchanged (adaptive must beat fixed-6 without quality loss).
4. Avoid big-bang rewrite; migrate in dependency-safe tickets.
5. Every ticket must include code + tests + docs + acceptance evidence.

## Start Command for Build Agent (Strict Manager Prompt)
Use this exact prompt to execute the migration:

```text
Implement `docs/typescript-migration-plan.md` end-to-end with strict execution control.

Manager directives:
1. Execute tickets sequentially from TS-001 to TS-016 with no skips.
2. For each ticket, complete: code + tests + docs + acceptance evidence.
3. After each ticket, output only:
   - Ticket(s) completed
   - Files changed
   - Tests run and results
   - Acceptance criteria evidence
   - Risks/follow-ups
   - Exact next ticket
4. Do not claim completion without command evidence.
5. If any verification fails, fix immediately before proceeding.
6. Preserve current behavior unless the ticket explicitly allows change.
7. Continue automatically unless blocked by external credentials or missing dependencies.
8. If blocked, issue a minimal unblock request and continue non-blocked work.

Hard quality gates:
1. Zero functional regressions in unit + integration tests.
2. TypeScript compilation passes with strict settings by the final milestone.
3. No run may exceed `max_threads=6`.
4. Final benchmark gate must still pass.
```

## Target Repository State
1. Runtime/source modules converted to `.ts` (or `.mts` where required by tooling).
2. Test suites converted to TypeScript.
3. Tooling updated: TypeScript compiler + typecheck scripts + TS-aware test execution.
4. Legacy `.js` runtime sources removed after parity is proven.

## Milestones and Ticket Order

### M1 - Baseline and Tooling
- TS-001 Baseline freeze and migration guardrails
- TS-002 TypeScript toolchain bootstrap
- TS-003 TS-compatible lint/format/test/verify script wiring

### M2 - Core Runtime Conversion
- TS-004 Convert foundational server modules (`contracts`, `ids`, `tracing`, `usage-estimator`)
- TS-005 Convert persistence layer (`mcp/store`) with typed entities
- TS-006 Convert MCP server core and registry plumbing
- TS-007 Convert lifecycle and tool modules under `mcp/server/tools`
- TS-008 Convert policy/fanout/budget/guardrail/observability controllers

### M3 - Schema, Contracts, and Tests
- TS-009 Introduce typed DTO/entity definitions aligned with JSON schemas
- TS-010 Convert unit tests to TypeScript
- TS-011 Convert integration tests to TypeScript
- TS-012 Enforce test parity and remove JS test entrypoints

### M4 - Benchmarks, Scripts, and Strictness
- TS-013 Convert benchmark harness and runner to TypeScript
- TS-014 Convert Node scripts (`scripts/*.mjs`) to TypeScript or typed JS strategy
- TS-015 Enable strict compiler gates and eliminate `any` escape hatches
- TS-016 Final cleanup, docs, and release verification

## Detailed Ticket Breakdown

### TS-001 - Baseline Freeze and Migration Guardrails
Deliverables:
1. Snapshot current test/benchmark baseline outputs in `docs/` (or `benchmarks/output/`).
2. Add migration risk log and rollback notes.
3. Document behavioral invariants that must not change.

Required evidence:
```bash
npm run test:unit
npm run test:integration
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
```

Acceptance criteria:
1. Baseline artifacts exist and are referenced in docs.
2. Known invariants are documented and mapped to tests.

---

### TS-002 - TypeScript Toolchain Bootstrap
Deliverables:
1. Add `typescript` and required TS runtime tooling (example: `tsx`).
2. Add `tsconfig.json` (initially permissive enough for incremental migration).
3. Add `npm` scripts: `typecheck`, `build:types` (if needed), TS-aware test commands.

Acceptance criteria:
1. `npm run typecheck` executes successfully on initial mixed JS/TS state.
2. Existing JS tests still run unchanged.

---

### TS-003 - Script Wiring for TS Workflow
Deliverables:
1. Update `package.json` scripts for TS-aware execution paths.
2. Update `scripts/verify.sh` to include typecheck gate.
3. Keep old commands available during transition if needed.

Acceptance criteria:
1. `./scripts/verify.sh` passes in mixed-mode repository.
2. CI/local commands are documented in README or docs.

---

### TS-004 - Convert Foundational Server Modules
Scope:
1. `mcp/server/contracts.*`
2. `mcp/server/ids.*`
3. `mcp/server/tracing.*`
4. `mcp/server/usage-estimator.*`

Deliverables:
1. Convert modules to TypeScript with explicit input/output types.
2. Keep exports and runtime semantics identical.

Acceptance criteria:
1. Unit tests touching these modules pass.
2. Typecheck has no errors in converted files.

---

### TS-005 - Convert Persistence Layer (`mcp/store`)
Scope:
1. `mcp/store/sqlite-store.*`
2. migration entry/loading code
3. typed store entity interfaces (`Team`, `Agent`, `Task`, `Artifact`, `RunEvent`, etc.)

Deliverables:
1. Strongly typed store API.
2. No migration compatibility break.

Acceptance criteria:
1. Store unit + integration tests pass.
2. Existing SQLite migrations execute without change.

---

### TS-006 - Convert MCP Server Core
Scope:
1. `mcp/server/server.*`
2. `mcp/server/index.*`

Deliverables:
1. Typed tool registration/call flow.
2. Typed auth context and logging payloads.

Acceptance criteria:
1. Tool invocation behavior remains unchanged.
2. No schema validation regressions.

---

### TS-007 - Convert Tool Modules Under `mcp/server/tools`
Scope:
1. `team-lifecycle`, `agent-lifecycle`, `task-board`, `artifacts`, `roles`, `arbitration`, `trigger`, `fanout`, `policies`, `guardrails`, `observability`

Deliverables:
1. Convert all tool modules to TS.
2. Add shared tool input/output type aliases for consistency.

Acceptance criteria:
1. Tool-focused unit/integration tests all pass.
2. Trigger, DAG readiness, and fanout behavior remain unchanged.

---

### TS-008 - Convert Orchestration Controllers
Scope:
1. `policy-engine`, `fanout-controller`, `budget-controller`, `guardrails`, `observability`, `arbitration`, `trigger`

Deliverables:
1. Typed orchestration control logic.
2. Zero behavior changes in policy/fanout gates.

Acceptance criteria:
1. AT-011 to AT-015 equivalent tests pass.
2. Benchmark semantics unchanged.

---

### TS-009 - Typed Domain Contracts Aligned to Schemas
Deliverables:
1. Add TypeScript domain types matching JSON schemas in `mcp/schemas/`.
2. Ensure runtime schema validation remains source of truth.
3. Add compile-time mappings for tool inputs/outputs where practical.

Acceptance criteria:
1. No mismatch between schema-required fields and TS types.
2. Contract tests continue passing.

---

### TS-010 - Convert Unit Tests to TypeScript
Deliverables:
1. Migrate `tests/unit/**/*.test.js` to `tests/unit/**/*.test.ts`.
2. Keep assertions and semantics identical unless flake fixes are required.

Acceptance criteria:
1. `npm run test:unit` passes via TS execution path.
2. No net loss in test coverage intent.

---

### TS-011 - Convert Integration Tests to TypeScript
Deliverables:
1. Migrate `tests/integration/**/*.test.js` to TypeScript.
2. Preserve setup/teardown behavior and file paths.

Acceptance criteria:
1. `npm run test:integration` passes via TS execution path.
2. Orchestration flows (start/spawn/send/task/artifact/trigger) remain green.

---

### TS-012 - Test Parity and JS Test Path Removal
Deliverables:
1. Remove obsolete JS-only test globs from scripts.
2. Ensure top-level `npm test` runs full TS suite.

Acceptance criteria:
1. `npm test`, `npm run test:unit`, `npm run test:integration` pass.
2. No `.test.js` runtime entrypoints remain (except intentional compatibility shims).

---

### TS-013 - Benchmark Harness Conversion
Deliverables:
1. Convert `benchmarks/harness.js` and `benchmarks/run-benchmark.mjs` to TS-compatible execution.
2. Preserve report schema and pass/fail gate logic.

Acceptance criteria:
1. `./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive` still works.
2. Output format remains backward compatible.

---

### TS-014 - Script Conversion and Tooling Hardening
Deliverables:
1. Convert or type-harden `scripts/*.mjs` and related utilities.
2. Ensure install/check/verify/release scripts are stable.

Acceptance criteria:
1. `./scripts/check-config.sh` passes.
2. `./scripts/verify.sh` remains green after conversion.

---

### TS-015 - Strictness Pass
Deliverables:
1. Turn on strict TS settings (including `strict: true`, `noImplicitAny`, etc.).
2. Resolve remaining unsafe types, with minimal justified escapes.

Acceptance criteria:
1. `npm run typecheck` passes with strict settings.
2. No unreviewed `// @ts-ignore` or broad `any` usage.

---

### TS-016 - Final Cleanup, Docs, and Release Verification
Deliverables:
1. Remove obsolete JS runtime sources after parity confirmation.
2. Update docs/README for TS-first contributor workflow.
3. Produce final migration report with before/after evidence.

Required evidence:
```bash
npm run format
npm run lint
npm run typecheck
npm test
./scripts/verify.sh
./scripts/release-ready.sh
```

Acceptance criteria:
1. Full verification stack passes.
2. Migration report includes risks, follow-ups, and residual debt.

## Per-Ticket Checklist (Mandatory)
- [x] Code implemented
- [x] Unit tests added/updated and passing
- [x] Integration tests added/updated and passing
- [x] Typecheck passing for changed modules
- [x] Docs updated
- [x] Acceptance evidence captured
- [x] No behavioral regression detected

## Ticket Tracker
| Ticket | Depends On | Implementation Complete | Tests Complete | Docs Complete | Acceptance Evidence Linked | Regression Check |
|---|---|---|---|---|---|---|
| TS-001 | - | [x] | [x] | [x] | [x] | [x] |
| TS-002 | TS-001 | [x] | [x] | [x] | [x] | [x] |
| TS-003 | TS-002 | [x] | [x] | [x] | [x] | [x] |
| TS-004 | TS-003 | [x] | [x] | [x] | [x] | [x] |
| TS-005 | TS-004 | [x] | [x] | [x] | [x] | [x] |
| TS-006 | TS-005 | [x] | [x] | [x] | [x] | [x] |
| TS-007 | TS-006 | [x] | [x] | [x] | [x] | [x] |
| TS-008 | TS-007 | [x] | [x] | [x] | [x] | [x] |
| TS-009 | TS-008 | [x] | [x] | [x] | [x] | [x] |
| TS-010 | TS-009 | [x] | [x] | [x] | [x] | [x] |
| TS-011 | TS-010 | [x] | [x] | [x] | [x] | [x] |
| TS-012 | TS-011 | [x] | [x] | [x] | [x] | [x] |
| TS-013 | TS-012 | [x] | [x] | [x] | [x] | [x] |
| TS-014 | TS-013 | [x] | [x] | [x] | [x] | [x] |
| TS-015 | TS-014 | [x] | [x] | [x] | [x] | [x] |
| TS-016 | TS-015 | [x] | [x] | [x] | [x] | [x] |

## Global Acceptance Criteria
1. Entire orchestrator runtime and tests execute from TypeScript sources.
2. No regression in orchestration behavior and guardrails.
3. Strict typecheck passes.
4. Full verify and benchmark gates pass.
5. Migration docs are complete enough for new contributors.

## Report Format for Every Progress Update
1. Ticket(s) completed
2. Files changed
3. Tests run and results
4. Acceptance criteria evidence
5. Risks/follow-ups
6. Exact next ticket
