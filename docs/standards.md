# Engineering Standards

- Runtime: Node.js >= 24 (ESM modules)
- Persistence: SQLite with explicit lock/timeout/retry strategy
- Traceability: include `team_id`, `agent_id`, `task_id`, `message_id`, `artifact_id` where applicable
- Safety: redact secrets in logs and restrict default message payload to compact artifact references
- Validation: every ticket must include code, tests, docs, and command-backed acceptance evidence
