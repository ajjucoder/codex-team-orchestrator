import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';

const dbPath = '.tmp/v2-009-unit.sqlite';
const logPath = '.tmp/v2-009-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-009 builtin quality hook blocks task completion when configured quality gates fail', () => {
  const server = createServer({ dbPath, logPath });
  server.start();

  server.policyEngine.cache.set('quality-gated', {
    profile: 'quality-gated',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    quality: {
      require_tests_before_complete: true,
      require_compliance_ack: true,
      min_artifact_refs: 2
    }
  });

  const now = new Date().toISOString();
  server.store.createTeam({
    team_id: 'team_quality_unit',
    status: 'active',
    profile: 'quality-gated',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });

  const dispatched = server.hookEngine?.dispatch('pre', {
    event: 'task_complete',
    tool_name: 'team_task_update',
    input: {
      team_id: 'team_quality_unit',
      status: 'done',
      quality_checks_passed: false,
      compliance_ack: false,
      artifact_refs_count: 0
    },
    context: {},
    result: null
  });
  assert.ok(dispatched);
  assert.equal(dispatched?.ok, false);
  assert.equal(dispatched?.blocked_by, 'builtin_quality_task_complete_gate');
  assert.match(String(dispatched?.deny_reason ?? ''), /tests must pass/);

  server.store.close();
});
