import type { ToolServerLike } from './types.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : fallback;
}

function ensureTeamAgent(server: ToolServerLike, teamId: string, agentId: string): { ok: true } | { ok: false; error: string } {
  const team = server.store.getTeam(teamId);
  if (!team) return { ok: false, error: `team not found: ${teamId}` };
  const agent = server.store.getAgent(agentId);
  if (!agent) return { ok: false, error: `agent not found: ${agentId}` };
  if (agent.team_id !== teamId) return { ok: false, error: `agent ${agentId} not in team ${teamId}` };
  return { ok: true };
}

export function registerLeaseTools(server: ToolServerLike): void {
  server.registerTool('team_agent_heartbeat', 'team_agent_heartbeat.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const agentId = readString(input, 'agent_id');
    const guard = ensureTeamAgent(server, teamId, agentId);
    if (!guard.ok) return guard;

    const heartbeatAt = readString(input, 'heartbeat_at') || new Date().toISOString();
    const agent = server.store.heartbeatAgent(agentId, heartbeatAt);
    if (!agent) {
      return { ok: false, error: `agent not found: ${agentId}` };
    }

    return {
      ok: true,
      team_id: teamId,
      agent_id: agentId,
      last_heartbeat_at: agent.last_heartbeat_at
    };
  });

  server.registerTool('team_task_lease_acquire', 'team_task_lease_acquire.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const taskId = readString(input, 'task_id');
    const agentId = readString(input, 'agent_id');
    const guard = ensureTeamAgent(server, teamId, agentId);
    if (!guard.ok) return guard;

    const lease = server.store.acquireTaskLease({
      team_id: teamId,
      task_id: taskId,
      agent_id: agentId,
      lease_ms: readNumber(input, 'lease_ms', 300000),
      expected_lock_version: Number.isFinite(Number(input.expected_lock_version))
        ? Number(input.expected_lock_version)
        : null
    });
    if (!lease.ok) {
      return { ok: false, error: lease.error ?? 'failed to acquire lease' };
    }
    return {
      ok: true,
      task: lease.task
    };
  });

  server.registerTool('team_task_lease_renew', 'team_task_lease_renew.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const taskId = readString(input, 'task_id');
    const agentId = readString(input, 'agent_id');
    const guard = ensureTeamAgent(server, teamId, agentId);
    if (!guard.ok) return guard;

    const renewed = server.store.renewTaskLease({
      team_id: teamId,
      task_id: taskId,
      agent_id: agentId,
      lease_ms: readNumber(input, 'lease_ms', 300000)
    });
    if (!renewed.ok) {
      return { ok: false, error: renewed.error ?? 'failed to renew lease' };
    }
    return {
      ok: true,
      task: renewed.task
    };
  });

  server.registerTool('team_task_lease_release', 'team_task_lease_release.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const taskId = readString(input, 'task_id');
    const agentId = readString(input, 'agent_id');
    const guard = ensureTeamAgent(server, teamId, agentId);
    if (!guard.ok) return guard;

    const released = server.store.releaseTaskLease({
      team_id: teamId,
      task_id: taskId,
      agent_id: agentId
    });
    if (!released.ok) {
      return { ok: false, error: released.error ?? 'failed to release lease' };
    }
    return {
      ok: true,
      task: released.task
    };
  });
}
