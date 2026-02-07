# TypeScript Hardening Plan (Post-Migration)

Objective: remove residual migration escape hatches, eliminate weak typing/sloppy paths, and keep orchestrator behavior unchanged under existing tests.

## Execution Rules
1. Execute tickets strictly in order (TH-001 onward).
2. Preserve runtime behavior and schemas.
3. After each ticket: run `npm run typecheck` and relevant tests.
4. Final gate after all tickets:
   - `npm run typecheck`
   - `npm test`
   - `./scripts/verify.sh`

## Status
- [x] TH-001
- [x] TH-002
- [x] TH-003
- [x] TH-004
- [x] TH-005
- [x] TH-006
- [x] TH-007
- [x] TH-008

## Ticket Queue

### TH-001 - Low-Risk Core Utility Hardening
- Scope:
  - `scripts/lint.ts`
  - `benchmarks/run-benchmark.ts`
  - `mcp/server/arbitration.ts`
  - `mcp/server/guardrails.ts`
  - `mcp/server/fanout-controller.ts`
  - `mcp/server/budget-controller.ts`
  - `mcp/server/observability.ts`
  - `mcp/server/trigger.ts`
- Deliverables:
  - Remove `@ts-nocheck`.
  - Add explicit parameter/return types and input guards.
  - Fix NaN/invalid-input edge cases in budget/fanout/trigger utilities.
- Acceptance:
  - `npm run typecheck` passes.
  - `npm run test:unit` passes.

### TH-002 - Tool Interface Typing Contract
- Scope:
  - `mcp/server/tools/types.ts`
- Deliverables:
  - Replace broad `any`-based server interface with typed store/logger/tool contracts used by tool modules.
  - Keep method signatures compatible with runtime.
- Acceptance:
  - `npm run typecheck` passes.
  - `npm run test:unit` passes.

### TH-003 - Tool Module Guardrails (Part 1)
- Scope:
  - `mcp/server/tools/roles.ts`
  - `mcp/server/tools/arbitration.ts`
  - `mcp/server/tools/policies.ts`
  - `mcp/server/tools/observability.ts`
  - `mcp/server/tools/guardrails.ts`
  - `mcp/server/tools/fanout.ts`
- Deliverables:
  - Remove `@ts-nocheck`.
  - Add safe input narrowing for all `input.*` reads.
  - Prevent invalid dates/numbers from silently poisoning behavior.
- Acceptance:
  - `npm run typecheck` passes.
  - `npm run test:unit` and `npm run test:integration` pass.

### TH-004 - Tool Module Guardrails (Part 2)
- Scope:
  - `mcp/server/tools/team-lifecycle.ts`
  - `mcp/server/tools/task-board.ts`
  - `mcp/server/tools/artifacts.ts`
  - `mcp/server/tools/trigger.ts`
  - `mcp/server/tools/agent-lifecycle.ts`
- Deliverables:
  - Remove `@ts-nocheck`.
  - Harden message/task input coercion and lock-version handling.
  - Keep all idempotency and dedupe behavior unchanged.
- Acceptance:
  - `npm run typecheck` passes.
  - `npm run test:unit` and `npm run test:integration` pass.

### TH-005 - Store Typing Hardening
- Scope:
  - `mcp/store/sqlite-store.ts`
- Deliverables:
  - Remove `@ts-nocheck`.
  - Replace unsafe row casts with typed row mapping helpers.
  - Ensure numeric aggregations cannot return NaN/Infinity.
- Acceptance:
  - `npm run typecheck` passes.
  - `npm run test:unit` and `npm run test:integration` pass.

### TH-006 - Bench Harness Typing Hardening
- Scope:
  - `benchmarks/harness.ts`
- Deliverables:
  - Remove `@ts-nocheck`.
  - Replace broad `any` in tool call flow with narrowed typed result handling.
  - Preserve benchmark output schema and pass criteria.
- Acceptance:
  - `npm run typecheck` passes.
  - `npm run test:unit` and `npm run test:integration` pass.
  - `./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive` passes.

### TH-007 - TS Config Strict Closure
- Scope:
  - `tsconfig.json`
- Deliverables:
  - Remove JS/MJS include globs and disable JS allowance once cleanup is complete.
  - Keep runtime/bench/scripts compile strict while preserving existing test execution workflow.
- Acceptance:
  - `npm run typecheck` passes with TS-only source includes.
  - `npm test` passes.

### TH-008 - Final Verification + Hardening Evidence
- Scope:
  - `docs/typescript-migration-evidence.md` (append hardening section)
  - `docs/typescript-strict-escapes.md` (update residual count)
- Deliverables:
  - Record all ticket evidence and remaining debt (if any).
- Acceptance:
  - `npm run typecheck` pass.
  - `npm test` pass.
  - `./scripts/verify.sh` pass.
