function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function countStringTokens(value) {
  return Math.max(1, Math.ceil(String(value).length / 4));
}

function estimateValueTokens(value) {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return countStringTokens(value);
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

export function estimateToolUsage({ input, result, minimum = 1, maximum = 200000 } = {}) {
  const input_tokens = estimateValueTokens(input);
  const output_tokens = estimateValueTokens(result);
  const estimated_tokens = clamp(input_tokens + output_tokens, minimum, maximum);

  return {
    input_tokens,
    output_tokens,
    estimated_tokens
  };
}
