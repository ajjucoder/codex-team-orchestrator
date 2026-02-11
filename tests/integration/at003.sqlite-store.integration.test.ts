import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/at003-int.sqlite';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test('AT-003 integration: message idempotency and inbox delivery', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_int',
    status: 'active',
    profile: 'default',
    objective: 'integration',
    max_threads: 3,
    created_at: now,
    updated_at: now
  });

  store.createAgent({
    agent_id: 'agent_sender',
    team_id: 'team_int',
    role: 'lead',
    status: 'idle',
    created_at: now
  });

  store.createAgent({
    agent_id: 'agent_receiver',
    team_id: 'team_int',
    role: 'worker',
    status: 'idle',
    created_at: now
  });

  const first = store.appendMessage({
    message_id: 'msg_one',
    team_id: 'team_int',
    from_agent_id: 'agent_sender',
    to_agent_id: 'agent_receiver',
    delivery_mode: 'direct',
    idempotency_key: 'k-1',
    payload: { summary: 'hello', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_receiver']
  });
  assert.equal(first.inserted, true);

  const second = store.appendMessage({
    message_id: 'msg_two',
    team_id: 'team_int',
    from_agent_id: 'agent_sender',
    to_agent_id: 'agent_receiver',
    delivery_mode: 'direct',
    idempotency_key: 'k-1',
    payload: { summary: 'dup', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_receiver']
  });
  assert.equal(second.inserted, false);
  assert.equal(second.message.message_id, 'msg_one');

  const inbox = store.pullInbox('team_int', 'agent_receiver', 10);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].payload.summary, 'hello');

  const acked = store.ackInbox([inbox[0].inbox_id]);
  assert.equal(acked, 1);

  const inboxAfterAck = store.pullInbox('team_int', 'agent_receiver', 10);
  assert.equal(inboxAfterAck.length, 0);

  store.close();
});

test('AT-003 integration: idempotency key is scoped by route', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_route',
    status: 'active',
    profile: 'default',
    objective: 'route idempotency',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });

  for (const agent_id of ['agent_sender_a', 'agent_sender_b', 'agent_receiver_a', 'agent_receiver_b']) {
    store.createAgent({
      agent_id,
      team_id: 'team_route',
      role: 'worker',
      status: 'idle',
      created_at: now
    });
  }

  const a = store.appendMessage({
    message_id: 'msg_route_a',
    team_id: 'team_route',
    from_agent_id: 'agent_sender_a',
    to_agent_id: 'agent_receiver_a',
    delivery_mode: 'direct',
    idempotency_key: 'same-key',
    payload: { summary: 'a', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_receiver_a']
  });
  const b = store.appendMessage({
    message_id: 'msg_route_b',
    team_id: 'team_route',
    from_agent_id: 'agent_sender_a',
    to_agent_id: 'agent_receiver_b',
    delivery_mode: 'direct',
    idempotency_key: 'same-key',
    payload: { summary: 'b', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_receiver_b']
  });
  const c = store.appendMessage({
    message_id: 'msg_route_c',
    team_id: 'team_route',
    from_agent_id: 'agent_sender_b',
    to_agent_id: 'agent_receiver_b',
    delivery_mode: 'direct',
    idempotency_key: 'same-key',
    payload: { summary: 'c', artifact_refs: [] },
    created_at: now,
    recipient_agent_ids: ['agent_receiver_b']
  });

  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true);
  assert.equal(c.inserted, true);
  assert.notEqual(a.message.message_id, b.message.message_id);
  assert.notEqual(b.message.message_id, c.message.message_id);
  assert.equal(a.message.idempotency_key, 'same-key');
  assert.equal(b.message.idempotency_key, 'same-key');

  store.close();
});
