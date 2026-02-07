# TypeScript Migration Guardrails

## Baseline Artifacts (TS-001)
- Unit test baseline: `docs/migration-baseline/ts001-test-unit.txt`
- Integration test baseline: `docs/migration-baseline/ts001-test-integration.txt`
- Benchmark command baseline: `docs/migration-baseline/ts001-benchmark.txt`
- Benchmark JSON report: `benchmarks/output/report-1770465401397.json`

## Behavioral Invariants (Do Not Regress)
1. Team thread cap is hard-limited to `max_threads <= 6`.
Evidence: `tests/unit/at002.schemas.test.ts`, `tests/unit/at006.agent-lifecycle.test.ts`, `tests/unit/at012.fanout.test.ts`, `tests/unit/at015.trigger.test.ts`, `tests/integration/at019.hardening.integration.test.ts`
2. Tool call schema validation runs before handler execution.
Evidence: `tests/unit/at004.server.test.ts`, `tests/unit/at002.schemas.test.ts`
3. SQLite migration compatibility remains intact across versions.
Evidence: `tests/unit/at003.sqlite-store.test.ts`, `tests/integration/at003.sqlite-store.integration.test.ts`
4. Message idempotency and duplicate suppression semantics stay unchanged.
Evidence: `tests/unit/at006.agent-lifecycle.test.ts`, `tests/integration/at006.agent-lifecycle.integration.test.ts`
5. DAG task readiness, cycle rejection, and loser-cancel behavior stay unchanged.
Evidence: `tests/unit/at007.task-board.test.ts`, `tests/integration/at007.task-board.integration.test.ts`
6. Trigger phrase detection and complexity fanout semantics remain unchanged.
Evidence: `tests/unit/at015.trigger.test.ts`, `tests/integration/at015.trigger.integration.test.ts`
7. Policy profile loading and adaptive fanout semantics remain unchanged.
Evidence: `tests/unit/at011.policies.test.ts`, `tests/unit/at012.fanout.test.ts`, `tests/integration/at011.policies.integration.test.ts`, `tests/integration/at012.fanout.integration.test.ts`
8. Guardrail policies (early stop, idle sweep) remain unchanged.
Evidence: `tests/unit/at013.guardrails.test.ts`, `tests/integration/at013.guardrails.integration.test.ts`
9. Team-scoped auth and redaction protections remain unchanged.
Evidence: `tests/unit/at019.hardening.test.ts`, `tests/integration/at019.hardening.integration.test.ts`
10. Benchmark gate remains: adaptive must reduce median tokens without quality regression.
Evidence: `tests/unit/at017.benchmark.test.ts`, `tests/integration/at017.benchmark.integration.test.ts`, `scripts/benchmark.sh`

## Migration Risk Log
1. Risk: Type-only refactors can accidentally alter runtime ESM import paths.
Mitigation: Convert in dependency-safe slices; run unit + integration suites after each ticket.
2. Risk: SQLite data marshalling can change from implicit JS coercion.
Mitigation: Introduce explicit entity mapping helpers; preserve migration SQL and query text.
3. Risk: Tool input/output typing may drift from JSON schema contracts.
Mitigation: Keep runtime schema validation as source of truth; add TS contract layer mapped to schema-required fields.
4. Risk: Script migration can break CI/release entrypoints.
Mitigation: Keep shell wrappers stable; prove `verify` and release checks in TS-016.
5. Risk: Benchmark harness conversion can alter gate semantics.
Mitigation: Preserve report schema and pass/fail condition; validate against baseline replay set.

## Rollback Notes
1. If a ticket introduces regression, revert only files touched in that ticket and re-run ticket acceptance commands.
2. Keep benchmark and test baseline artifacts immutable for comparison through TS-016.
3. Do not modify SQL migration files (`mcp/store/migrations/*.sql`) during migration.
4. Preserve command entrypoints (`npm test`, `npm run test:unit`, `npm run test:integration`, `./scripts/benchmark.sh`) until TS-012+ parity is proven.
