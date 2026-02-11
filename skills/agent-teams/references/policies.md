# Team Policies

- Use compact artifact references between agents by default.
- Do not exchange full transcripts unless explicitly requested.
- Preserve model inheritance from active Codex session.
- Never exceed `max_threads=6`.
- Record trace IDs for team, agent, task, message, and artifact whenever applicable.
- Isolate each worker in a dedicated git branch/worktree for the run.
- Use `main` as the default base branch for integration unless the user explicitly overrides it.
- Do not merge worker branches without reviewer + tester evidence.
- Treat timeout waits as `still running (timeout window)` rather than failure.
