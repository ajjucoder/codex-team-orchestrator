---
name: agent-teams
description: Enable Codex-led team orchestration with worker specialization, shared task board, and compact artifact exchange. Use when the user asks for team mode or says "use agents team".
license: Complete terms in LICENSE.txt
---

# Agent Teams Skill

Trigger phrase: `use agents team`
Legacy alias accepted: `use agent teams`

Purpose:
- Enable Codex-led team orchestration with worker specialization, shared task board, and compact artifact exchange.

Core role pack (v1):
- lead
- planner
- implementer
- reviewer
- tester
- researcher

Operational defaults:
- Preserve active-session model inheritance unless explicitly overridden.
- Message bus uses compact summaries and artifact references by default.
- Hard cap: `max_threads=6`.

Execution status protocol (required):
- Maintain a local worker-state table for every spawned worker: `pending_init|running|completed|failed`.
- Poll workers with longer wait windows (`>=120000ms`) to reduce noisy empty polls.
- If a wait call returns no newly completed workers, report:
  - `still running (timeout window)` and include counts `running=<n> completed=<n> failed=<n>`.
- Do not describe that state as failure.
- Remove completed/failed worker IDs from future wait receiver lists.
- Keep user-facing progress messages explicit and deterministic even when tool logs show `agents: none`.
