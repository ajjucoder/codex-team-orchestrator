import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeSemanticMerge } from '../../mcp/server/semantic-merge.js';

test('V3-202 unit: semantic merge ranks explainable strategies and selects high-confidence option', () => {
  const result = proposeSemanticMerge({
    base: 'const a = 1;\nconst b = 2;',
    ours: 'const a = 1;\nconst b = 2;\nconst c = 3;',
    theirs: 'const a = 1;\nconst b = 2;\nconst d = 4;',
    min_confidence: 0.6
  });

  assert.equal(result.ranked_options.length >= 3, true);
  assert.equal(result.selected.strategy !== 'manual', true);
  assert.equal(typeof result.selected.rationale, 'string');
});

test('V3-202 unit: semantic merge falls back to manual when confidence is below threshold', () => {
  const result = proposeSemanticMerge({
    base: 'alpha beta gamma',
    ours: 'unrelated local rewrite',
    theirs: 'totally different incoming rewrite',
    min_confidence: 0.95
  });

  assert.equal(result.fallback_required, true);
  assert.equal(result.selected.strategy, 'manual');
});
