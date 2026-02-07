import type { ToolServerLike } from './types.js';
import { evaluateEarlyStop, evaluateIdleTeams } from '../guardrails.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const numeric = Number(input[key]);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function registerGuardrailTools(server: ToolServerLike): void {
  server.registerTool('team_guardrail_check', 'team_guardrail_check.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const earlyStop = evaluateEarlyStop({
      policy,
      consensus_reached: readBoolean(input, 'consensus_reached', false),
      open_tasks: readNumber(input, 'open_tasks', 0)
    });

    const guardrails = policy.guardrails;
    const compactMessages = (
      guardrails &&
      typeof guardrails === 'object' &&
      typeof (guardrails as Record<string, unknown>).compact_messages === 'boolean'
    )
      ? Boolean((guardrails as Record<string, unknown>).compact_messages)
      : true;

    return {
      ok: true,
      compact_messages: compactMessages,
      early_stop: earlyStop
    };
  });

  server.registerTool('team_idle_sweep', 'team_idle_sweep.schema.json', (input) => {
    const nowIso = readString(input, 'now_iso');
    const parsedNow = nowIso ? Date.parse(nowIso) : Date.now();
    const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
    const activeTeams = server.store.listActiveTeams();

    const stale = evaluateIdleTeams({
      teams: activeTeams,
      policyByProfile: (profile) => server.policyEngine?.loadProfile(profile),
      nowMs
    });

    for (const team of stale) {
      server.store.updateTeamStatus(team.team_id, 'finalized');
      server.store.logEvent({
        team_id: team.team_id,
        event_type: 'idle_shutdown',
        payload: {
          idle_ms: team.idle_ms,
          idle_threshold_ms: team.idle_threshold_ms
        }
      });
    }

    return {
      ok: true,
      finalized_count: stale.length,
      finalized_teams: stale
    };
  });
}
