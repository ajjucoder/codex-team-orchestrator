import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARALLEL_GATE_THRESHOLDS,
  evaluateParallelGate
} from '../../mcp/server/parallel-gate.js';

test('V3-112 unit: parallel gate rejects low-parallel prompts', () => {
  const decision = evaluateParallelGate({
    objective: 'small typo fix in one file',
    task_size: 'small',
    estimated_parallel_tasks: 1,
    recommended_threads: 1
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.reason_code, 'not_parallelizable_low_parallelism');
});

test('V3-112 unit: parallel gate rejects sequential signal overload when no strong parallel override', () => {
  const decision = evaluateParallelGate({
    objective: 'parallel rename in one file',
    task_size: 'small',
    estimated_parallel_tasks: 2,
    recommended_threads: 2
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.reason_code, 'not_parallelizable_sequential_signals');
});

test('V3-112 unit: parallel gate accepts clear parallel objective', () => {
  const decision = evaluateParallelGate({
    objective: 'parallel migration across modules and services',
    task_size: 'high',
    estimated_parallel_tasks: 4,
    recommended_threads: 4
  });
  assert.equal(decision.passed, true);
  assert.equal(decision.reason_code, 'parallelizable');
  assert.equal(decision.parallel_signal_count >= 1, true);
});

test('V3-112 unit: disabled strict gate always passes', () => {
  const decision = evaluateParallelGate(
    {
      objective: 'tiny single file rename',
      task_size: 'small',
      estimated_parallel_tasks: 1,
      recommended_threads: 1
    },
    {
      ...DEFAULT_PARALLEL_GATE_THRESHOLDS,
      strict_parallel_gate: false
    }
  );
  assert.equal(decision.passed, true);
  assert.equal(decision.reason_code, 'parallelizable_policy_disabled');
});
