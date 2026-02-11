import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v3-007-unit.sqlite';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

function createStoreFixture(): SqliteStore {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v3_007_unit',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });

  store.createAgent({
    agent_id: 'agent_sender',
    team_id: 'team_v3_007_unit',
    role: 'lead',
    status: 'idle',
    created_at: now,
    updated_at: now
  });

  store.createAgent({
    agent_id: 'agent_receiver',
    team_id: 'team_v3_007_unit',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });

  return store;
}

function appendDirectMessage(store: SqliteStore, messageId: string, idempotencyKey: string): void {
  const now = new Date().toISOString();
  const result = store.appendMessage({
    message_id: messageId,
    team_id: 'team_v3_007_unit',
    from_agent_id: 'agent_sender',
    to_agent_id: 'agent_receiver',
    delivery_mode: 'direct',
    payload: {
      summary: `summary-${messageId}`,
      artifact_refs: []
    },
    idempotency_key: idempotencyKey,
    created_at: now,
    recipient_agent_ids: ['agent_receiver']
  });

  assert.equal(result.inserted, true);
}

test('V3-007 unit: ackInbox supports explicit and partial acknowledgment sets', () => {
  const store = createStoreFixture();

  appendDirectMessage(store, 'msg_ack_1', 'idemp_ack_1');
  appendDirectMessage(store, 'msg_ack_2', 'idemp_ack_2');
  appendDirectMessage(store, 'msg_ack_3', 'idemp_ack_3');

  const pulled = store.pullInbox('team_v3_007_unit', 'agent_receiver', 10);
  assert.equal(pulled.length, 3);

  const selective = store.ackInbox({
    team_id: 'team_v3_007_unit',
    agent_id: 'agent_receiver',
    inbox_ids: [pulled[0].inbox_id, pulled[0].inbox_id],
    message_ids: [pulled[1].message_id],
    ack_at: '2026-02-11T10:00:00.000Z'
  });
  assert.equal(selective.acked, 2);
  assert.deepEqual(selective.acked_inbox_ids, [pulled[0].inbox_id, pulled[1].inbox_id]);
  assert.deepEqual(selective.acked_message_ids, [pulled[0].message_id, pulled[1].message_id]);

  const allRemaining = store.ackInbox({
    team_id: 'team_v3_007_unit',
    agent_id: 'agent_receiver',
    ack_all: true,
    ack_at: '2026-02-11T10:01:00.000Z'
  });
  assert.equal(allRemaining.acked, 1);
  assert.deepEqual(allRemaining.acked_message_ids, [pulled[2].message_id]);

  const idempotent = store.ackInbox({
    team_id: 'team_v3_007_unit',
    agent_id: 'agent_receiver',
    ack_all: true
  });
  assert.equal(idempotent.acked, 0);

  const emptyInbox = store.pullInbox('team_v3_007_unit', 'agent_receiver', 10);
  assert.equal(emptyInbox.length, 0);

  store.close();
});

test('V3-007 unit: failInbox retries with backoff then dead-letters on max attempts', () => {
  const store = createStoreFixture();

  appendDirectMessage(store, 'msg_fail_1', 'idemp_fail_1');

  const firstPull = store.pullInbox('team_v3_007_unit', 'agent_receiver', 10);
  assert.equal(firstPull.length, 1);

  const firstFailure = store.failInbox({
    team_id: 'team_v3_007_unit',
    agent_id: 'agent_receiver',
    inbox_ids: [firstPull[0].inbox_id],
    error: 'transient_failure',
    max_attempts: 2,
    base_backoff_ms: 1,
    max_backoff_ms: 1,
    now_iso: new Date().toISOString()
  });
  assert.equal(firstFailure.processed, 1);
  assert.equal(firstFailure.scheduled_retry, 1);
  assert.equal(firstFailure.dead_lettered, 0);

  const waitRetryReady = Date.now() + 5;
  while (Date.now() < waitRetryReady) {
    // wait for retry backoff window
  }

  const secondPull = store.pullInbox('team_v3_007_unit', 'agent_receiver', 10);
  assert.equal(secondPull.length, 1);
  assert.equal(secondPull[0].message_id, 'msg_fail_1');

  const secondFailure = store.failInbox({
    team_id: 'team_v3_007_unit',
    agent_id: 'agent_receiver',
    message_ids: ['msg_fail_1'],
    error: 'terminal_failure',
    max_attempts: 2,
    base_backoff_ms: 1,
    max_backoff_ms: 1,
    now_iso: new Date().toISOString()
  });
  assert.equal(secondFailure.processed, 1);
  assert.equal(secondFailure.scheduled_retry, 0);
  assert.equal(secondFailure.dead_lettered, 1);

  const row = store.db
    .prepare('SELECT attempt_count, next_attempt_at, dead_letter_at FROM inbox WHERE message_id = ?')
    .get('msg_fail_1') as Record<string, unknown>;
  assert.equal(Number(row.attempt_count), 2);
  assert.equal(row.next_attempt_at, null);
  assert.equal(typeof row.dead_letter_at, 'string');

  const ackDeadLetter = store.ackInbox({
    team_id: 'team_v3_007_unit',
    agent_id: 'agent_receiver',
    ack_all: true
  });
  assert.equal(ackDeadLetter.acked, 0);

  const deadLetterHiddenFromInbox = store.pullInbox('team_v3_007_unit', 'agent_receiver', 10);
  assert.equal(deadLetterHiddenFromInbox.length, 0);

  store.close();
});

test('V3-007 unit: recoverInbox schedules one retry and does not reprocess until redelivery', () => {
  const store = createStoreFixture();

  appendDirectMessage(store, 'msg_recover_1', 'idemp_recover_1');

  const pulled = store.pullInbox('team_v3_007_unit', 'agent_receiver', 10);
  assert.equal(pulled.length, 1);

  const waitStale = Date.now() + 5;
  while (Date.now() < waitStale) {
    // wait so last_attempt_at is older than stale cutoff
  }

  const firstRecovery = store.recoverInbox('team_v3_007_unit', {
    now_iso: new Date().toISOString(),
    in_flight_timeout_ms: 1,
    max_attempts: 2,
    base_backoff_ms: 1,
    max_backoff_ms: 1
  });
  assert.equal(firstRecovery.recovered, 1);
  assert.equal(firstRecovery.scheduled_retry, 1);
  assert.equal(firstRecovery.dead_lettered, 0);

  const rowAfterFirst = store.db
    .prepare('SELECT last_attempt_at, dead_letter_at FROM inbox WHERE message_id = ?')
    .get('msg_recover_1') as Record<string, unknown>;
  assert.equal(rowAfterFirst.last_attempt_at, null);
  assert.equal(rowAfterFirst.dead_letter_at, null);

  const secondRecovery = store.recoverInbox('team_v3_007_unit', {
    now_iso: new Date(Date.now() + 1000).toISOString(),
    in_flight_timeout_ms: 1,
    max_attempts: 2,
    base_backoff_ms: 1,
    max_backoff_ms: 1
  });
  assert.equal(secondRecovery.recovered, 0);
  assert.equal(secondRecovery.scheduled_retry, 0);
  assert.equal(secondRecovery.dead_lettered, 0);

  store.close();
});
