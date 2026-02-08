import type { ToolServerLike } from './types.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function registerRecoveryTools(server: ToolServerLike): void {
  server.registerTool('team_orphan_recover', 'team_orphan_recover.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const nowIsoInput = readString(input, 'now_iso');
    const nowMs = Number.isFinite(Date.parse(nowIsoInput)) ? Date.parse(nowIsoInput) : Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const recoveryPolicy = (
      policy.recovery && typeof policy.recovery === 'object'
        ? policy.recovery as Record<string, unknown>
        : {}
    );
    const staleMs = Math.max(
      1,
      Math.floor(
        readNumber(input, 'agent_stale_ms', readNumber(recoveryPolicy, 'agent_stale_ms', 300000))
      )
    );
    const cutoffIso = new Date(nowMs - staleMs).toISOString();

    const leaseRecovery = server.store.recoverExpiredTaskLeases(teamId, nowIso);
    const staleAgents = server.store.markStaleAgentsOffline(teamId, cutoffIso);

    server.store.logEvent({
      team_id: teamId,
      event_type: 'orphan_recovery',
      payload: {
        now_iso: nowIso,
        stale_cutoff_iso: cutoffIso,
        recovered_tasks: leaseRecovery.recovered,
        marked_agents_offline: staleAgents.marked_offline
      }
    });

    return {
      ok: true,
      team_id: teamId,
      recovered_tasks: leaseRecovery.recovered,
      recovered_task_ids: leaseRecovery.tasks.map((task) => task.task_id),
      marked_agents_offline: staleAgents.marked_offline,
      stale_agent_ids: staleAgents.agents.map((agent) => agent.agent_id)
    };
  });
}
