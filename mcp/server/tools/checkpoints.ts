import { RuntimeContextManager, toContextStreamId } from '../../runtime/context.js';
import { estimateToolUsage } from '../usage-estimator.js';
import type { ToolServerLike } from './types.js';

const LEGACY_CHECKPOINT_ARTIFACT_ID = 'artifact_checkpoint_context';

interface StreamScope {
  scope: 'team' | 'worker';
  worker_id: string | null;
  stream_id: string;
}

interface StreamScopeResolution {
  ok: boolean;
  stream?: StreamScope;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

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

function readOptionalNumber(input: Record<string, unknown>, key: string): number | null {
  const value = Number(input[key]);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sanitizeArtifactSuffix(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe.length > 0 ? safe : 'worker';
}

function toArtifactId(scope: StreamScope): string {
  if (scope.scope === 'team') {
    return LEGACY_CHECKPOINT_ARTIFACT_ID;
  }
  return `artifact_checkpoint_context_worker_${sanitizeArtifactSuffix(scope.worker_id ?? '')}`;
}

function charsToTokens(totalChars: unknown): number {
  const chars = Number(totalChars);
  if (!Number.isFinite(chars)) return 0;
  return Math.max(0, Math.ceil(Math.max(0, chars) / 4));
}

function readAuthenticatedAgentId(context: Record<string, unknown>): string | null {
  return readOptionalString(context, 'auth_agent_id');
}

function resolveStreamScope(input: Record<string, unknown>, context: Record<string, unknown>): StreamScopeResolution {
  const requestedWorkerId = readOptionalString(input, 'worker_id') ?? readOptionalString(context, 'worker_id');
  if (!requestedWorkerId) {
    return {
      ok: true,
      stream: {
        scope: 'team',
        worker_id: null,
        stream_id: toContextStreamId(null)
      }
    };
  }

  const authenticatedAgentId = readAuthenticatedAgentId(context);
  if (!authenticatedAgentId) {
    return {
      ok: false,
      error: 'worker-scoped checkpoint operations require authenticated agent context'
    };
  }
  if (authenticatedAgentId !== requestedWorkerId) {
    return {
      ok: false,
      error: `worker_id does not match authenticated agent: requested ${requestedWorkerId}, authenticated ${authenticatedAgentId}`
    };
  }

  return {
    ok: true,
    stream: {
      scope: 'worker',
      worker_id: authenticatedAgentId,
      stream_id: toContextStreamId(authenticatedAgentId)
    }
  };
}

function readContextStreams(teamMetadata: Record<string, unknown>): Record<string, unknown> {
  return asRecord(teamMetadata.context_streams);
}

function readStreamMetadata(teamMetadata: Record<string, unknown>, stream: StreamScope): Record<string, unknown> {
  const streams = readContextStreams(teamMetadata);
  return asRecord(streams[stream.stream_id]);
}

function readPersistedStreamMetadata(teamMetadata: Record<string, unknown>, stream: StreamScope): Record<string, unknown> {
  const scoped = readStreamMetadata(teamMetadata, stream);
  if (stream.scope === 'worker') {
    return scoped;
  }

  const scopedCheckpoint = asRecord(scoped.context_checkpoint);
  const scopedReset = asRecord(scoped.context_reset);
  return {
    ...scoped,
    context_checkpoint: Object.keys(scopedCheckpoint).length > 0
      ? scopedCheckpoint
      : asRecord(teamMetadata.context_checkpoint),
    context_reset: Object.keys(scopedReset).length > 0
      ? scopedReset
      : asRecord(teamMetadata.context_reset)
  };
}

function withStreamMetadata(
  teamMetadata: Record<string, unknown>,
  stream: StreamScope,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const streams = readContextStreams(teamMetadata);
  const existing = asRecord(streams[stream.stream_id]);
  return {
    ...streams,
    [stream.stream_id]: {
      ...existing,
      stream_id: stream.stream_id,
      scope: stream.scope,
      worker_id: stream.worker_id,
      ...patch
    }
  };
}

function compactedWorkerTokens(keepRecentMessages: number, keepRecentEvents: number, current: number): number {
  const retained = Math.max(0, keepRecentMessages * 15 + Math.ceil(keepRecentEvents / 10));
  return Math.min(Math.max(0, current), retained);
}

function hydrateRuntimeStreamFromMetadata(
  contextManager: RuntimeContextManager,
  teamId: string,
  teamMetadata: Record<string, unknown>,
  stream: StreamScope
): void {
  const persisted = readPersistedStreamMetadata(teamMetadata, stream);
  contextManager.hydrateStream({
    team_id: teamId,
    worker_id: stream.worker_id,
    stream_metadata: persisted
  });
}

export function registerCheckpointTools(server: ToolServerLike): void {
  const contextManager = new RuntimeContextManager();

  server.registerTool('team_checkpoint_compact', 'team_checkpoint_compact.schema.json', (input, context = {}) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const streamResolution = resolveStreamScope(input, asRecord(context));
    if (!streamResolution.ok || !streamResolution.stream) {
      return { ok: false, error: streamResolution.error ?? 'failed to resolve stream scope' };
    }
    const stream = streamResolution.stream;
    hydrateRuntimeStreamFromMetadata(contextManager, teamId, asRecord(team.metadata), stream);
    const keepRecentMessages = Math.max(0, readOptionalNumber(input, 'keep_recent_messages') ?? 20);
    const keepRecentEvents = Math.max(0, readOptionalNumber(input, 'keep_recent_events') ?? 500);
    const checkpointName = readOptionalString(input, 'checkpoint_name')
      ?? (stream.scope === 'worker' ? `Context Checkpoint (${stream.worker_id})` : 'Context Checkpoint');
    const before = server.store.estimateContextFootprint(teamId);
    const summary = server.store.summarizeTeam(teamId);
    const artifacts = server.store.listArtifacts(teamId).map((artifact) => ({
      artifact_id: artifact.artifact_id,
      name: artifact.name,
      version: artifact.version,
      checksum: artifact.checksum
    }));
    const eventTail = server
      .store
      .replayEvents(teamId, 50)
      .slice(-20)
      .map((event) => ({
        event_type: String(event.event_type ?? ''),
        created_at: String(event.created_at ?? '')
      }));

    const checkpointPayload = {
      schema_version: 'v3-004',
      generated_at: nowIso(),
      team_id: teamId,
      scope: stream.scope,
      worker_id: stream.worker_id,
      stream_id: stream.stream_id,
      keep_recent_messages: keepRecentMessages,
      keep_recent_events: keepRecentEvents,
      summary,
      artifact_refs: artifacts,
      event_tail: eventTail
    };

    const budgetBefore = contextManager.recordUsage({
      team_id: teamId,
      worker_id: stream.worker_id,
      estimated_tokens: estimateToolUsage({ input, result: checkpointPayload }).estimated_tokens
    });
    const checkpointArtifactId = toArtifactId(stream);
    const checkpoint = server.store.publishArtifact({
      artifact_id: checkpointArtifactId,
      team_id: teamId,
      name: checkpointName,
      content: JSON.stringify(checkpointPayload),
      metadata: {
        kind: 'context_checkpoint',
        generated_at: checkpointPayload.generated_at,
        scope: stream.scope,
        worker_id: stream.worker_id,
        stream_id: stream.stream_id
      }
    });
    if (!checkpoint) {
      return { ok: false, error: 'failed to publish checkpoint artifact' };
    }

    const pruned = stream.scope === 'team'
      ? server.store.pruneTeamContext({
        team_id: teamId,
        keep_recent_messages: keepRecentMessages,
        keep_recent_events: keepRecentEvents
      })
      : { deleted_messages: 0, deleted_events: 0 };
    const after = stream.scope === 'team' ? server.store.estimateContextFootprint(teamId) : before;
    const checkpointRef = {
      artifact_id: checkpoint.artifact_id,
      version: checkpoint.version,
      checksum: checkpoint.checksum,
      created_at: checkpoint.created_at
    };
    contextManager.registerCheckpoint({
      team_id: teamId,
      worker_id: stream.worker_id,
      checkpoint: checkpointRef
    });

    const budgetAfter = contextManager.markCompacted({
      team_id: teamId,
      worker_id: stream.worker_id,
      consumed_tokens_after: stream.scope === 'team'
        ? charsToTokens(after.total_chars)
        : compactedWorkerTokens(
          keepRecentMessages,
          keepRecentEvents,
          budgetBefore.budget.consumed_tokens
        ),
      compacted_at: checkpoint.created_at
    });

    const checkpointMetadata = {
      artifact_id: checkpoint.artifact_id,
      version: checkpoint.version,
      checksum: checkpoint.checksum,
      created_at: checkpoint.created_at,
      keep_recent_messages: keepRecentMessages,
      keep_recent_events: keepRecentEvents,
      before,
      after,
      deleted_messages: pruned.deleted_messages,
      deleted_events: pruned.deleted_events,
      scope: stream.scope,
      worker_id: stream.worker_id,
      stream_id: stream.stream_id,
      budget_before: budgetBefore.pressure,
      budget_after: budgetAfter.pressure
    };
    const nextStreams = withStreamMetadata(team.metadata, stream, {
      context_checkpoint: checkpointMetadata,
      budget: budgetAfter.budget
    });
    const metadataPatch: Record<string, unknown> = {
      context_streams: nextStreams
    };
    if (stream.scope === 'team') {
      metadataPatch.context_checkpoint = checkpointMetadata;
    }
    server.store.updateTeamMetadata(teamId, metadataPatch);

    server.store.logEvent({
      team_id: teamId,
      artifact_id: checkpoint.artifact_id,
      event_type: 'team_checkpoint_compacted',
      payload: {
        checkpoint_artifact_id: checkpoint.artifact_id,
        checkpoint_version: checkpoint.version,
        deleted_messages: pruned.deleted_messages,
        deleted_events: pruned.deleted_events,
        before_total_chars: before.total_chars,
        after_total_chars: after.total_chars,
        scope: stream.scope,
        worker_id: stream.worker_id,
        stream_id: stream.stream_id,
        budget_before: budgetBefore.pressure,
        budget_after: budgetAfter.pressure
      }
    });

    const reduction = Number(before.total_chars ?? 0) > 0
      ? Number((((Number(before.total_chars) - Number(after.total_chars)) / Number(before.total_chars)) * 100).toFixed(2))
      : 0;

    return {
      ok: true,
      team_id: teamId,
      scope: stream.scope,
      worker_id: stream.worker_id,
      stream_id: stream.stream_id,
      checkpoint: checkpointRef,
      compaction: {
        keep_recent_messages: keepRecentMessages,
        keep_recent_events: keepRecentEvents,
        deleted_messages: pruned.deleted_messages,
        deleted_events: pruned.deleted_events,
        footprint_before: before,
        footprint_after: after,
        reduction_percent: reduction
      },
      budget: {
        trigger: budgetBefore.pressure.should_compact ? 'soft_limit' : 'manual',
        pressure_before: budgetBefore.pressure,
        pressure_after: budgetAfter.pressure
      }
    };
  });

  server.registerTool('team_context_reset', 'team_context_reset.schema.json', (input, context = {}) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const streamResolution = resolveStreamScope(input, asRecord(context));
    if (!streamResolution.ok || !streamResolution.stream) {
      return { ok: false, error: streamResolution.error ?? 'failed to resolve stream scope' };
    }
    const stream = streamResolution.stream;
    hydrateRuntimeStreamFromMetadata(contextManager, teamId, asRecord(team.metadata), stream);
    const streamMetadata = readStreamMetadata(team.metadata, stream);
    const streamCheckpointMetadata = asRecord(streamMetadata.context_checkpoint);
    const checkpointMetadata = stream.scope === 'worker'
      ? streamCheckpointMetadata
      : asRecord(team.metadata.context_checkpoint);
    if (stream.scope === 'worker' && !streamCheckpointMetadata.artifact_id) {
      return {
        ok: false,
        error: `worker stream checkpoint missing for ${stream.stream_id}; compact this stream before reset`
      };
    }

    const inputCheckpointArtifactId = readOptionalString(input, 'checkpoint_artifact_id');
    const metadataCheckpointArtifactId = String(checkpointMetadata.artifact_id ?? '');
    if (
      stream.scope === 'worker'
      && inputCheckpointArtifactId
      && metadataCheckpointArtifactId
      && inputCheckpointArtifactId !== metadataCheckpointArtifactId
    ) {
      return {
        ok: false,
        error: `checkpoint_artifact_id does not belong to worker stream ${stream.stream_id}`
      };
    }

    const checkpointArtifactId = inputCheckpointArtifactId ?? metadataCheckpointArtifactId;
    if (!checkpointArtifactId) {
      return {
        ok: false,
        error: stream.scope === 'worker'
          ? `checkpoint_artifact_id is unavailable for worker stream ${stream.stream_id}`
          : 'checkpoint_artifact_id is required when no compacted checkpoint exists'
      };
    }

    const inputCheckpointVersion = readOptionalNumber(input, 'checkpoint_version');
    const metadataCheckpointVersion = Number(checkpointMetadata.version ?? 0);
    const knownCheckpointVersion = Number.isFinite(metadataCheckpointVersion) && metadataCheckpointVersion > 0
      ? metadataCheckpointVersion
      : null;
    if (
      stream.scope === 'worker'
      && Number.isFinite(inputCheckpointVersion)
      && Number.isFinite(knownCheckpointVersion)
      && inputCheckpointVersion !== knownCheckpointVersion
    ) {
      return {
        ok: false,
        error: `checkpoint_version does not match worker stream ${stream.stream_id}`
      };
    }
    const checkpointVersion = inputCheckpointVersion ?? knownCheckpointVersion;
    const artifact = server.store.getArtifact(teamId, checkpointArtifactId, checkpointVersion);
    if (!artifact) {
      return {
        ok: false,
        error: `checkpoint artifact not found: ${checkpointArtifactId}${checkpointVersion ? `@${checkpointVersion}` : ''}`
      };
    }

    const resetAt = nowIso();
    const postReset = contextManager.markReset({
      team_id: teamId,
      worker_id: stream.worker_id,
      reset_at: resetAt,
      checkpoint: {
        artifact_id: artifact.artifact_id,
        version: artifact.version,
        checksum: artifact.checksum,
        created_at: artifact.created_at
      }
    });
    const resetMetadata = {
      reset_at: resetAt,
      checkpoint_artifact_id: artifact.artifact_id,
      checkpoint_version: artifact.version,
      checkpoint_checksum: artifact.checksum,
      scope: stream.scope,
      worker_id: stream.worker_id,
      stream_id: stream.stream_id
    };
    const nextStreams = withStreamMetadata(team.metadata, stream, {
      context_reset: resetMetadata,
      budget: postReset.budget
    });
    const metadataPatch: Record<string, unknown> = {
      context_streams: nextStreams
    };
    if (stream.scope === 'team') {
      metadataPatch.context_reset = resetMetadata;
    }
    server.store.updateTeamMetadata(teamId, metadataPatch);

    server.store.logEvent({
      team_id: teamId,
      artifact_id: artifact.artifact_id,
      event_type: 'team_context_reset',
      payload: {
        checkpoint_artifact_id: artifact.artifact_id,
        checkpoint_version: artifact.version,
        checkpoint_checksum: artifact.checksum,
        reset_at: resetAt,
        scope: stream.scope,
        worker_id: stream.worker_id,
        stream_id: stream.stream_id
      }
    });

    const updated = server.store.getTeam(teamId);
    const updatedReset = stream.scope === 'worker'
      ? asRecord(readStreamMetadata(asRecord(updated?.metadata), stream).context_reset)
      : asRecord(updated?.metadata.context_reset);
    return {
      ok: true,
      team_id: teamId,
      scope: stream.scope,
      worker_id: stream.worker_id,
      stream_id: stream.stream_id,
      context_reset: {
        reset_at: String(updatedReset.reset_at ?? resetAt),
        checkpoint_artifact_id: String(updatedReset.checkpoint_artifact_id ?? artifact.artifact_id),
        checkpoint_version: Number(updatedReset.checkpoint_version ?? artifact.version),
        checkpoint_checksum: String(updatedReset.checkpoint_checksum ?? artifact.checksum)
      }
    };
  });
}
