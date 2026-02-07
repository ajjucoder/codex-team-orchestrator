import { evaluateEarlyStop, evaluateIdleTeams } from '../guardrails.js';

export function registerGuardrailTools(server) {
  server.registerTool('team_guardrail_check', 'team_guardrail_check.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }

    const policy = server.policyEngine.resolveTeamPolicy(team);
    const earlyStop = evaluateEarlyStop({
      policy,
      consensus_reached: input.consensus_reached,
      open_tasks: input.open_tasks
    });

    return {
      ok: true,
      compact_messages: Boolean(policy?.guardrails?.compact_messages ?? true),
      early_stop: earlyStop
    };
  });

  server.registerTool('team_idle_sweep', 'team_idle_sweep.schema.json', (input) => {
    const nowMs = input.now_iso ? Date.parse(input.now_iso) : Date.now();
    const activeTeams = server.store.listActiveTeams();

    const stale = evaluateIdleTeams({
      teams: activeTeams,
      policyByProfile: (profile) => server.policyEngine.loadProfile(profile),
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
