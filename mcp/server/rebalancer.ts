import { deriveTokenCostPerAgent } from './budget-controller.js';
import { recommendFanout } from './fanout-controller.js';
import type { AgentRecord, TeamRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';

type TaskSize = 'small' | 'medium' | 'high';

interface RebalanceInput {
  team: TeamRecord;
  store: SqliteStore;
  policy: Record<string, unknown>;
  task_size?: TaskSize | null;
  budget_tokens_remaining?: number | null;
  estimated_parallel_tasks?: number | null;
  max_scale_up?: number | null;
  max_scale_down?: number | null;
}

interface RebalancePlan {
  task_size: TaskSize;
  backlog: {
    ready_tasks: number;
    in_progress_tasks: number;
    estimated_parallel_tasks: number;
  };
  budget_controller: {
    token_cost_per_agent: number;
    source: string;
    sample_count: number;
    avg_sample_tokens: number;
    call_multiplier: number;
    budget_tokens_remaining: number;
  };
  recommendation: {
    recommended_threads: number;
    affordable_threads: number;
    allowed_range: {
      min: number;
      max: number;
    };
    reasons: string[];
  };
  current_threads: number;
  target_threads: number;
  scale_up_by: number;
  scale_down_by: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function inferTaskSize(estimatedParallelTasks: number): TaskSize {
  if (estimatedParallelTasks <= 2) return 'small';
  if (estimatedParallelTasks <= 4) return 'medium';
  return 'high';
}

function activeAgents(agents: AgentRecord[]): AgentRecord[] {
  return agents.filter((agent) => agent.status !== 'offline');
}

export function buildRebalancePlan(input: RebalanceInput): RebalancePlan {
  const { team, store, policy } = input;
  const active = activeAgents(store.listAgentsByTeam(team.team_id));
  const readyTasks = store.listReadyTasks(team.team_id, 1000).length;
  const inProgressTasks = store.listTasks(team.team_id, 'in_progress').length;
  const rawEstimated = toNumber(input.estimated_parallel_tasks, Math.max(1, readyTasks + inProgressTasks));
  const estimatedParallelTasks = clamp(Math.floor(rawEstimated), 1, 6);
  const taskSize = input.task_size ?? inferTaskSize(estimatedParallelTasks);
  const budgetTokensRemaining = Math.max(0, Math.floor(toNumber(input.budget_tokens_remaining, 12000)));

  const tokenCostEstimate = deriveTokenCostPerAgent({
    store,
    team_id: team.team_id,
    task_size: taskSize
  });

  const recommendation = recommendFanout({
    policy,
    task_size: taskSize,
    estimated_parallel_tasks: estimatedParallelTasks,
    budget_tokens_remaining: budgetTokensRemaining,
    token_cost_per_agent: tokenCostEstimate.token_cost_per_agent,
    team_max_threads: team.max_threads
  });

  const currentThreads = active.length;
  let targetThreads = clamp(recommendation.recommended_threads, 1, Math.min(team.max_threads, 6));
  if (readyTasks === 0 && inProgressTasks === 0) {
    targetThreads = 1;
  }

  const maxScaleUp = clamp(Math.floor(toNumber(input.max_scale_up, 6)), 0, 6);
  const maxScaleDown = clamp(Math.floor(toNumber(input.max_scale_down, 6)), 0, 6);
  const scaleUpBy = Math.min(maxScaleUp, Math.max(0, targetThreads - currentThreads));
  const scaleDownBy = Math.min(maxScaleDown, Math.max(0, currentThreads - targetThreads));

  return {
    task_size: taskSize,
    backlog: {
      ready_tasks: readyTasks,
      in_progress_tasks: inProgressTasks,
      estimated_parallel_tasks: estimatedParallelTasks
    },
    budget_controller: {
      token_cost_per_agent: tokenCostEstimate.token_cost_per_agent,
      source: tokenCostEstimate.source,
      sample_count: tokenCostEstimate.sample_count,
      avg_sample_tokens: tokenCostEstimate.avg_sample_tokens,
      call_multiplier: toNumber(tokenCostEstimate.call_multiplier, 0),
      budget_tokens_remaining: budgetTokensRemaining
    },
    recommendation: {
      recommended_threads: recommendation.recommended_threads,
      affordable_threads: recommendation.affordable_threads,
      allowed_range: recommendation.allowed_range,
      reasons: recommendation.reasons
    },
    current_threads: currentThreads,
    target_threads: targetThreads,
    scale_up_by: scaleUpBy,
    scale_down_by: scaleDownBy
  };
}
