import type { ToolServerLike } from './types.js';
import { buildRebalancePlan } from '../rebalancer.js';

const ROLE_SCALE_ORDER = ['implementer', 'reviewer', 'tester', 'planner', 'researcher', 'lead'] as const;

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalTaskSize(input: Record<string, unknown>): 'small' | 'medium' | 'high' | null {
  const value = readString(input, 'task_size');
  if (value === 'small' || value === 'medium' || value === 'high') return value;
  return null;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | null {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : null;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function registerRebalancerTools(server: ToolServerLike): void {
  server.registerTool('team_runtime_rebalance', 'team_runtime_rebalance.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    if (!server.tools?.has('team_spawn')) {
      return { ok: false, error: 'team_spawn not registered' };
    }

    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const plan = buildRebalancePlan({
      team,
      store: server.store,
      policy,
      task_size: readOptionalTaskSize(input),
      budget_tokens_remaining: readOptionalNumber(input, 'budget_tokens_remaining'),
      estimated_parallel_tasks: readOptionalNumber(input, 'estimated_parallel_tasks'),
      max_scale_up: readOptionalNumber(input, 'max_scale_up'),
      max_scale_down: readOptionalNumber(input, 'max_scale_down')
    });

    const activeAgents = server
      .store
      .listAgentsByTeam(teamId)
      .filter((agent) => agent.status !== 'offline');
    const activeRoleCounts = new Map<string, number>();
    for (const agent of activeAgents) {
      activeRoleCounts.set(agent.role, (activeRoleCounts.get(agent.role) ?? 0) + 1);
    }

    const spawned: Array<Record<string, unknown>> = [];
    const offline_marked: string[] = [];
    const errors: string[] = [];
    const allowBusyScaleDown = readBoolean(input, 'allow_busy_scale_down', false);

    const scaleOrder = [...ROLE_SCALE_ORDER].sort((a, b) => {
      const aCount = activeRoleCounts.get(a) ?? 0;
      const bCount = activeRoleCounts.get(b) ?? 0;
      if (aCount !== bCount) return aCount - bCount;
      return ROLE_SCALE_ORDER.indexOf(a) - ROLE_SCALE_ORDER.indexOf(b);
    });

    for (let i = 0; i < plan.scale_up_by; i += 1) {
      const role = scaleOrder[i % scaleOrder.length];
      const created = server.callTool('team_spawn', { team_id: teamId, role });
      if (created.ok && created.agent && typeof created.agent === 'object') {
        spawned.push(created.agent as Record<string, unknown>);
        activeRoleCounts.set(role, (activeRoleCounts.get(role) ?? 0) + 1);
      } else {
        errors.push(String(created.error ?? `failed to scale up with role ${role}`));
      }
    }

    const candidates = server
      .store
      .listAgentsByTeam(teamId)
      .filter((agent) => agent.status !== 'offline')
      .filter((agent) => agent.role !== 'lead')
      .filter((agent) => allowBusyScaleDown || agent.status === 'idle')
      .sort((a, b) => {
        if (a.status !== b.status) {
          return a.status === 'idle' ? -1 : 1;
        }
        return String(a.updated_at).localeCompare(String(b.updated_at));
      });

    for (let i = 0; i < plan.scale_down_by && i < candidates.length; i += 1) {
      const agent = candidates[i];
      const updated = server.store.updateAgentStatus(agent.agent_id, 'offline');
      if (updated?.status === 'offline') {
        offline_marked.push(agent.agent_id);
      } else {
        errors.push(`failed to mark offline: ${agent.agent_id}`);
      }
    }

    server.store.logEvent({
      team_id: teamId,
      event_type: 'team_runtime_rebalance',
      payload: {
        current_threads: plan.current_threads,
        target_threads: plan.target_threads,
        scale_up_by: plan.scale_up_by,
        scale_down_by: plan.scale_down_by,
        scaled_up: spawned.length,
        scaled_down: offline_marked.length,
        errors
      }
    });

    return {
      ok: true,
      team_id: teamId,
      plan,
      actions: {
        scaled_up: spawned.length,
        scaled_down: offline_marked.length,
        spawned_agents: spawned.map((agent) => ({
          agent_id: agent.agent_id,
          role: agent.role,
          model: agent.model
        })),
        offline_agent_ids: offline_marked
      },
      errors
    };
  });
}
