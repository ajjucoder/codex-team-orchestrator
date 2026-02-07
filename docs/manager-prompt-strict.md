# Strict Manager Prompt

Use this prompt to start the build agent in strict execution mode:

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
