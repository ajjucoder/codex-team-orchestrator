import { newId } from './ids.js';
import type { AgentDecisionReportRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';

export interface RecordAgentDecisionReportInput {
  team_id: string;
  agent_id: string;
  task_id: string;
  decision: string;
  summary: string;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
  revision?: number | null;
  created_at?: string;
}

export interface RecordAgentDecisionReportResult {
  ok: boolean;
  error?: string;
  report?: AgentDecisionReportRecord;
  history?: AgentDecisionReportRecord[];
}

function normalizeOptionalRevision(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function recordAgentDecisionReport(
  store: SqliteStore,
  input: RecordAgentDecisionReportInput
): RecordAgentDecisionReportResult {
  const latest = store.getLatestAgentDecisionReport(input.team_id, input.agent_id, input.task_id);
  const requestedRevision = normalizeOptionalRevision(input.revision);
  const nextRevision = requestedRevision ?? ((latest?.revision ?? 0) + 1);
  if (requestedRevision !== null && latest && requestedRevision <= latest.revision) {
    return {
      ok: false,
      error: `decision report revision must be greater than ${latest.revision} for ${input.agent_id}/${input.task_id}`
    };
  }

  try {
    const created = store.createAgentDecisionReport({
      report_id: newId('report'),
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      revision: nextRevision,
      decision: String(input.decision || 'update'),
      summary: String(input.summary ?? ''),
      confidence: input.confidence ?? null,
      metadata: input.metadata ?? {},
      created_at: input.created_at ?? nowIso()
    });
    if (!created) {
      return {
        ok: false,
        error: 'failed to persist decision report'
      };
    }
    return {
      ok: true,
      report: created,
      history: store.listAgentDecisionReports(input.team_id, {
        agent_id: input.agent_id,
        task_id: input.task_id,
        limit: 50
      })
    };
  } catch (error) {
    return {
      ok: false,
      error: String((error as { message?: unknown })?.message ?? error ?? 'failed to persist decision report')
    };
  }
}
