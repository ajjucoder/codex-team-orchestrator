import { readFileSync, existsSync } from 'node:fs';

export function parseStructuredLogFile(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

export function makeRunSummary(store, teamId) {
  const summary = store.summarizeTeam(teamId);
  if (!summary) {
    return null;
  }
  const created = Date.parse(summary.created_at);
  const updated = Date.parse(summary.updated_at);
  const durationMs = Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : null;

  return {
    ...summary,
    duration_ms: durationMs
  };
}

export function replayTeamEvents(store, teamId, limit = 1000) {
  return store.replayEvents(teamId, limit);
}
