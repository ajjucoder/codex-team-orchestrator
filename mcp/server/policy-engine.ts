import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type YamlScalar = string | number | boolean;
type YamlValue = YamlScalar | YamlMap;
interface YamlMap {
  [key: string]: YamlValue;
}

function parseScalar(raw: string): YamlScalar {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

export function parseSimpleYaml(yamlText: string): Record<string, unknown> {
  const root: YamlMap = {};
  const stack: Array<{ indent: number; node: YamlMap }> = [{ indent: -1, node: root }];

  const lines = yamlText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indentMatch = line.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const trimmed = line.trim();
    const parts = trimmed.split(':');
    const key = (parts.shift() ?? '').trim();
    if (!key) continue;
    const remainder = parts.join(':').trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    if (remainder === '') {
      parent[key] = {};
      stack.push({ indent, node: parent[key] as YamlMap });
    } else {
      parent[key] = parseScalar(remainder);
    }
  }

  return root;
}

export class PolicyEngine {
  readonly profileDir: string;
  readonly cache: Map<string, Record<string, unknown>>;

  constructor(profileDir = 'profiles') {
    this.profileDir = profileDir;
    this.cache = new Map();
  }

  loadProfile(profileName: string): Record<string, unknown> {
    if (this.cache.has(profileName)) {
      return this.cache.get(profileName) ?? {};
    }

    const filePath = join(this.profileDir, `${profileName}.team.yaml`);
    const text = readFileSync(filePath, 'utf8');
    const parsed = parseSimpleYaml(text);
    this.cache.set(profileName, parsed);
    return parsed;
  }

  resolveTeamPolicy(team: { profile?: string | null } | null | undefined): Record<string, unknown> {
    const profileName = team?.profile ?? 'default';
    return this.loadProfile(profileName);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
