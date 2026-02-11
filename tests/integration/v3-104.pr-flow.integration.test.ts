import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const manifestPath = '.tmp/v3-104-pr-manifest.json';

afterEach(() => {
  rmSync(manifestPath, { force: true });
});

test('V3-104 integration: pr orchestrator enforces metadata contract and deterministic queue order', () => {
  const manifest = [
    {
      ticket_id: 'CTO-P2-006',
      pushed_branch: 'team/run/impl-4',
      commit_sha: 'abc1234',
      risk_tier: 'P2',
      test_evidence: 'tests/chaos/v3-206.chaos-harness.test.ts',
      commit_message: 'CTO-P2-006: add chaos harness'
    },
    {
      ticket_id: 'CTO-P1-004',
      pushed_branch: 'team/run/impl-2',
      commit_sha: 'abc9999',
      risk_tier: 'P1',
      test_evidence: 'tests/integration/v3-104.pr-flow.integration.test.ts',
      commit_message: 'CTO-P1-004: add orchestration queue'
    },
    {
      ticket_id: 'CTO-P0-009',
      pushed_branch: 'team/run/impl-1',
      commit_sha: 'abc7777',
      risk_tier: 'P0',
      test_evidence: 'tests/integration/v3-009.recovery.integration.test.ts',
      commit_message: 'CTO-P0-009: recovery hardening'
    }
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const output = execFileSync('bash', [
    './scripts/pr-orchestrator.sh',
    '--manifest',
    manifestPath,
    '--dry-run'
  ], { encoding: 'utf8' });

  assert.match(output, /pr-orchestrator:queue_size=3/);
  assert.match(output, /pr-orchestrator:queue_order=CTO-P0-009,CTO-P1-004,CTO-P2-006/);
  assert.match(output, /risk=P0/);
  assert.match(output, /risk=P1/);
  assert.match(output, /risk=P2/);
  assert.match(output, /pr-orchestrator:ok/);
});
