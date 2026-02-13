import type { ToolServerLike } from './types.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : fallback;
}

function isInFlightAttemptStatus(status: unknown): boolean {
  return status === 'dispatching'
    || status === 'executing'
    || status === 'validating'
    || status === 'integrating';
}

export function registerRecoveryTools(server: ToolServerLike): void {
  server.registerTool('team_orphan_recover', 'team_orphan_recover.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const nowIsoInput = readString(input, 'now_iso');
    const nowMs = Number.isFinite(Date.parse(nowIsoInput)) ? Date.parse(nowIsoInput) : Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const recoveryPolicy = (
      policy.recovery && typeof policy.recovery === 'object'
        ? policy.recovery as Record<string, unknown>
        : {}
    );
    const staleMs = Math.max(
      1,
      Math.floor(
        readNumber(input, 'agent_stale_ms', readNumber(recoveryPolicy, 'agent_stale_ms', 300000))
      )
    );
    const inFlightTimeoutMs = Math.max(
      1,
      Math.floor(readNumber(recoveryPolicy, 'in_flight_timeout_ms', 20000))
    );
    const maxAttempts = Math.max(
      1,
      Math.floor(readNumber(recoveryPolicy, 'max_attempts', 5))
    );
    const baseBackoffMs = Math.max(
      1,
      Math.floor(readNumber(recoveryPolicy, 'base_backoff_ms', 1000))
    );
    const maxBackoffMs = Math.max(
      baseBackoffMs,
      Math.floor(readNumber(recoveryPolicy, 'max_backoff_ms', 60000))
    );
    const cutoffIso = new Date(nowMs - staleMs).toISOString();
    const snapshotBefore = server.store.buildRecoverySnapshot(teamId, {
      now_iso: nowIso,
      agent_stale_ms: staleMs,
      limit: 20
    });

    const leaseRecovery = server.store.recoverExpiredTaskLeases(teamId, nowIso);
    const recoveredExecutionIds: string[] = [];
    for (const task of leaseRecovery.tasks) {
      const attempts = server
        .store
        .listExecutionAttempts(teamId, task.task_id)
        .filter((attempt) => isInFlightAttemptStatus(attempt.status));
      for (const attempt of attempts) {
        const nextRetryCount = Number.isFinite(Number(attempt.retry_count))
          ? Number(attempt.retry_count) + 1
          : 1;
        const updated = server.store.updateExecutionAttempt({
          execution_id: attempt.execution_id,
          patch: {
            status: 'failed_terminal',
            lease_owner_agent_id: null,
            lease_expires_at: null,
            retry_count: nextRetryCount,
            metadata: {
              ...(attempt.metadata ?? {}),
              recovery_reason: 'lease_expired_requeue',
              recovered_at: nowIso
            }
          }
        });
        if (updated) {
          recoveredExecutionIds.push(attempt.execution_id);
        }
      }
    }
    const inboxRecovery = server.store.recoverInbox(teamId, {
      now_iso: nowIso,
      in_flight_timeout_ms: inFlightTimeoutMs,
      max_attempts: maxAttempts,
      base_backoff_ms: baseBackoffMs,
      max_backoff_ms: maxBackoffMs
    });
    const staleAgents = server.store.markStaleAgentsOffline(teamId, cutoffIso);
    const activeAgents = server.store.listAgentsByTeam(teamId);
    const activeAgentIds = new Set(activeAgents.map((agent) => agent.agent_id));
    const staleAgentIds = new Set(staleAgents.agents.map((agent) => agent.agent_id));
    const runtimeSessions = server.store.listWorkerRuntimeSessionsByTeam(teamId);
    const recoveredWorkerSessionAgentIds: string[] = [];
    for (const session of runtimeSessions) {
      const shouldDelete = !activeAgentIds.has(session.agent_id) || staleAgentIds.has(session.agent_id);
      if (!shouldDelete) continue;
      const deleted = server.store.deleteWorkerRuntimeSession(session.agent_id);
      if (deleted) {
        recoveredWorkerSessionAgentIds.push(session.agent_id);
      }
    }
    const snapshotAfter = server.store.buildRecoverySnapshot(teamId, {
      now_iso: nowIso,
      agent_stale_ms: staleMs,
      limit: 20
    });

    server.store.logEvent({
      team_id: teamId,
      event_type: 'orphan_recovery',
      payload: {
        now_iso: nowIso,
        stale_cutoff_iso: cutoffIso,
        recovered_tasks: leaseRecovery.recovered,
        recovered_execution_attempts: recoveredExecutionIds.length,
        recovered_inbox: inboxRecovery.recovered,
        recovered_worker_sessions: recoveredWorkerSessionAgentIds.length,
        recovered_worker_session_agent_ids: recoveredWorkerSessionAgentIds,
        inbox_scheduled_retry: inboxRecovery.scheduled_retry,
        inbox_dead_lettered: inboxRecovery.dead_lettered,
        marked_agents_offline: staleAgents.marked_offline,
        snapshot_before: snapshotBefore,
        snapshot_after: snapshotAfter
      }
    });

    return {
      ok: true,
      team_id: teamId,
      recovered_tasks: leaseRecovery.recovered,
      recovered_task_ids: leaseRecovery.tasks.map((task) => task.task_id),
      recovered_execution_attempts: recoveredExecutionIds.length,
      recovered_execution_ids: recoveredExecutionIds,
      recovered_inbox: inboxRecovery.recovered,
      recovered_worker_sessions: recoveredWorkerSessionAgentIds.length,
      recovered_worker_session_agent_ids: recoveredWorkerSessionAgentIds,
      inbox_scheduled_retry: inboxRecovery.scheduled_retry,
      inbox_dead_lettered: inboxRecovery.dead_lettered,
      inbox_retry_inbox_ids: inboxRecovery.retry_inbox_ids,
      inbox_dead_letter_inbox_ids: inboxRecovery.dead_letter_inbox_ids,
      marked_agents_offline: staleAgents.marked_offline,
      stale_agent_ids: staleAgents.agents.map((agent) => agent.agent_id),
      recovery_snapshot_before: snapshotBefore,
      recovery_snapshot_after: snapshotAfter
    };
  });
}
