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
