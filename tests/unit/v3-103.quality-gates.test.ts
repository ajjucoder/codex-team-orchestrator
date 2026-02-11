import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';

const dbPath = '.tmp/v3-103-unit.sqlite';
const logPath = '.tmp/v3-103-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V3-103 unit: quality gates are selected by explicit risk tier', () => {
  const server = createServer({ dbPath, logPath });
  server.start();

  server.policyEngine.cache.set('quality-tiered', {
    profile: 'quality-tiered',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    quality: {
      default_risk_tier: 'P2',
      by_risk_tier: {
        P0: {
          require_tests_before_complete: true,
          require_compliance_ack: true,
          min_artifact_refs: 2
        },
        P1: {
          require_tests_before_complete: true,
          require_compliance_ack: false,
          min_artifact_refs: 1
        },
        P2: {
          require_tests_before_complete: false,
          require_compliance_ack: false,
          min_artifact_refs: 0
        }
      }
    }
  });

  const now = new Date().toISOString();
  server.store.createTeam({
    team_id: 'team_v3_103_unit_explicit',
    status: 'active',
    profile: 'quality-tiered',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });

  const blocked = server.hookEngine?.dispatch('pre', {
    event: 'task_complete',
    tool_name: 'team_task_update',
    input: {
      team_id: 'team_v3_103_unit_explicit',
      status: 'done',
      risk_tier: 'P0',
      quality_checks_passed: true,
      compliance_ack: false,
      artifact_refs_count: 2
    },
    context: {},
    result: null
  });
  assert.ok(blocked);
  assert.equal(blocked?.ok, false);
  assert.equal(blocked?.blocked_by, 'builtin_quality_task_complete_gate');
  assert.match(String(blocked?.deny_reason ?? ''), /^quality_gate_failed tier=P0 failed=compliance_missing detail=/);

  const trace = blocked?.traces[0];
  assert.equal(trace?.metadata?.risk_tier, 'P0');
  assert.deepEqual(trace?.metadata?.failure_codes, ['compliance_missing']);

  server.store.close();
});

test('V3-103 unit: risk tier is inferred from task title when input risk_tier is absent', () => {
  const server = createServer({ dbPath, logPath });
  server.start();

  server.policyEngine.cache.set('quality-tiered', {
    profile: 'quality-tiered',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    quality: {
      default_risk_tier: 'P2',
      by_risk_tier: {
        P0: {
          require_tests_before_complete: true,
          require_compliance_ack: true,
          min_artifact_refs: 2
        },
        P1: {
          require_tests_before_complete: true,
          require_compliance_ack: false,
          min_artifact_refs: 1
        },
        P2: {
          require_tests_before_complete: false,
          require_compliance_ack: false,
          min_artifact_refs: 0
        }
      }
    }
  });

  const now = new Date().toISOString();
  server.store.createTeam({
    team_id: 'team_v3_103_unit_infer',
    status: 'active',
    profile: 'quality-tiered',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });
  server.store.createTask({
    task_id: 'task_v3_103_unit_infer',
    team_id: 'team_v3_103_unit_infer',
    title: 'CTO-P1-777 quality inference task',
    description: '',
    status: 'in_progress',
    priority: 1,
    claimed_by: null,
    lock_version: 1,
    created_at: now,
    updated_at: now
  });

  const blocked = server.hookEngine?.dispatch('pre', {
    event: 'task_complete',
    tool_name: 'team_task_update',
    input: {
      team_id: 'team_v3_103_unit_infer',
      task_id: 'task_v3_103_unit_infer',
      status: 'done',
      quality_checks_passed: false,
      artifact_refs_count: 0
    },
    context: {},
    result: null
  });
  assert.ok(blocked);
  assert.equal(blocked?.ok, false);
  assert.match(String(blocked?.deny_reason ?? ''), /^quality_gate_failed tier=P1 failed=tests_missing,artifact_refs_low detail=/);

  const trace = blocked?.traces[0];
  assert.equal(trace?.metadata?.risk_tier, 'P1');
  assert.deepEqual(trace?.metadata?.failure_codes, ['tests_missing', 'artifact_refs_low']);

  server.store.close();
});
