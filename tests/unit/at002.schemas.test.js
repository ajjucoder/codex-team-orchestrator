import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entitySchemas, toolSchemas, validateEntity, validateTool } from '../../mcp/server/contracts.js';

test('AT-002 entity schemas are discoverable', () => {
  for (const required of ['team.schema.json', 'agent.schema.json', 'message.schema.json', 'task.schema.json', 'artifact.schema.json']) {
    assert.ok(entitySchemas[required], `missing ${required}`);
  }
});

test('AT-002 team schema enforces max_threads <= 6', () => {
  const valid = validateEntity('team.schema.json', {
    team_id: 'team_alpha',
    status: 'active',
    profile: 'default',
    max_threads: 6,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  assert.equal(valid.ok, true, valid.errors.join('; '));

  const invalid = validateEntity('team.schema.json', {
    team_id: 'team_alpha',
    status: 'active',
    profile: 'default',
    max_threads: 7,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /maximum 6/);
});

test('AT-002 tool schema validation catches required fields', () => {
  const invalid = validateTool('team_start.schema.json', { profile: 'default' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /objective/);

  const valid = validateTool('team_start.schema.json', {
    objective: 'Implement AT-002',
    profile: 'default',
    max_threads: 4,
    session_model: 'gpt-5'
  });
  assert.equal(valid.ok, true, valid.errors.join('; '));
});

test('AT-002 message schema enforces direct messages include destination', () => {
  const invalid = validateEntity('message.schema.json', {
    message_id: 'msg_1',
    team_id: 'team_alpha',
    from_agent_id: 'agent_a',
    delivery_mode: 'direct',
    idempotency_key: 'k1',
    payload: { summary: 'hi', artifact_refs: [] },
    created_at: new Date().toISOString()
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /required by conditional/);
});

test('AT-002 tool schema inventory exists', () => {
  for (const required of ['team_start.schema.json', 'team_spawn.schema.json', 'team_send.schema.json', 'team_broadcast.schema.json']) {
    assert.ok(toolSchemas[required], `missing ${required}`);
  }
});
