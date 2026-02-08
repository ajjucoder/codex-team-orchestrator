# Agent Teams Verification Status

Date: 2026-02-08

This document captures concrete evidence that agent-team coordination is implemented and working.

## Verified Capabilities

1. Specialized role-based team members are spawned and coordinated.
2. Agent-to-agent direct messaging works through the shared bus.
3. Broadcast messaging fan-out works to team peers.
4. Inbox pull + acknowledgement flow works.
5. Artifact references are exchanged across messages.
6. Cross-team message attempts are denied.

## Runtime Implementation Points

- Message tools:
  - `mcp/server/tools/agent-lifecycle.ts:365` (`team_send`)
  - `mcp/server/tools/agent-lifecycle.ts:496` (`team_broadcast`)
  - `mcp/server/tools/agent-lifecycle.ts:624` (`team_pull_inbox`)
- Inbox persistence and ack:
  - `mcp/store/sqlite-store.ts:638` (`pullInbox`)
  - `mcp/store/sqlite-store.ts:662` (`ackInbox`)

## Test Evidence

- Agent lifecycle/message bus integration:
  - `tests/integration/at006.agent-lifecycle.integration.test.ts`
  - Covers broadcast, inbox pull/ack, duplicate suppression, and role-shaped spawn.
- Artifact-ref exchange:
  - `tests/integration/at008.artifacts.integration.test.ts`
- Cross-team isolation:
  - `tests/integration/at019.hardening.integration.test.ts:20`

## Verification Commands

```bash
node --import tsx --test tests/integration/at006.agent-lifecycle.integration.test.ts
node --import tsx --test tests/integration/at008.artifacts.integration.test.ts
node --import tsx --test tests/integration/at019.hardening.integration.test.ts
npm run test:unit:ts
npm run test:integration:ts
./scripts/check-config.sh
./scripts/verify.sh
```

## Latest Result Snapshot

- `AT-006` integration suite: pass
- Full unit suite: `95/95` pass
- Full integration suite: `48/48` pass
- `check-config`: pass
- `verify`: pass

## Benchmark Quality/Usage Status

Latest internal benchmark report confirms adaptive orchestration keeps quality while reducing usage:
- Report path: `.tmp/v2-audit-report.json`
- Median tokens: `11515` -> `10192.5` (`-1322.5`, about `11.49%`)
- Median quality: `1` -> `1`
- V2 gates: pass (`scripts/v2-eval-gates.ts`)

Note: this benchmark is internal baseline-vs-candidate, not a direct external A/B against Claude Agent Teams.
