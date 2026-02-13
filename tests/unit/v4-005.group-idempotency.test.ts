import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v4-005-group-idempotency-unit.sqlite';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

afterEach(cleanup);

test('V4-005 unit: group route/idempotency scope is recipient-set specific and order-insensitive', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v4_005',
    status: 'active',
    profile: 'default',
    max_threads: 5,
    created_at: now,
    updated_at: now
  });

  for (const agentId of ['agent_sender', 'agent_a', 'agent_b', 'agent_c']) {
    store.createAgent({
      agent_id: agentId,
      team_id: 'team_v4_005',
      role: 'worker',
      status: 'idle',
      created_at: now
    });
  }

  const first = store.appendMessage({
    message_id: 'msg_group_1',
    team_id: 'team_v4_005',
    from_agent_id: 'agent_sender',
    to_agent_id: null,
    delivery_mode: 'group',
    idempotency_key: 'same-key',
    payload: {
      summary: 'group-ab',
      artifact_refs: []
    },
    created_at: now,
    recipient_agent_ids: ['agent_a', 'agent_b']
  });
  assert.equal(first.inserted, true);

  const sameSetDifferentOrder = store.appendMessage({
    message_id: 'msg_group_2',
    team_id: 'team_v4_005',
    from_agent_id: 'agent_sender',
    to_agent_id: null,
    delivery_mode: 'group',
    idempotency_key: 'same-key',
    payload: {
      summary: 'group-ab-duplicate',
      artifact_refs: []
    },
    created_at: now,
    recipient_agent_ids: ['agent_b', 'agent_a']
  });
  assert.equal(sameSetDifferentOrder.inserted, false);
  assert.equal(sameSetDifferentOrder.message.message_id, 'msg_group_1');

  const differentSet = store.appendMessage({
    message_id: 'msg_group_3',
    team_id: 'team_v4_005',
    from_agent_id: 'agent_sender',
    to_agent_id: null,
    delivery_mode: 'group',
    idempotency_key: 'same-key',
    payload: {
      summary: 'group-ac',
      artifact_refs: []
    },
    created_at: now,
    recipient_agent_ids: ['agent_a', 'agent_c']
  });
  assert.equal(differentSet.inserted, true);
  assert.notEqual(differentSet.message.message_id, first.message.message_id);

  const abRoute = store.getLatestRouteMessage({
    team_id: 'team_v4_005',
    from_agent_id: 'agent_sender',
    delivery_mode: 'group',
    recipient_agent_ids: ['agent_b', 'agent_a']
  });
  assert.equal(abRoute?.message_id, 'msg_group_1');

  const acRoute = store.getLatestRouteMessage({
    team_id: 'team_v4_005',
    from_agent_id: 'agent_sender',
    delivery_mode: 'group',
    recipient_agent_ids: ['agent_a', 'agent_c']
  });
  assert.equal(acRoute?.message_id, 'msg_group_3');

  store.close();
});

test('V4-005 unit: direct and broadcast idempotency behavior remains unchanged', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v4_005_modes',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });

  for (const agentId of ['agent_sender', 'agent_x', 'agent_y']) {
    store.createAgent({
      agent_id: agentId,
      team_id: 'team_v4_005_modes',
      role: 'worker',
      status: 'idle',
      created_at: now
    });
  }

  const direct = store.appendMessage({
    message_id: 'msg_direct_1',
    team_id: 'team_v4_005_modes',
    from_agent_id: 'agent_sender',
    to_agent_id: 'agent_x',
    delivery_mode: 'direct',
    idempotency_key: 'shared-key',
    payload: { summary: 'direct', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_x']
  });
  const broadcast = store.appendMessage({
    message_id: 'msg_broadcast_1',
    team_id: 'team_v4_005_modes',
    from_agent_id: 'agent_sender',
    to_agent_id: null,
    delivery_mode: 'broadcast',
    idempotency_key: 'shared-key',
    payload: { summary: 'broadcast', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_x', 'agent_y']
  });
  const broadcastDuplicate = store.appendMessage({
    message_id: 'msg_broadcast_2',
    team_id: 'team_v4_005_modes',
    from_agent_id: 'agent_sender',
    to_agent_id: null,
    delivery_mode: 'broadcast',
    idempotency_key: 'shared-key',
    payload: { summary: 'broadcast duplicate', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_x', 'agent_y']
  });

  assert.equal(direct.inserted, true);
  assert.equal(broadcast.inserted, true);
  assert.equal(broadcastDuplicate.inserted, false);
  assert.equal(broadcastDuplicate.message.message_id, 'msg_broadcast_1');

  store.close();
});
