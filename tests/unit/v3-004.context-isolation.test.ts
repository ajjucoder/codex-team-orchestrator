import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeContextManager,
  toContextStreamId,
  toRuntimeContextKey
} from '../../mcp/runtime/context.js';
import { estimateWorkerBudgetPressure } from '../../mcp/server/usage-estimator.js';

test('V3-004 unit: runtime context manager isolates worker budgets/checkpoints by stream key', () => {
  const manager = new RuntimeContextManager({
    default_soft_limit_tokens: 100,
    default_hard_limit_tokens: 150
  });

  const workerAFirst = manager.recordUsage({
    team_id: 'team_v3_004',
    worker_id: 'worker_a',
    estimated_tokens: 90
  });
  const workerBFirst = manager.recordUsage({
    team_id: 'team_v3_004',
    worker_id: 'worker_b',
    estimated_tokens: 20
  });
  assert.equal(workerAFirst.pressure.should_compact, false);
  assert.equal(workerBFirst.pressure.should_compact, false);

  const workerASecond = manager.recordUsage({
    team_id: 'team_v3_004',
    worker_id: 'worker_a',
    estimated_tokens: 20
  });
  assert.equal(workerASecond.pressure.should_compact, true);
  assert.equal(workerASecond.pressure.exceeds_hard_limit, false);

  manager.registerCheckpoint({
    team_id: 'team_v3_004',
    worker_id: 'worker_a',
    checkpoint: {
      artifact_id: 'artifact_checkpoint_context_worker_worker_a',
      version: 1,
      checksum: 'sha256:a',
      created_at: '2026-02-11T13:47:33.000Z'
    }
  });
  manager.registerCheckpoint({
    team_id: 'team_v3_004',
    worker_id: 'worker_b',
    checkpoint: {
      artifact_id: 'artifact_checkpoint_context_worker_worker_b',
      version: 1,
      checksum: 'sha256:b',
      created_at: '2026-02-11T13:47:33.000Z'
    }
  });

  const workerASnapshot = manager.getSnapshot({
    team_id: 'team_v3_004',
    worker_id: 'worker_a'
  });
  const workerBSnapshot = manager.getSnapshot({
    team_id: 'team_v3_004',
    worker_id: 'worker_b'
  });
  assert.equal(workerASnapshot.checkpoint?.artifact_id, 'artifact_checkpoint_context_worker_worker_a');
  assert.equal(workerBSnapshot.checkpoint?.artifact_id, 'artifact_checkpoint_context_worker_worker_b');
  assert.equal(workerASnapshot.checkpoint?.artifact_id === workerBSnapshot.checkpoint?.artifact_id, false);

  const compacted = manager.markCompacted({
    team_id: 'team_v3_004',
    worker_id: 'worker_a',
    consumed_tokens_after: 40,
    compacted_at: '2026-02-11T13:47:34.000Z'
  });
  const compactedRepeat = manager.getSnapshot({
    team_id: 'team_v3_004',
    worker_id: 'worker_a'
  });
  assert.deepEqual(compacted.pressure, compactedRepeat.pressure);
  assert.equal(compacted.budget.consumed_tokens, 40);
  assert.equal(workerBSnapshot.budget.consumed_tokens, 20);
  assert.equal(toContextStreamId('worker_a'), 'worker:worker_a');
  assert.equal(toRuntimeContextKey('team_v3_004', 'worker_a'), 'team_v3_004::worker:worker_a');
});

test('V3-004 unit: worker budget pressure helper is deterministic and pre-hard-limit', () => {
  const input = {
    soft_limit_tokens: 100,
    hard_limit_tokens: 150,
    workers: [
      {
        worker_id: 'worker_a',
        consumed_tokens: 100,
        projected_additional_tokens: 10
      },
      {
        worker_id: 'worker_b',
        consumed_tokens: 20,
        projected_additional_tokens: 5
      }
    ]
  };

  const first = estimateWorkerBudgetPressure(input);
  const second = estimateWorkerBudgetPressure(input);
  assert.deepEqual(first, second);
  assert.equal(first.worker_a.should_compact, true);
  assert.equal(first.worker_a.exceeds_hard_limit, false);
  assert.equal(first.worker_b.should_compact, false);
});

test('V3-004 unit: hydrateStream restores persisted counters and checkpoint state', () => {
  const manager = new RuntimeContextManager({
    default_soft_limit_tokens: 100,
    default_hard_limit_tokens: 150
  });

  const hydrated = manager.hydrateStream({
    team_id: 'team_v3_004',
    worker_id: 'worker_a',
    stream_metadata: {
      budget: {
        consumed_tokens: 44,
        soft_limit_tokens: 100,
        hard_limit_tokens: 150,
        compact_count: 3,
        reset_count: 2,
        last_compacted_at: '2026-02-11T14:00:00.000Z',
        last_reset_at: '2026-02-11T14:01:00.000Z'
      },
      context_checkpoint: {
        artifact_id: 'artifact_checkpoint_context_worker_worker_a',
        version: 7,
        checksum: 'sha256:hydrated',
        created_at: '2026-02-11T14:00:00.000Z'
      }
    }
  });
  assert.equal(hydrated.budget.compact_count, 3);
  assert.equal(hydrated.budget.reset_count, 2);
  assert.equal(hydrated.checkpoint?.version, 7);

  const compacted = manager.markCompacted({
    team_id: 'team_v3_004',
    worker_id: 'worker_a',
    consumed_tokens_after: 30
  });
  const reset = manager.markReset({
    team_id: 'team_v3_004',
    worker_id: 'worker_a'
  });
  assert.equal(compacted.budget.compact_count, 4);
  assert.equal(reset.budget.reset_count, 3);
});
