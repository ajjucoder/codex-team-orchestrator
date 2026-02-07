type TaskSize = 'small' | 'medium' | 'high';

interface FanoutPolicy {
  fanout?: {
    small_min?: unknown;
    small_max?: unknown;
    medium_min?: unknown;
    medium_max?: unknown;
    high_min?: unknown;
    high_max?: unknown;
  };
}

interface FanoutRange {
  min: number;
  max: number;
}

interface FanoutInput {
  policy?: FanoutPolicy;
  task_size: TaskSize;
  estimated_parallel_tasks: number;
  budget_tokens_remaining: number;
  token_cost_per_agent: number;
  team_max_threads?: number;
}

interface FanoutRecommendation {
  recommended_threads: number;
  allowed_range: FanoutRange;
  hard_cap: 6;
  affordable_threads: number;
  reasons: string[];
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function rangeForSize(policy: FanoutPolicy | undefined, taskSize: TaskSize): FanoutRange {
  const fanout = policy?.fanout ?? {};
  if (taskSize === 'small') {
    return {
      min: clamp(toFiniteNumber(fanout.small_min, 1), 1, 2),
      max: clamp(toFiniteNumber(fanout.small_max, 2), 1, 2)
    };
  }
  if (taskSize === 'medium') {
    return {
      min: clamp(toFiniteNumber(fanout.medium_min, 3), 3, 4),
      max: clamp(toFiniteNumber(fanout.medium_max, 4), 3, 4)
    };
  }
  return {
    min: clamp(toFiniteNumber(fanout.high_min, 5), 5, 6),
    max: clamp(toFiniteNumber(fanout.high_max, 6), 5, 6)
  };
}

export function recommendFanout({
  policy,
  task_size,
  estimated_parallel_tasks,
  budget_tokens_remaining,
  token_cost_per_agent,
  team_max_threads
}: FanoutInput): FanoutRecommendation {
  const base = rangeForSize(policy, task_size);
  const hardCap = clamp(Math.floor(toFiniteNumber(team_max_threads, 6)), 1, 6);
  const range = {
    min: clamp(base.min, 1, hardCap),
    max: clamp(base.max, 1, hardCap)
  };

  const safeDemand = Math.floor(toFiniteNumber(estimated_parallel_tasks, range.min));
  const parallelDemand = clamp(safeDemand, range.min, range.max);
  const safeBudget = Math.max(0, toFiniteNumber(budget_tokens_remaining, 0));
  const safeCost = Math.max(1, toFiniteNumber(token_cost_per_agent, 1));
  const affordable = Math.max(1, Math.floor(safeBudget / safeCost));

  let recommended = Math.min(parallelDemand, affordable, range.max, hardCap);
  const reasons: string[] = [];

  if (safeDemand > range.max) {
    reasons.push(`parallel demand capped by size profile (${task_size}) max ${range.max}`);
  }
  if (recommended < range.min) {
    reasons.push(`budget constrained recommendation below size-profile minimum (${range.min})`);
  }
  if (affordable < parallelDemand) {
    reasons.push(`budget constrained affordable agents to ${affordable}`);
  }
  return {
    recommended_threads: clamp(recommended, 1, 6),
    allowed_range: range,
    hard_cap: 6,
    affordable_threads: affordable,
    reasons
  };
}
