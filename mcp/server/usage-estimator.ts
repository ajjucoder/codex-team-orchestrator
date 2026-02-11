interface EstimateToolUsageInput {
  input?: unknown;
  result?: unknown;
  minimum?: number;
  maximum?: number;
}

interface ToolUsageEstimate {
  input_tokens: number;
  output_tokens: number;
  estimated_tokens: number;
}

export interface EstimateBudgetPressureInput {
  consumed_tokens: number;
  projected_additional_tokens?: number;
  soft_limit_tokens: number;
  hard_limit_tokens: number;
}

export interface BudgetPressureSignal {
  consumed_tokens: number;
  projected_tokens: number;
  soft_limit_tokens: number;
  hard_limit_tokens: number;
  soft_ratio: number;
  hard_ratio: number;
  pressure_level: 'low' | 'elevated' | 'high' | 'critical';
  should_compact: boolean;
  exceeds_hard_limit: boolean;
  remaining_to_soft: number;
  remaining_to_hard: number;
}

export interface WorkerBudgetPressureInput {
  worker_id?: string | null;
  consumed_tokens: number;
  projected_additional_tokens?: number;
  soft_limit_tokens?: number;
  hard_limit_tokens?: number;
}

export interface EstimateWorkerBudgetPressureInput {
  workers: WorkerBudgetPressureInput[];
  soft_limit_tokens: number;
  hard_limit_tokens: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampToInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeLimitPair(softLimit: number, hardLimit: number): { soft: number; hard: number } {
  const hard = Math.max(1, clampToInt(hardLimit, 1));
  const softCandidate = clampToInt(softLimit, hard);
  const soft = clamp(softCandidate, 1, hard);
  return { soft, hard };
}

function ratio(value: number, max: number): number {
  if (max <= 0) return 0;
  return Number((value / max).toFixed(4));
}

function countStringTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimateValueTokens(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return countStringTokens(String(value));
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateValueTokens(item), 1);
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce(
      (sum, [key, nested]) => sum + countStringTokens(key) + estimateValueTokens(nested),
      2
    );
  }
  return 1;
}

export function estimateToolUsage({
  input,
  result,
  minimum = 1,
  maximum = 200000
}: EstimateToolUsageInput = {}): ToolUsageEstimate {
  const input_tokens = estimateValueTokens(input);
  const output_tokens = estimateValueTokens(result);
  const estimated_tokens = clamp(input_tokens + output_tokens, minimum, maximum);

  return {
    input_tokens,
    output_tokens,
    estimated_tokens
  };
}

export function estimateBudgetPressure({
  consumed_tokens,
  projected_additional_tokens = 0,
  soft_limit_tokens,
  hard_limit_tokens
}: EstimateBudgetPressureInput): BudgetPressureSignal {
  const consumed = clampToInt(consumed_tokens, 0);
  const projectedDelta = clampToInt(projected_additional_tokens, 0);
  const projected = Math.max(0, consumed + projectedDelta);
  const { soft, hard } = normalizeLimitPair(soft_limit_tokens, hard_limit_tokens);
  const shouldCompact = projected >= soft;
  const exceedsHardLimit = projected >= hard;

  let pressureLevel: BudgetPressureSignal['pressure_level'] = 'low';
  if (exceedsHardLimit) {
    pressureLevel = 'critical';
  } else if (shouldCompact) {
    pressureLevel = 'high';
  } else if (projected >= Math.floor(soft * 0.75)) {
    pressureLevel = 'elevated';
  }

  return {
    consumed_tokens: consumed,
    projected_tokens: projected,
    soft_limit_tokens: soft,
    hard_limit_tokens: hard,
    soft_ratio: ratio(projected, soft),
    hard_ratio: ratio(projected, hard),
    pressure_level: pressureLevel,
    should_compact: shouldCompact,
    exceeds_hard_limit: exceedsHardLimit,
    remaining_to_soft: Math.max(0, soft - projected),
    remaining_to_hard: Math.max(0, hard - projected)
  };
}

export function estimateWorkerBudgetPressure({
  workers,
  soft_limit_tokens,
  hard_limit_tokens
}: EstimateWorkerBudgetPressureInput): Record<string, BudgetPressureSignal> {
  const byWorker: Record<string, BudgetPressureSignal> = {};
  for (const worker of workers) {
    const workerKey = typeof worker.worker_id === 'string' && worker.worker_id.trim().length > 0
      ? worker.worker_id.trim()
      : 'team';
    byWorker[workerKey] = estimateBudgetPressure({
      consumed_tokens: worker.consumed_tokens,
      projected_additional_tokens: worker.projected_additional_tokens,
      soft_limit_tokens: worker.soft_limit_tokens ?? soft_limit_tokens,
      hard_limit_tokens: worker.hard_limit_tokens ?? hard_limit_tokens
    });
  }
  return byWorker;
}
