#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { SqliteStore } from '../mcp/store/sqlite-store.js';
import { buildForensicTimeline, computeReplayDigest } from '../mcp/server/observability.js';

interface Args {
  dbPath: string;
  teamId: string;
  outPath: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    dbPath: '.tmp/team-orchestrator.sqlite',
    teamId: '',
    outPath: '.tmp/replay-audit.json',
    limit: 2000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      out.dbPath = argv[i + 1] ?? out.dbPath;
      i += 1;
      continue;
    }
    if (arg === '--team') {
      out.teamId = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--out') {
      out.outPath = argv[i + 1] ?? out.outPath;
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      const parsed = Number(argv[i + 1] ?? out.limit);
      out.limit = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : out.limit;
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.teamId) {
    throw new Error('--team is required');
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const store = new SqliteStore(args.dbPath);
  store.migrate();
  const events = store.replayEvents(args.teamId, args.limit);

  const timeline = buildForensicTimeline(events);
  const digest = computeReplayDigest(timeline);
  const output = {
    team_id: args.teamId,
    event_count: timeline.length,
    digest,
    timeline
  };
  writeFileSync(args.outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  store.close();

  console.log(`replay-audit:team=${args.teamId}`);
  console.log(`replay-audit:event_count=${timeline.length}`);
  console.log(`replay-audit:digest=${digest}`);
  console.log(`replay-audit:out=${args.outPath}`);
  console.log('replay-audit:ok');
}

main();
