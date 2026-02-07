#!/usr/bin/env node
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const requiredPaths = [
  'mcp/server',
  'mcp/schemas',
  'mcp/store',
  'skills/agent-teams/references',
  'profiles',
  'scripts',
  'benchmarks',
  'docs',
  'tests/unit',
  'tests/integration'
];

for (const req of requiredPaths) {
  if (!existsSync(req)) {
    throw new Error(`missing required path: ${req}`);
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.git')) continue;
      walk(fullPath, out);
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

const jsFiles = walk(resolve('.')).filter((file) => {
  const ext = extname(file);
  return ext === '.js' || ext === '.mjs' || ext === '.cjs';
});

for (const file of jsFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`lint: validated ${jsFiles.length} JS files and repository shape`);
