#!/usr/bin/env bash
set -euo pipefail

db_path="${DB_PATH:-.tmp/team-orchestrator.sqlite}"
log_path="${LOG_PATH:-.tmp/team-events.log}"
tick_interval_ms="${TICK_INTERVAL_MS:-250}"

node --import tsx --input-type=module - "$db_path" "$log_path" "$tick_interval_ms" <<'NODE'
import { createScheduler, createServer } from './mcp/server/index.ts';

const [dbPath, logPath, tickIntervalRaw] = process.argv.slice(2);
const parsedTickInterval = Number(tickIntervalRaw);
const tickIntervalMs = Number.isFinite(parsedTickInterval) && parsedTickInterval > 0
  ? Math.floor(parsedTickInterval)
  : 250;

const server = createServer({ dbPath, logPath });
server.start();

const scheduler = createScheduler({
  server,
  tickIntervalMs
});
scheduler.start();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  server.store.close();
  console.log(`scheduler:stopped signal=${signal}`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`scheduler:started db=${dbPath} tick_interval_ms=${tickIntervalMs}`);
process.stdin.resume();
NODE
