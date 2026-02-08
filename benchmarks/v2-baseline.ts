import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../mcp/server/tools/team-lifecycle.js';
import { registerPolicyTools } from '../mcp/server/tools/policies.js';
import { registerAgentLifecycleTools } from '../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../mcp/server/tools/task-board.js';
import { registerArtifactTools } from '../mcp/server/tools/artifacts.js';
import { registerFanoutTools } from '../mcp/server/tools/fanout.js';
import { registerGuardrailTools } from '../mcp/server/tools/guardrails.js';
import { registerObservabilityTools } from '../mcp/server/tools/observability.js';
import type { MCPServer, ToolContext } from '../mcp/server/server.js';
import type { ToolServerLike } from '../mcp/server/tools/types.js';

export interface V2BaselineSnapshot {
  schema_version: 'v2-001';
  scenario: 'core_orchestration_contract';
  team: {
    profile: string;
    max_threads: number;
    session_model: string | null;
    status: string;
    policy_profile: string;
  };
  agent_flow: {
    spawned_roles: string[];
    inherited_model_sources: string[];
    max_threads_rejection: {
      rejected: boolean;
      error_contains: boolean;
    };
  };
  task_flow: {
    dependency_blocked_on_create: boolean;
    ready_queue_before_done_count: number;
    foundation_claimed_by_implementer: boolean;
    foundation_done_promoted_dependents: number;
    ready_queue_after_done_count: number;
    review_claimed_by_reviewer: boolean;
    all_tasks_done: boolean;
  };
  messaging_flow: {
    direct_send_inserted: boolean;
    duplicate_send_suppressed: boolean;
    broadcast_recipient_count: number;
    reviewer_inbox_count: number;
    reviewer_ack_count: number;
  };
  artifact_flow: {
    versions: number[];
    latest_version: number;
    checksum_changes: boolean;
    latest_list_count: number;
  };
  orchestration: {
    fanout_recommended_threads: number;
    fanout_within_medium_band: boolean;
    fanout_budget_source: string;
    early_stop: boolean;
    early_stop_reason: string;
  };
  observability: {
    summary_metrics: {
      agents: number;
      messages: number;
      artifacts: number;
      tasks_done: number;
    };
    usage_sample_count_positive: boolean;
    replay_event_count_positive: boolean;
    required_event_types_present: boolean;
  };
  security: {
    cross_team_send_denied: boolean;
    cross_team_error_contains: boolean;
  };
  health: {
    ok: boolean;
    db_status: 'ok' | 'error';
    migration_count_at_least_1: boolean;
    max_threads_enforced: boolean;
    trace_logging_ready: boolean;
  };
}

interface BaselinePaths {
  dbPath: string;
  logPath: string;
}

function cleanupPaths({ dbPath, logPath }: BaselinePaths): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (!isRecord(value)) {
    return {};
  }
  return value;
}

function readRecordArray(input: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(input: Record<string, unknown>, key: string): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : 0;
}

