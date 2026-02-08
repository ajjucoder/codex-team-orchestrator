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
