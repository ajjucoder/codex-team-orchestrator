import type { ToolServerLike } from './types.js';
import { makeRunSummary, replayTeamEvents } from '../observability.js';
import { buildTeamUiState } from '../team-ui-state.js';
import { buildStaffingPlan, type TaskSize } from '../staffing-planner.js';
import { inferTaskSizeFromPrompt } from '../trigger.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readLimit(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | null {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : null;
}

function readTaskSize(input: Record<string, unknown>, textHint: string): TaskSize {
  const value = readString(input, 'task_size');
  if (value === 'small' || value === 'medium' || value === 'high') {
    return value;
  }
  return inferTaskSizeFromPrompt(textHint);
}

export function registerObservabilityTools(server: ToolServerLike): void {
  server.registerTool('team_run_summary', 'team_run_summary.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const summary = makeRunSummary(server.store, teamId);
    if (!summary) {
      return { ok: false, error: `team not found: ${teamId}` };
    }
    return {
      ok: true,
      summary
    };
  });

  server.registerTool('team_replay', 'team_replay.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const limit = readLimit(input, 'limit', 1000);
    const events = replayTeamEvents(server.store, teamId, limit);
    return {
      ok: true,
      team_id: teamId,
      event_count: events.length,
      events
    };
  });

  server.registerTool('team_ui_state', 'team_ui_state.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const teamState = buildTeamUiState(server.store, teamId, {
      recent_event_limit: readOptionalNumber(input, 'recent_event_limit') ?? undefined,
      evidence_limit: readOptionalNumber(input, 'evidence_limit') ?? undefined,
      failure_limit: readOptionalNumber(input, 'failure_limit') ?? undefined
    });
    if (!teamState) {
      return { ok: false, error: `team not found: ${teamId}` };
    }
    return {
      ok: true,
      team_id: teamId,
      ...teamState
    };
  });

  server.registerTool('team_staff_plan', 'team_staff_plan.schema.json', (input) => {
    const teamId = readOptionalString(input, 'team_id');
    const team = teamId ? server.store.getTeam(teamId) : null;
    if (teamId && !team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const objectiveFromInput = readOptionalString(input, 'objective')
      ?? readOptionalString(input, 'prompt');
    if (!team && !objectiveFromInput) {
      return {
        ok: false,
        error: 'team_id is required when objective/prompt is not provided'
      };
    }

    const objective = objectiveFromInput
      ?? team?.objective
      ?? 'Execute requested objective';
    const taskSize = readTaskSize(input, objective);
    const maxThreads = readOptionalNumber(input, 'max_threads') ?? team?.max_threads ?? 6;
    const estimatedParallelTasks = readOptionalNumber(input, 'estimated_parallel_tasks');
    const preferredThreads = readOptionalNumber(input, 'preferred_threads');

    const plan = buildStaffingPlan({
      objective,
      task_size: taskSize,
      max_threads: maxThreads,
      estimated_parallel_tasks: estimatedParallelTasks ?? undefined,
      preferred_threads: preferredThreads ?? undefined
    });

    return {
      ok: true,
      team_id: team?.team_id ?? null,
      objective,
      plan
    };
  });
}
