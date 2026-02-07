import { makeRunSummary, replayTeamEvents } from '../observability.js';

export function registerObservabilityTools(server) {
  server.registerTool('team_run_summary', 'team_run_summary.schema.json', (input) => {
    const summary = makeRunSummary(server.store, input.team_id);
    if (!summary) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }
    return {
      ok: true,
      summary
    };
  });

  server.registerTool('team_replay', 'team_replay.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }

    const events = replayTeamEvents(server.store, input.team_id, input.limit ?? 1000);
    return {
      ok: true,
      team_id: input.team_id,
      event_count: events.length,
      events
    };
  });
}
