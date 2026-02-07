function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function defaultRoleWeight(role) {
  if (role === 'lead') return 1.25;
  if (role === 'implementer') return 1.2;
  if (role === 'reviewer') return 1.1;
  if (role === 'tester') return 1.1;
  if (role === 'planner') return 0.9;
  if (role === 'researcher') return 0.85;
  return 1;
}

function fallbackCostForTaskSize(taskSize) {
  if (taskSize === 'small') return 900;
  if (taskSize === 'medium') return 1200;
  return 1500;
}

export function deriveTokenCostPerAgent({
  store,
  team_id,
  task_size,
  explicit_token_cost_per_agent = null,
  lookback_limit = 400,
  min_samples = 8
}) {
  if (Number.isFinite(explicit_token_cost_per_agent) && explicit_token_cost_per_agent > 0) {
    return {
      token_cost_per_agent: Math.round(explicit_token_cost_per_agent),
      source: 'explicit_input',
      sample_count: 0,
      avg_sample_tokens: 0
    };
  }

  const fallback = fallbackCostForTaskSize(task_size);
  const samples = store
    .listUsageSamples(team_id, lookback_limit)
    .filter((sample) => Number(sample.estimated_tokens) > 0)
    .filter((sample) => sample.role && sample.role !== 'unknown');

  if (samples.length < min_samples) {
    return {
      token_cost_per_agent: fallback,
      source: 'task_size_fallback',
      sample_count: samples.length,
      avg_sample_tokens: Math.round(average(samples.map((sample) => Number(sample.estimated_tokens) || 0)))
    };
  }

  const byRole = new Map();
  for (const sample of samples) {
    const role = sample.role;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(Number(sample.estimated_tokens) || 0);
  }

  const activeRoles = [...new Set(store.listAgentsByTeam(team_id).map((agent) => agent.role))];
  const rolesForEstimate = activeRoles.length ? activeRoles : [...byRole.keys()];

  let weightedSum = 0;
  let weightTotal = 0;
  for (const role of rolesForEstimate) {
    const roleSamples = byRole.get(role);
    if (!roleSamples || !roleSamples.length) continue;
    const weight = defaultRoleWeight(role);
    weightedSum += average(roleSamples) * weight;
    weightTotal += weight;
  }

  const meanSampleTokens = average(samples.map((sample) => Number(sample.estimated_tokens) || 0));
  const representativeCallCost = weightTotal > 0 ? weightedSum / weightTotal : meanSampleTokens;
  const token_cost_per_agent = clamp(Math.round(representativeCallCost * 2.5), 200, 6000);

  return {
    token_cost_per_agent,
    source: 'telemetry',
    sample_count: samples.length,
    avg_sample_tokens: Math.round(meanSampleTokens)
  };
}
