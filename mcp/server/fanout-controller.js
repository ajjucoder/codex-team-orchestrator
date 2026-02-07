function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rangeForSize(policy, taskSize) {
  const fanout = policy?.fanout ?? {};
  if (taskSize === 'small') {
    return {
      min: clamp(Number(fanout.small_min ?? 1), 1, 2),
      max: clamp(Number(fanout.small_max ?? 2), 1, 2)
    };
  }
  if (taskSize === 'medium') {
    return {
      min: clamp(Number(fanout.medium_min ?? 3), 3, 4),
      max: clamp(Number(fanout.medium_max ?? 4), 3, 4)
    };
  }
  return {
    min: clamp(Number(fanout.high_min ?? 5), 5, 6),
    max: clamp(Number(fanout.high_max ?? 6), 5, 6)
  };
}

export function recommendFanout({
  policy,
  task_size,
  estimated_parallel_tasks,
  budget_tokens_remaining,
  token_cost_per_agent,
  team_max_threads
}) {
  const base = rangeForSize(policy, task_size);
  const hardCap = Math.min(Number(team_max_threads ?? 6), 6);
  const range = {
    min: clamp(base.min, 1, hardCap),
    max: clamp(base.max, 1, hardCap)
  };

  const parallelDemand = clamp(estimated_parallel_tasks, range.min, range.max);
  const affordable = Math.max(1, Math.floor(budget_tokens_remaining / token_cost_per_agent));

  let recommended = Math.min(parallelDemand, affordable, range.max, hardCap);
  const reasons = [];

  if (estimated_parallel_tasks > range.max) {
    reasons.push(`parallel demand capped by size profile (${task_size}) max ${range.max}`);
  }
  if (recommended < range.min) {
    recommended = range.min;
    reasons.push('budget pressure forced floor to range minimum');
  }
  if (affordable < parallelDemand) {
    reasons.push(`budget constrained affordable agents to ${affordable}`);
  }
  if (recommended > 6) {
    recommended = 6;
  }

  return {
    recommended_threads: clamp(recommended, 1, 6),
    allowed_range: range,
    hard_cap: 6,
    affordable_threads: affordable,
    reasons
  };
}
