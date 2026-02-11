import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeSemanticMerge } from '../../mcp/server/semantic-merge.js';

test('V3-202 integration: semantic merge provides ranked options and deterministic manual fallback', () => {
  const first = proposeSemanticMerge({
    base: 'function run(){\n  return "base";\n}',
    ours: 'function run(){\n  return "ours";\n}',
    theirs: 'function run(){\n  return "theirs";\n}',
    min_confidence: 0.92
  });
  const second = proposeSemanticMerge({
    base: 'function run(){\n  return "base";\n}',
    ours: 'function run(){\n  return "ours";\n}',
    theirs: 'function run(){\n  return "theirs";\n}',
    min_confidence: 0.92
  });

  assert.equal(Array.isArray(first.ranked_options), true);
  assert.equal(first.selected.strategy, second.selected.strategy);
  assert.equal(first.fallback_required, second.fallback_required);
});