function readBoolean(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

function callTool(
  server: ToolServerLike,
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext = {}
): Record<string, unknown> {
  const result = server.callTool(toolName, input, context);
  assert.equal(isRecord(result), true, `${toolName} should return an object result`);
  return result;
}

export function buildV2BaselineSnapshot(): V2BaselineSnapshot {
  const paths: BaselinePaths = {
    dbPath: '.tmp/v2-001-baseline.sqlite',
    logPath: '.tmp/v2-001-baseline.log'
  };

  cleanupPaths(paths);
  const server = createServer(paths);
  const toolServer = server as unknown as ToolServerLike;

  try {
    server.start();
    registerTeamLifecycleTools(toolServer);
    registerPolicyTools(toolServer);
    registerAgentLifecycleTools(toolServer);
    registerTaskBoardTools(toolServer);
    registerArtifactTools(toolServer);
    registerFanoutTools(toolServer);
    registerGuardrailTools(toolServer);
    registerObservabilityTools(toolServer);

    const teamStart = callTool(toolServer, 'team_start', {
      objective: 'v2 baseline freeze',
      profile: 'default',
      max_threads: 3
    }, {
      active_session_model: 'gpt-5-codex'
    });
    assert.equal(teamStart.ok, true, 'team_start should succeed');
    const startedTeam = readRecord(teamStart, 'team');
    const teamId = readString(startedTeam, 'team_id');
    assert.ok(teamId, 'team_id should be present');

    const teamStatus = callTool(toolServer, 'team_status', { team_id: teamId });
    assert.equal(teamStatus.ok, true, 'team_status should succeed');
    const statusTeam = readRecord(teamStatus, 'team');

    const teamPolicy = callTool(toolServer, 'team_policy_get', { team_id: teamId });
    assert.equal(teamPolicy.ok, true, 'team_policy_get should succeed');
    const policy = readRecord(teamPolicy, 'policy');

    const leadSpawn = callTool(toolServer, 'team_spawn', { team_id: teamId, role: 'lead' });
    const implementerSpawn = callTool(toolServer, 'team_spawn', { team_id: teamId, role: 'implementer' });
    const reviewerSpawn = callTool(toolServer, 'team_spawn', { team_id: teamId, role: 'reviewer' });
    assert.equal(leadSpawn.ok, true, 'lead spawn should succeed');
    assert.equal(implementerSpawn.ok, true, 'implementer spawn should succeed');
    assert.equal(reviewerSpawn.ok, true, 'reviewer spawn should succeed');

    const overCapSpawn = callTool(toolServer, 'team_spawn', { team_id: teamId, role: 'tester' });
    const overCapError = readString(overCapSpawn, 'error');

    const lead = readRecord(leadSpawn, 'agent');
    const implementer = readRecord(implementerSpawn, 'agent');
    const reviewer = readRecord(reviewerSpawn, 'agent');
    const leadId = readString(lead, 'agent_id');
    const implementerId = readString(implementer, 'agent_id');
    const reviewerId = readString(reviewer, 'agent_id');
    assert.ok(leadId && implementerId && reviewerId, 'spawned agent ids should be present');

    const foundationCreate = callTool(toolServer, 'team_task_create', {
      team_id: teamId,
      title: 'foundation task',
      priority: 1,
      required_role: 'implementer'
    });
    const reviewCreate = callTool(toolServer, 'team_task_create', {
      team_id: teamId,
      title: 'review task',
      priority: 2,
      required_role: 'reviewer',
      depends_on_task_ids: [readString(readRecord(foundationCreate, 'task'), 'task_id')]
    });
    assert.equal(foundationCreate.ok, true, 'foundation task should be created');
    assert.equal(reviewCreate.ok, true, 'review task should be created');

    const foundationTask = readRecord(foundationCreate, 'task');
    const reviewTask = readRecord(reviewCreate, 'task');
    const foundationTaskId = readString(foundationTask, 'task_id');
    const reviewTaskId = readString(reviewTask, 'task_id');
    assert.ok(foundationTaskId && reviewTaskId, 'task ids should be present');

    const queueBeforeDone = callTool(toolServer, 'team_task_next', {
      team_id: teamId,
      limit: 10
    });
    const queueBeforeTasks = readRecordArray(queueBeforeDone, 'tasks');

    const foundationClaim = callTool(toolServer, 'team_task_claim', {
      team_id: teamId,
      task_id: foundationTaskId,
      agent_id: implementerId,
      expected_lock_version: readNumber(foundationTask, 'lock_version')
    });
    assert.equal(foundationClaim.ok, true, 'foundation task claim should succeed');
    const foundationClaimTask = readRecord(foundationClaim, 'task');

    const directSend = callTool(toolServer, 'team_send', {
      team_id: teamId,
      from_agent_id: implementerId,
      to_agent_id: leadId,
      summary: 'foundation in progress',
      artifact_refs: [],
      idempotency_key: 'v2-001-direct-1'
    });
    assert.equal(directSend.ok, true, 'direct send should succeed');

    const duplicateDirectSend = callTool(toolServer, 'team_send', {
      team_id: teamId,
      from_agent_id: implementerId,
      to_agent_id: leadId,
      summary: 'foundation in progress',
      artifact_refs: [],
      idempotency_key: 'v2-001-direct-1'
    });
    assert.equal(duplicateDirectSend.ok, true, 'duplicate direct send should return success with suppression');

    const foundationDone = callTool(toolServer, 'team_task_update', {
      team_id: teamId,
      task_id: foundationTaskId,
      status: 'done',
      expected_lock_version: readNumber(foundationClaimTask, 'lock_version')
    });
    assert.equal(foundationDone.ok, true, 'foundation task completion should succeed');

    const queueAfterDone = callTool(toolServer, 'team_task_next', {
      team_id: teamId,
      limit: 10
    });
    const queueAfterTasks = readRecordArray(queueAfterDone, 'tasks');

    const reviewClaim = callTool(toolServer, 'team_task_claim', {
      team_id: teamId,
      task_id: reviewTaskId,
      agent_id: reviewerId,
      expected_lock_version: readNumber(queueAfterTasks[0] ?? {}, 'lock_version') || readNumber(reviewTask, 'lock_version')
    });
    assert.equal(reviewClaim.ok, true, 'review task claim should succeed');

    const artifactV1 = callTool(toolServer, 'team_artifact_publish', {
      team_id: teamId,
      artifact_id: 'artifact_patch',
      name: 'Patch',
      content: 'patch-v1',
      published_by: leadId
    });
    const artifactV2 = callTool(toolServer, 'team_artifact_publish', {
      team_id: teamId,
      artifact_id: 'artifact_patch',
      name: 'Patch',
      content: 'patch-v2',
      published_by: leadId
    });
    assert.equal(artifactV1.ok, true, 'artifact publish v1 should succeed');
    assert.equal(artifactV2.ok, true, 'artifact publish v2 should succeed');

    const artifactV2Record = readRecord(artifactV2, 'artifact');
    const broadcast = callTool(toolServer, 'team_broadcast', {
      team_id: teamId,
      from_agent_id: leadId,
      summary: 'review ready',
      artifact_refs: [{ artifact_id: 'artifact_patch', version: readNumber(artifactV2Record, 'version') }],
      idempotency_key: 'v2-001-broadcast-1'
    });
    assert.equal(broadcast.ok, true, 'broadcast should succeed');

    const reviewerInbox = callTool(toolServer, 'team_pull_inbox', {
      team_id: teamId,
      agent_id: reviewerId,
      limit: 10,
      ack: true
    });
    assert.equal(reviewerInbox.ok, true, 'reviewer inbox pull should succeed');

    const reviewClaimTask = readRecord(reviewClaim, 'task');
    const reviewDone = callTool(toolServer, 'team_task_update', {
      team_id: teamId,
      task_id: reviewTaskId,
      status: 'done',
      expected_lock_version: readNumber(reviewClaimTask, 'lock_version')
    });
    assert.equal(reviewDone.ok, true, 'review task completion should succeed');

    const artifactLatest = callTool(toolServer, 'team_artifact_read', {
      team_id: teamId,
      artifact_id: 'artifact_patch'
    });
    const artifactList = callTool(toolServer, 'team_artifact_list', { team_id: teamId });
    assert.equal(artifactLatest.ok, true, 'artifact read should succeed');
    assert.equal(artifactList.ok, true, 'artifact list should succeed');

    const guardrail = callTool(toolServer, 'team_guardrail_check', {
      team_id: teamId,
      consensus_reached: true,
      open_tasks: 0
    });
    assert.equal(guardrail.ok, true, 'guardrail check should succeed');

    const fanoutPlan = callTool(toolServer, 'team_plan_fanout', {
      team_id: teamId,
      task_size: 'medium',
      estimated_parallel_tasks: 4,
      budget_tokens_remaining: 12000,
      token_cost_per_agent: 1000
    });
    assert.equal(fanoutPlan.ok, true, 'fanout planning should succeed');

    const runSummary = callTool(toolServer, 'team_run_summary', { team_id: teamId });
    const replay = callTool(toolServer, 'team_replay', { team_id: teamId, limit: 200 });
    assert.equal(runSummary.ok, true, 'run summary should succeed');
    assert.equal(replay.ok, true, 'replay should succeed');

    const idleSweep = callTool(toolServer, 'team_idle_sweep', { now_iso: readString(statusTeam, 'updated_at') });
    assert.equal(idleSweep.ok, true, 'idle sweep should succeed');

    const otherTeamStart = callTool(toolServer, 'team_start', {
      objective: 'security isolation',
      profile: 'default',
      max_threads: 2
    });
    const otherTeam = readRecord(otherTeamStart, 'team');
    const otherTeamId = readString(otherTeam, 'team_id');
    const outsiderSpawn = callTool(toolServer, 'team_spawn', { team_id: otherTeamId, role: 'implementer' });
    const outsider = readRecord(outsiderSpawn, 'agent');
    const outsiderId = readString(outsider, 'agent_id');

    const crossTeamSend = callTool(toolServer, 'team_send', {
      team_id: teamId,
      from_agent_id: outsiderId,
      to_agent_id: reviewerId,
      summary: 'cross-team attempt',
      artifact_refs: [],
      idempotency_key: 'v2-001-cross-team'
    });

    const health = server.healthCheck();
    const fanoutRecommendation = readRecord(fanoutPlan, 'recommendation');
    const fanoutBudget = readRecord(fanoutPlan, 'budget_controller');
    const guardrailEarlyStop = readRecord(guardrail, 'early_stop');
    const summary = readRecord(runSummary, 'summary');
    const summaryMetrics = readRecord(summary, 'metrics');
    const summaryTasks = readRecord(summaryMetrics, 'tasks');
    const summaryUsage = readRecord(summary, 'usage');
    const replayEvents = readRecordArray(replay, 'events');
    const replayEventTypes = replayEvents.map((event) => readString(event, 'event_type'));
    const requiredEventTypesPresent = [
      'tool_call:team_spawn',
      'tool_call:team_task_create',
      'tool_call:team_send'
    ].every((eventType) => replayEventTypes.includes(eventType));

    const latestArtifact = readRecord(artifactLatest, 'artifact');
    const v1Artifact = readRecord(artifactV1, 'artifact');
    const v2Artifact = readRecord(artifactV2, 'artifact');

    return {
      schema_version: 'v2-001',
      scenario: 'core_orchestration_contract',
      team: {
        profile: readString(startedTeam, 'profile'),
        max_threads: readNumber(startedTeam, 'max_threads'),
        session_model: readString(startedTeam, 'session_model') || null,
        status: readString(statusTeam, 'status'),
        policy_profile: readString(policy, 'profile')
      },
      agent_flow: {
        spawned_roles: [
          readString(lead, 'role'),
          readString(implementer, 'role'),
          readString(reviewer, 'role')
        ],
        inherited_model_sources: [
          readString(readRecord(lead, 'metadata'), 'model_source'),
          readString(readRecord(implementer, 'metadata'), 'model_source'),
          readString(readRecord(reviewer, 'metadata'), 'model_source')
        ],
        max_threads_rejection: {
          rejected: overCapSpawn.ok === false,
          error_contains: /max_threads exceeded/.test(overCapError)
        }
      },
      task_flow: {
        dependency_blocked_on_create: readString(reviewTask, 'status') === 'blocked',
        ready_queue_before_done_count: queueBeforeTasks.length,
        foundation_claimed_by_implementer: readString(foundationClaimTask, 'claimed_by') === implementerId,
        foundation_done_promoted_dependents: readRecordArray(foundationDone, 'promoted_tasks').length,
        ready_queue_after_done_count: queueAfterTasks.length,
        review_claimed_by_reviewer: readString(reviewClaimTask, 'claimed_by') === reviewerId,
        all_tasks_done: readNumber(summaryTasks, 'done') === 2
      },
      messaging_flow: {
        direct_send_inserted: readBoolean(directSend, 'inserted'),
        duplicate_send_suppressed: readBoolean(duplicateDirectSend, 'duplicate_suppressed'),
        broadcast_recipient_count: readNumber(broadcast, 'recipient_count'),
        reviewer_inbox_count: readRecordArray(reviewerInbox, 'messages').length,
        reviewer_ack_count: readNumber(reviewerInbox, 'acked')
      },
      artifact_flow: {
        versions: [readNumber(v1Artifact, 'version'), readNumber(v2Artifact, 'version')],
        latest_version: readNumber(latestArtifact, 'version'),
        checksum_changes: readString(v1Artifact, 'checksum') !== readString(v2Artifact, 'checksum'),
        latest_list_count: readRecordArray(artifactList, 'artifacts').length
      },
      orchestration: {
        fanout_recommended_threads: readNumber(fanoutRecommendation, 'recommended_threads'),
        fanout_within_medium_band: readNumber(fanoutRecommendation, 'recommended_threads') >= 3
          && readNumber(fanoutRecommendation, 'recommended_threads') <= 4,
        fanout_budget_source: readString(fanoutBudget, 'source'),
        early_stop: readBoolean(guardrailEarlyStop, 'should_stop'),
        early_stop_reason: readString(guardrailEarlyStop, 'reason')
      },
      observability: {
        summary_metrics: {
          agents: readNumber(summaryMetrics, 'agents'),
          messages: readNumber(summaryMetrics, 'messages'),
          artifacts: readNumber(summaryMetrics, 'artifacts'),
          tasks_done: readNumber(summaryTasks, 'done')
        },
        usage_sample_count_positive: readNumber(summaryUsage, 'sample_count') > 0,
        replay_event_count_positive: readNumber(replay, 'event_count') > 0,
        required_event_types_present: requiredEventTypesPresent
      },
      security: {
        cross_team_send_denied: crossTeamSend.ok === false,
        cross_team_error_contains: /from_agent not in team/.test(readString(crossTeamSend, 'error'))
      },
      health: {
        ok: health.ok,
        db_status: health.checks.db_status,
        migration_count_at_least_1: health.checks.migration_count >= 1,
        max_threads_enforced: health.checks.max_threads_enforced,
        trace_logging_ready: health.checks.trace_logging_ready
      }
    };
  } finally {
    server.store.close();
    cleanupPaths(paths);
  }
}
