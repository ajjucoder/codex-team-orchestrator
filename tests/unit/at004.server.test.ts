import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';
import { StructuredLogger } from '../../mcp/server/tracing.js';
import { MCPServer } from '../../mcp/server/server.js';

const dbPath = '.tmp/at004-unit.sqlite';
const logPath = '.tmp/at004-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-004 server start and health check', () => {
  const store = new SqliteStore(dbPath);
  const logger = new StructuredLogger(logPath);
  const server = new MCPServer({ store, logger });

  const start = server.start();
  assert.equal(start.ok, true);

  const health = server.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.checks.db_status, 'ok');
  assert.ok(health.checks.migration_count >= 1);

  store.close();
});

test('AT-004 tool call validates schema before handler execution', () => {
  const store = new SqliteStore(dbPath);
  const logger = new StructuredLogger(logPath);
  const server = new MCPServer({ store, logger });
  server.start();

  let called = false;
  server.registerTool('team_start', 'team_start.schema.json', () => {
    called = true;
    return { ok: true };
  });

  const invalid = server.callTool('team_start', { profile: 'default' });
  assert.equal(invalid.ok, false);
  assert.equal(called, false);

  const valid = server.callTool('team_start', { objective: 'ship feature' });
  assert.equal(valid.ok, true);
  assert.equal(called, true);

  store.close();
});
