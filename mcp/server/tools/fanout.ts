import type { ToolServerLike } from './types.js';
import { recommendFanout } from '../fanout-controller.js';
import { deriveTokenCostPerAgent } from '../budget-controller.js';

type TaskSize = 'small' | 'medium' | 'high';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : fallback;
}

function readTaskSize(input: Record<string, unknown>): TaskSize {
  const value = readString(input, 'task_size');
  if (value === 'medium' || value === 'high') return value;
  return 'small';
}

export function registerFanoutTools(server: ToolServerLike): void {
  server.registerTool('team_plan_fanout', 'team_plan_fanout.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const plannedRoles = Array.isArray(input.planned_roles)
      ? input.planned_roles.map((role) => String(role))
      : [];
    const taskSize = readTaskSize(input);

    const policy = server.policyEngine?.resolveTeamPolicy(team);
    const costEstimate = deriveTokenCostPerAgent({
      store: server.store,
      team_id: team.team_id,
      task_size: taskSize,
      planned_roles: plannedRoles,
      explicit_token_cost_per_agent: readNumber(input, 'token_cost_per_agent', 0) || null
    });
    const recommendation = recommendFanout({
      policy,
      task_size: taskSize,
      estimated_parallel_tasks: readNumber(input, 'estimated_parallel_tasks', 1),
      budget_tokens_remaining: readNumber(input, 'budget_tokens_remaining', 0),
      token_cost_per_agent: costEstimate.token_cost_per_agent,
      team_max_threads: team.max_threads
    });

    return {
      ok: true,
      team_id: team.team_id,
      profile: team.profile,
      task_size: taskSize,
      recommendation,
      budget_controller: {
        token_cost_per_agent: costEstimate.token_cost_per_agent,
        source: costEstimate.source,
        sample_count: costEstimate.sample_count,
        avg_sample_tokens: costEstimate.avg_sample_tokens,
        call_multiplier: costEstimate.call_multiplier ?? 0
      }
    };
  });
}
