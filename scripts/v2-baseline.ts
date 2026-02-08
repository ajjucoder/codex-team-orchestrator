#!/usr/bin/env node

import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildV2BaselineSnapshot, type V2BaselineSnapshot } from '../benchmarks/v2-baseline.js';

interface CliOptions {
  write: boolean;
  fixturePath: string;
  outPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = {
    write: false,
    fixturePath: 'tests/fixtures/v2-001-baseline.snapshot.json'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    if (arg === '--fixture') {
      out.fixturePath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--out') {
      out.outPath = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }

  return out;
}

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = buildV2BaselineSnapshot();

  if (options.outPath) {
    writeJson(options.outPath, snapshot);
  }

  if (options.write) {
    writeJson(options.fixturePath, snapshot);
    console.log('v2-baseline:mode=write');
    console.log(`v2-baseline:fixture=${options.fixturePath}`);
    if (options.outPath) {
      console.log(`v2-baseline:out=${options.outPath}`);
    }
    console.log('v2-baseline:ok');
    return;
  }

  const expected = readJson(options.fixturePath) as V2BaselineSnapshot;
  assert.deepEqual(snapshot, expected);

  console.log('v2-baseline:mode=verify');
  console.log(`v2-baseline:fixture=${options.fixturePath}`);
  if (options.outPath) {
    console.log(`v2-baseline:out=${options.outPath}`);
  }
  console.log('v2-baseline:ok');
}

main();
