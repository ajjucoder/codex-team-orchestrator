import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

export function parseSimpleYaml(yamlText) {
  const root = {};
  const stack = [{ indent: -1, node: root }];

  const lines = yamlText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    const parts = trimmed.split(':');
    const key = parts.shift().trim();
    const remainder = parts.join(':').trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    if (remainder === '') {
      parent[key] = {};
      stack.push({ indent, node: parent[key] });
    } else {
      parent[key] = parseScalar(remainder);
    }
  }

  return root;
}

export class PolicyEngine {
  constructor(profileDir = 'profiles') {
    this.profileDir = profileDir;
    this.cache = new Map();
  }

  loadProfile(profileName) {
    if (this.cache.has(profileName)) {
      return this.cache.get(profileName);
    }

    const filePath = join(this.profileDir, `${profileName}.team.yaml`);
    const text = readFileSync(filePath, 'utf8');
    const parsed = parseSimpleYaml(text);
    this.cache.set(profileName, parsed);
    return parsed;
  }

  resolveTeamPolicy(team) {
    const profileName = team?.profile ?? 'default';
    return this.loadProfile(profileName);
  }

  clearCache() {
    this.cache.clear();
  }
}
