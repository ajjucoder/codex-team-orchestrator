import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntity, validateTool } from '../../mcp/server/contracts.js';

test('AT-002 integration: representative contracts validate end-to-end', () => {
  const team = validateEntity('team.schema.json', {
    team_id: 'team_demo',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  assert.equal(team.ok, true, team.errors.join('; '));

  const spawn = validateTool('team_spawn.schema.json', {
    team_id: 'team_demo',
    role: 'implementer',
    model: 'inherit'
  });
  assert.equal(spawn.ok, true, spawn.errors.join('; '));

  const send = validateTool('team_send.schema.json', {
    team_id: 'team_demo',
    from_agent_id: 'agent_lead',
    to_agent_id: 'agent_worker',
    summary: 'artifact ref only',
    artifact_refs: [{ artifact_id: 'artifact_patch', version: 1 }],
    idempotency_key: 'msg-demo-1'
  });
  assert.equal(send.ok, true, send.errors.join('; '));
});
