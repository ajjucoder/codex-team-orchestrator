# Codex Team Orchestrator - Implementation Plan

## Goal
Build a production-ready, reusable multi-agent orchestrator for Codex with Claude-Agent-Teams-style coordination, direct inter-agent communication, and better efficiency than naive fixed fan-out.

Primary operating model:
1. Main orchestrator is the active Codex agent (lead/controller).
2. Team agents are worker specialists coordinated by Codex.
3. Worker agents communicate through a shared team message bus (not direct full transcript exchange).
4. System must reduce token/tool usage versus fixed fan-out while maintaining quality.

## Trigger
- Required trigger phrase: `use agents team`
- Legacy alias accepted: `use agent teams`

## Start Command for Build Agent (Strict Manager Prompt)
Use this exact prompt to start implementation:

```text
Implement `docs/implementation-plan.md` end-to-end with strict execution control.

Manager directives:
1. You are executing under strict manager mode.
2. Codex is the lead orchestrator agent. All spawned agents are workers.
3. Execute tickets sequentially from AT-001 to AT-019 with no skips.
4. For each ticket, complete: code + tests + docs + acceptance evidence.
5. After each ticket, output only:
   - Ticket(s) completed
   - Files changed
   - Tests run and results
   - Acceptance criteria evidence
   - Risks/follow-ups
   - Exact next ticket
6. Do not claim completion without command evidence.
7. If any verification fails, fix immediately before proceeding.
8. Never exceed `max_threads=6`.
9. Default to compact artifact references between agents; never share full transcripts by default.
10. Preserve active-session model inheritance.
11. Continue automatically unless blocked by external credentials.
12. If blocked, issue a minimal unblock request and continue non-blocked tasks.

Hard quality and efficiency gates:
1. Team messaging and artifact exchange must be visible in structured logs.
2. Adaptive fan-out must show:
   - small tasks: 1-2 agents
   - medium tasks: 3-4 agents
   - high-parallel tasks: 5-6 agents max
3. Any run with `threads > 6` is an automatic fail.
4. Final benchmark must show lower median token usage than fixed-6 baseline with no quality regression on fixed eval set.
```

## Core Constraints (Non-Negotiable)
1. Shared team message bus for agent-to-agent communication.
2. Team task board, artifact sharing, and merge/arbitration support.
3. Swappable behavior profiles via YAML (`fast`, `default`, `deep`) without code edits.
4. Portable setup via `git clone` + install scripts.
5. Mandatory self-verification with command evidence before completion.
6. Preserve default model inheritance from active Codex session.
7. Hard cap: `max_threads=6` (never exceed).
8. Codex remains the primary lead/orchestrator in team mode.
9. Orchestration mode must decrease usage versus fixed fan-out baseline without quality drop.

## Technical Invariants
1. Message bus delivery: at-least-once with idempotency keys.
2. No full transcript sharing by default; compact artifact references only.
3. Conflict-safe task and artifact operations.
4. Trace IDs on all relevant entities: `team_id`, `agent_id`, `task_id`, `message_id`, `artifact_id`.
5. Explicit SQLite lock/timeout/retry strategy.
6. Team-scoped access controls and secret redaction in logs.
7. Crash recovery and resumable runs.

## Required Repository Structure
```text
mcp/server
mcp/schemas
mcp/store
skills/agent-teams/SKILL.md
skills/agent-teams/references/roles.md
skills/agent-teams/references/policies.md
profiles/default.team.yaml
profiles/fast.team.yaml
profiles/deep.team.yaml
scripts/install.sh
scripts/uninstall.sh
scripts/check-config.sh
scripts/verify.sh
benchmarks/
docs/
```

## Execution Rules (All Tickets)
1. Respect dependency order; do not skip dependencies.
2. Implement code + tests + docs in the same ticket.
3. If verification fails, fix before moving on.
4. Do not mark ticket complete without acceptance evidence.
5. No regression in previously passing tests.

## Milestones and Ticket Order

### M1 - Core Orchestration
- AT-001 Repository bootstrap and standards
- AT-002 MCP API contracts and schemas
- AT-003 SQLite persistence and migrations
- AT-004 MCP server skeleton and health checks
- AT-005 Team lifecycle tools (`team_start`, `team_status`, `team_finalize`)
- AT-006 Agent lifecycle tools (`team_spawn`, `team_send`, `team_broadcast`, `team_pull_inbox`)
- Note: include minimal structured tracing in M1

