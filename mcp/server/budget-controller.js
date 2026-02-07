function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
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

function normalizeTelemetrySamples(samples = []) {
  return samples
    .filter((sample) => Number(sample.estimated_tokens) > 0)
    .filter((sample) => sample.role && sample.role !== 'unknown');
}

function chooseTelemetrySamples({ store, team_id, lookback_limit, min_samples }) {
  const teamSamples = normalizeTelemetrySamples(store.listUsageSamples(team_id, lookback_limit));
  if (teamSamples.length >= min_samples) {
    return { samples: teamSamples, source: 'telemetry' };
  }

  const globalSamples = normalizeTelemetrySamples(store.listUsageSamplesGlobal(lookback_limit * 3));
  if (globalSamples.length >= min_samples) {
    return { samples: globalSamples, source: 'global_telemetry' };
  }

  return { samples: teamSamples, source: 'task_size_fallback' };
}

function deriveCallMultiplier(samples) {
  const callsByAgent = new Map();
  for (const sample of samples) {
    if (!sample.agent_id) continue;
    callsByAgent.set(sample.agent_id, (callsByAgent.get(sample.agent_id) ?? 0) + 1);
  }

  if (callsByAgent.size === 0) {
    return 2.5;
  }

  const callsPerAgent = [...callsByAgent.values()];
  return clamp(percentile(callsPerAgent, 0.6), 1.5, 6);
}

export function deriveTokenCostPerAgent({
  store,
  team_id,
  task_size,
  explicit_token_cost_per_agent = null,
  planned_roles = [],
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
  const telemetry = chooseTelemetrySamples({
    store,
    team_id,
    lookback_limit,
    min_samples
  });
  const samples = telemetry.samples;

  if (samples.length < min_samples) {
    return {
      token_cost_per_agent: fallback,
      source: 'task_size_fallback',
      sample_count: samples.length,
      avg_sample_tokens: Math.round(average(samples.map((sample) => Number(sample.estimated_tokens) || 0))),
      call_multiplier: 0
    };
  }

  const byRole = new Map();
  for (const sample of samples) {
    const role = sample.role;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(Number(sample.estimated_tokens) || 0);
  }

  const activeRoles = [...new Set(store.listAgentsByTeam(team_id).map((agent) => agent.role))];
  const requestedRoles = [...new Set((planned_roles ?? []).filter(Boolean))];
  const rolesForEstimate = requestedRoles.length
    ? requestedRoles
    : (activeRoles.length ? activeRoles : [...byRole.keys()]);
  const meanSampleTokens = average(samples.map((sample) => Number(sample.estimated_tokens) || 0));

  let weightedSum = 0;
  let weightTotal = 0;
  for (const role of rolesForEstimate) {
    const roleSamples = byRole.get(role) ?? [];
    const weight = defaultRoleWeight(role);
    const roleCost = roleSamples.length
      ? percentile(roleSamples, 0.6)
      : meanSampleTokens;
    weightedSum += roleCost * weight;
    weightTotal += weight;
  }

  const representativeCallCost = weightTotal > 0 ? weightedSum / weightTotal : meanSampleTokens;
  const callMultiplier = deriveCallMultiplier(samples);
  const token_cost_per_agent = clamp(Math.round(representativeCallCost * callMultiplier), 200, 6000);

  return {
    token_cost_per_agent,
    source: telemetry.source,
    sample_count: samples.length,
    avg_sample_tokens: Math.round(meanSampleTokens),
    call_multiplier: Number(callMultiplier.toFixed(2))
  };
}
