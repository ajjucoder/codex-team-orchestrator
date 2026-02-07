import type { ToolServerLike } from './types.js';
import { makeRunSummary, replayTeamEvents } from '../observability.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readLimit(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export function registerObservabilityTools(server: ToolServerLike): void {
  server.registerTool('team_run_summary', 'team_run_summary.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const summary = makeRunSummary(server.store, teamId);
    if (!summary) {
      return { ok: false, error: `team not found: ${teamId}` };
    }
    return {
      ok: true,
      summary
    };
  });

  server.registerTool('team_replay', 'team_replay.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const limit = readLimit(input, 'limit', 1000);
    const events = replayTeamEvents(server.store, teamId, limit);
    return {
      ok: true,
      team_id: teamId,
      event_count: events.length,
      events
    };
  });
}
