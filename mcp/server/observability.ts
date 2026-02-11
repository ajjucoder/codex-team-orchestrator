import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

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

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

export function computeReplayDigest(events: Array<Record<string, unknown>>): string {
  const canonical = events
    .map((event) => stableSerialize(event))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function eventRank(eventType: string): number {
  if (eventType.startsWith('permission_decision:')) return 1;
  if (eventType.startsWith('mode_decision:')) return 2;
  if (eventType.startsWith('hook_pre:')) return 3;
  if (eventType.startsWith('tool_call:')) return 4;
  if (eventType.startsWith('hook_post:')) return 5;
  if (eventType.includes('merge')) return 6;
  if (eventType.includes('fail') || eventType.includes('error')) return 7;
  return 8;
}

export function buildForensicTimeline(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...events]
    .sort((left, right) => {
      const leftId = Number(left.id ?? 0);
      const rightId = Number(right.id ?? 0);
      if (leftId !== rightId) return leftId - rightId;
      const leftType = String(left.event_type ?? '');
      const rightType = String(right.event_type ?? '');
      const rankDelta = eventRank(leftType) - eventRank(rightType);
      if (rankDelta !== 0) return rankDelta;
      return leftType.localeCompare(rightType);
    })
    .map((event, index) => ({
      ordinal: index + 1,
      id: Number(event.id ?? 0),
      event_type: String(event.event_type ?? ''),
      team_id: event.team_id ?? null,
      agent_id: event.agent_id ?? null,
      task_id: event.task_id ?? null,
      created_at: event.created_at ?? null,
      payload: event.payload ?? {}
    }));
}