### M2 - Team Collaboration
- AT-007 Shared task board: claim/update/conflict-safe locking
- AT-008 Artifact exchange: publish/read/version/checksum
- AT-009 Role pack v1: lead/planner/implementer/reviewer/tester/researcher
- AT-010 Merge/arbitration engine: consensus/lead/strict_vote

### M3 - Efficiency and Swappability
- AT-011 Policy engine with swappable YAML profiles (`fast/default/deep`)
- AT-012 Adaptive fan-out + budget controller (`2 -> 3-4 -> up to 6 when justified`)
- AT-013 Efficiency guardrails: early-stop, idle shutdown, compact messaging
- AT-014 Observability: structured logs, run summaries, replay

### M4 - UX and Distribution
- AT-015 Codex skill integration for trigger phrase
- AT-016 Installer/uninstaller/config-check scripts
- AT-017 Benchmark harness and fixed-6 baseline comparison
- AT-018 Release packaging, docs, versioning, GitHub-ready distribution
- AT-019 Hardening pass (resilience/security/perf edge cases)

## Per-Ticket Checklist Template
Use this for every ticket before moving to the next:

- [ ] Code implemented
- [ ] Unit tests added and passing
- [ ] Integration tests added and passing
- [ ] Docs updated
- [ ] Acceptance criteria met
- [ ] Evidence commands captured
- [ ] Regression suite passes

## Ticket Tracker (Fill During Execution)
| Ticket | Depends On | Implementation Complete | Tests Complete | Docs Complete | Acceptance Evidence Linked | Regression Check |
|---|---|---|---|---|---|---|
| AT-001 | - | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-002 | AT-001 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-003 | AT-002 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-004 | AT-003 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-005 | AT-004 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-006 | AT-005 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-007 | AT-006 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-008 | AT-007 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-009 | AT-008 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-010 | AT-009 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-011 | AT-010 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-012 | AT-011 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-013 | AT-012 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-014 | AT-013 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-015 | AT-014 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-016 | AT-015 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-017 | AT-016 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-018 | AT-017 | [ ] | [ ] | [ ] | [ ] | [ ] |
| AT-019 | AT-018 | [ ] | [ ] | [ ] | [ ] | [ ] |

## Global Acceptance Criteria
1. `use agents team` automatically triggers orchestration (legacy alias `use agent teams` also accepted).
2. Peer communication works through message bus.
3. Team size auto-scales but never exceeds 6.
4. Default model inheritance is preserved.
5. Codex remains lead orchestrator while worker agents execute delegated tasks.
6. Benchmarks show efficiency improvement vs fixed-6 with no quality drop.
7. Benchmark report includes token/time/quality deltas and pass/fail conclusion.
8. Fresh clone + install + smoke test succeeds.

## Self-Verification Protocol (Mandatory)
1. Run formatting, lint, unit tests, integration tests, and `scripts/verify.sh`.
2. Run smoke scenarios:
   - Small task: expected `1-2` agents
   - Medium task: expected `3-4` agents
   - High parallel task: can scale to `5-6`
3. Validate no run exceeds `max_threads=6`.
4. Validate peer messaging and artifact exchange in logs.
5. Validate profile swaps change behavior without code changes.
6. Validate installer in clean environment.
7. Publish benchmark report with token/time/quality deltas using fixed eval set.

## Evidence Commands (Template)
```bash
# formatting + lint
npm run format && npm run lint

# tests
npm test
npm run test:unit
npm run test:integration

# verify
./scripts/verify.sh

# smoke
./scripts/smoke.sh small
./scripts/smoke.sh medium
./scripts/smoke.sh high

# benchmarks
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
```

## Report Format (Required for Every Progress/Final Update)
1. Ticket(s) completed
2. Files changed
3. Tests run and results
4. Acceptance criteria evidence
5. Risks or follow-ups
6. Exact next ticket to execute

## Execution Mode
1. Start implementation immediately.
2. Do not stop at planning.
3. Execute sequentially unless blocked by missing external credentials.
4. If blocked, provide minimal unblock request and continue non-blocked tasks.
5. Use strict manager mode prompt from this document.
