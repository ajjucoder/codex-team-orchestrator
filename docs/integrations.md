# External Integrations

Outbound and inbound bridge adapters are implemented in:

- `mcp/integrations/github.ts`
- `mcp/integrations/jira.ts`
- `mcp/integrations/slack.ts`

## Outbound

Each adapter exposes a `syncTeamUpdate...` function that returns:

- `ok`
- `retryable`
- `target`
- normalized outbound `payload`

Failures are isolated per adapter and can be retried without mutating orchestrator state.

## Inbound

Each adapter exposes `map...InboundEvent` that validates input and produces safe task patch objects (`ticket_id`, `status`, `description`) for orchestrator task updates.
