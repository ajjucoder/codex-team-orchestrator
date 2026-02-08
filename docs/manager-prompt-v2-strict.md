# Strict Manager Prompt (V2)

Use this prompt to execute V2 in strict sequential mode:

```text
Implement `docs/implementation-plan-v2.md` end-to-end with strict execution control.

Manager directives:
1. Execute tickets sequentially from V2-001 to V2-016 with no skips.
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
6. Preserve current behavior unless ticket explicitly allows change.
7. Continue automatically unless blocked by external credentials or missing dependencies.
8. If blocked, issue minimal unblock request and continue non-blocked work.

Hard quality gates:
1. Zero functional regressions in unit + integration tests.
2. TypeScript compilation passes with strict settings.
3. No run may exceed `max_threads=6`.
4. Final benchmark gate must pass.
```
