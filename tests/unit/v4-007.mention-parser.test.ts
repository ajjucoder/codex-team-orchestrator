import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMentionRecipients } from '../../mcp/server/mention-parser.js';
import type { AgentRecord } from '../../mcp/store/entities.js';

function makeAgent(agentId: string, role: string): AgentRecord {
  const ts = new Date().toISOString();
  return {
    agent_id: agentId,
    team_id: 'team_v4_007',
    role,
    status: 'idle',
    model: null,
    last_heartbeat_at: null,
    created_at: ts,
    updated_at: ts,
    metadata: {}
  };
}

test('V4-007 unit: mention parser resolves @agent/@role/@all with deterministic dedupe', () => {
  const agents = [
    makeAgent('agent_lead', 'lead'),
    makeAgent('agent_implementer', 'implementer'),
    makeAgent('agent_reviewer', 'reviewer'),
    makeAgent('agent_tester', 'tester')
  ];

  const resolved = resolveMentionRecipients({
    summary: 'please review @role:reviewer and @agent:agent_tester then @all',
    mentions: ['agent:agent_implementer', '@role:tester', '@agent:agent_reviewer'],
    explicit_recipient_agent_ids: ['agent_tester'],
    agents,
    sender_agent_id: 'agent_lead'
  });

  assert.deepEqual(
    resolved.recipient_agent_ids,
    ['agent_implementer', 'agent_reviewer', 'agent_tester']
  );
  assert.equal(resolved.unresolved_mentions.length, 0);
});

test('V4-007 unit: mention parser returns unresolved mentions for unknown role/agent references', () => {
  const agents = [
    makeAgent('agent_lead', 'lead'),
    makeAgent('agent_reviewer', 'reviewer')
  ];

  const resolved = resolveMentionRecipients({
    summary: '@role:unknown @agent:agent_missing',
    mentions: ['@role:ghost'],
    explicit_recipient_agent_ids: ['agent_missing_2'],
    agents,
    sender_agent_id: 'agent_lead'
  });

  assert.deepEqual(resolved.recipient_agent_ids, []);
  assert.deepEqual(resolved.unresolved_mentions, [
    '@agent:agent_missing',
    '@agent:agent_missing_2',
    '@role:ghost',
    '@role:unknown'
  ]);
});

test('V4-007 unit: recipient order is deterministic regardless of mention order', () => {
  const agents = [
    makeAgent('agent_lead', 'lead'),
    makeAgent('agent_reviewer', 'reviewer'),
    makeAgent('agent_tester', 'tester')
  ];

  const first = resolveMentionRecipients({
    summary: '@agent:agent_tester @role:reviewer',
    agents,
    sender_agent_id: 'agent_lead'
  });
  const second = resolveMentionRecipients({
    summary: '@role:reviewer @agent:agent_tester',
    agents,
    sender_agent_id: 'agent_lead'
  });

  assert.deepEqual(first.recipient_agent_ids, ['agent_reviewer', 'agent_tester']);
  assert.deepEqual(second.recipient_agent_ids, ['agent_reviewer', 'agent_tester']);
});
