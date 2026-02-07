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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
