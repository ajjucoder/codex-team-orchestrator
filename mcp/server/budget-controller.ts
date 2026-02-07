function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function defaultRoleWeight(role: string): number {
  if (role === 'lead') return 1.25;
  if (role === 'implementer') return 1.2;
  if (role === 'reviewer') return 1.1;
  if (role === 'tester') return 1.1;
  if (role === 'planner') return 0.9;
  if (role === 'researcher') return 0.85;
  return 1;
}

type TaskSize = 'small' | 'medium' | 'high';

function fallbackCostForTaskSize(taskSize: TaskSize): number {
  if (taskSize === 'small') return 900;
  if (taskSize === 'medium') return 1200;
  return 1500;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

interface UsageSampleLike {
  role: string;
  agent_id: string | null;
  estimated_tokens: number;
}

function normalizeTelemetrySamples(samples: unknown[] = []): UsageSampleLike[] {
  return samples
    .map((sample) => {
      const record = (sample && typeof sample === 'object')
        ? sample as Record<string, unknown>
        : {};
      const estimatedTokens = finiteNumber(record.estimated_tokens, 0);
      const role = typeof record.role === 'string' ? record.role : '';
      const agentId = typeof record.agent_id === 'string' ? record.agent_id : null;
      return {
        role,
        agent_id: agentId,
        estimated_tokens: estimatedTokens
      };
    })
    .filter((sample) => sample.estimated_tokens > 0)
    .filter((sample) => sample.role.length > 0 && sample.role !== 'unknown');
}

interface AgentLike {
  role: string;
}

interface BudgetStoreLike {
  listUsageSamples(teamId: string, limit: number): unknown[];
  listUsageSamplesGlobal(limit: number): unknown[];
  listAgentsByTeam(teamId: string): AgentLike[];
}

interface TelemetryChoice {
  samples: UsageSampleLike[];
  source: 'telemetry' | 'global_telemetry' | 'task_size_fallback';
}

interface ChooseTelemetryInput {
  store: BudgetStoreLike;
  team_id: string;
  lookback_limit: number;
  min_samples: number;
}

function chooseTelemetrySamples({
  store,
  team_id,
  lookback_limit,
  min_samples
}: ChooseTelemetryInput): TelemetryChoice {
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

function deriveCallMultiplier(samples: UsageSampleLike[]): number {
  const callsByAgent = new Map<string, number>();
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

interface DeriveTokenCostInput {
  store: BudgetStoreLike;
  team_id: string;
  task_size: TaskSize;
  explicit_token_cost_per_agent?: number | null;
  planned_roles?: string[];
  lookback_limit?: number;
  min_samples?: number;
}

interface TokenCostEstimate {
  token_cost_per_agent: number;
  source: 'explicit_input' | 'telemetry' | 'global_telemetry' | 'task_size_fallback';
  sample_count: number;
  avg_sample_tokens: number;
  call_multiplier?: number;
}

export function deriveTokenCostPerAgent({
  store,
  team_id,
  task_size,
  explicit_token_cost_per_agent = null,
  planned_roles = [],
  lookback_limit = 400,
  min_samples = 8
}: DeriveTokenCostInput): TokenCostEstimate {
  const explicitCost = finiteNumber(explicit_token_cost_per_agent, 0);
  if (explicitCost > 0) {
    return {
      token_cost_per_agent: Math.round(explicitCost),
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
      avg_sample_tokens: Math.round(average(samples.map((sample) => sample.estimated_tokens))),
      call_multiplier: 0
    };
  }

  const byRole = new Map<string, number[]>();
  for (const sample of samples) {
    const role = sample.role;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role)?.push(sample.estimated_tokens);
  }

  const activeRoles = [...new Set(
    store
      .listAgentsByTeam(team_id)
      .map((agent) => String(agent.role ?? ''))
      .filter(Boolean)
  )];
  const requestedRoles = [...new Set((planned_roles ?? []).map((role) => String(role)).filter(Boolean))];
  const rolesForEstimate = requestedRoles.length > 0
    ? requestedRoles
    : (activeRoles.length > 0 ? activeRoles : [...byRole.keys()]);
  const meanSampleTokens = average(samples.map((sample) => sample.estimated_tokens));

  let weightedSum = 0;
  let weightTotal = 0;
  for (const role of rolesForEstimate) {
    const roleSamples = byRole.get(role) ?? [];
    const weight = defaultRoleWeight(role);
    const roleCost = roleSamples.length > 0
      ? percentile(roleSamples, 0.6)
      : meanSampleTokens;
    weightedSum += roleCost * weight;
    weightTotal += weight;
  }

  const representativeCallCost = weightTotal > 0 ? weightedSum / weightTotal : meanSampleTokens;
  const callMultiplier = deriveCallMultiplier(samples);
  const tokenCostPerAgent = clamp(Math.round(representativeCallCost * callMultiplier), 200, 6000);

  return {
    token_cost_per_agent: tokenCostPerAgent,
    source: telemetry.source,
    sample_count: samples.length,
    avg_sample_tokens: Math.round(meanSampleTokens),
    call_multiplier: Number(callMultiplier.toFixed(2))
  };
}
