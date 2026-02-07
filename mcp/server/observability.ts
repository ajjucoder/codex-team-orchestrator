import { readFileSync, existsSync } from 'node:fs';

interface TeamSummaryStoreLike {
  summarizeTeam(teamId: string): Record<string, unknown> | null;
}

interface ReplayStoreLike {
  replayEvents(teamId: string, limit: number): Array<Record<string, unknown>>;
}

function readDateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function parseStructuredLogFile(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

export function makeRunSummary(store: TeamSummaryStoreLike, teamId: string): Record<string, unknown> | null {
  const summary = store.summarizeTeam(teamId);
  if (!summary) {
    return null;
  }
  const created = readDateMs(summary.created_at);
  const updated = readDateMs(summary.updated_at);
  const durationMs = created !== null && updated !== null ? Math.max(0, updated - created) : null;

  return {
    ...summary,
    duration_ms: durationMs
  };
}

export function replayTeamEvents(store: ReplayStoreLike, teamId: string, limit = 1000): Array<Record<string, unknown>> {
  return store.replayEvents(teamId, limit);
}
