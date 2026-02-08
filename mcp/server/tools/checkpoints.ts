import type { ToolServerLike } from './types.js';

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

export function registerCheckpointTools(server: ToolServerLike): void {
  server.registerTool('team_checkpoint_compact', 'team_checkpoint_compact.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const keepRecentMessages = Math.max(0, readOptionalNumber(input, 'keep_recent_messages') ?? 20);
    const keepRecentEvents = Math.max(0, readOptionalNumber(input, 'keep_recent_events') ?? 500);
    const checkpointName = readOptionalString(input, 'checkpoint_name') ?? 'Context Checkpoint';
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
      schema_version: 'v2-015',
      generated_at: nowIso(),
      team_id: teamId,
      keep_recent_messages: keepRecentMessages,
      keep_recent_events: keepRecentEvents,
      summary,
      artifact_refs: artifacts,
      event_tail: eventTail
    };

    const checkpointArtifactId = 'artifact_checkpoint_context';
    const checkpoint = server.store.publishArtifact({
      artifact_id: checkpointArtifactId,
      team_id: teamId,
      name: checkpointName,
      content: JSON.stringify(checkpointPayload),
      metadata: {
        kind: 'context_checkpoint',
        generated_at: checkpointPayload.generated_at
      }
    });
    if (!checkpoint) {
      return { ok: false, error: 'failed to publish checkpoint artifact' };
    }

    const pruned = server.store.pruneTeamContext({
      team_id: teamId,
      keep_recent_messages: keepRecentMessages,
      keep_recent_events: keepRecentEvents
    });
    const after = server.store.estimateContextFootprint(teamId);

    server.store.updateTeamMetadata(teamId, {
      context_checkpoint: {
        artifact_id: checkpoint.artifact_id,
        version: checkpoint.version,
        checksum: checkpoint.checksum,
        created_at: checkpoint.created_at,
        keep_recent_messages: keepRecentMessages,
        keep_recent_events: keepRecentEvents,
        before,
        after,
        deleted_messages: pruned.deleted_messages,
        deleted_events: pruned.deleted_events
      }
    });

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
        after_total_chars: after.total_chars
      }
    });

    const reduction = before.total_chars > 0
      ? Number((((before.total_chars - after.total_chars) / before.total_chars) * 100).toFixed(2))
      : 0;

    return {
      ok: true,
      team_id: teamId,
      checkpoint: {
        artifact_id: checkpoint.artifact_id,
        version: checkpoint.version,
        checksum: checkpoint.checksum,
        created_at: checkpoint.created_at
      },
      compaction: {
        keep_recent_messages: keepRecentMessages,
        keep_recent_events: keepRecentEvents,
        deleted_messages: pruned.deleted_messages,
        deleted_events: pruned.deleted_events,
        footprint_before: before,
        footprint_after: after,
        reduction_percent: reduction
      }
    };
  });

  server.registerTool('team_context_reset', 'team_context_reset.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const checkpointMetadata = asRecord(team.metadata.context_checkpoint);
    const checkpointArtifactId = readOptionalString(input, 'checkpoint_artifact_id')
      ?? String(checkpointMetadata.artifact_id ?? '');
    if (!checkpointArtifactId) {
      return { ok: false, error: 'checkpoint_artifact_id is required when no compacted checkpoint exists' };
    }

    const inputCheckpointVersion = readOptionalNumber(input, 'checkpoint_version');
    const metadataCheckpointVersion = Number(checkpointMetadata.version ?? 0);
    const checkpointVersion = inputCheckpointVersion
      ?? (Number.isFinite(metadataCheckpointVersion) && metadataCheckpointVersion > 0
        ? metadataCheckpointVersion
        : null);
    const artifact = server.store.getArtifact(teamId, checkpointArtifactId, checkpointVersion);
    if (!artifact) {
      return {
        ok: false,
        error: `checkpoint artifact not found: ${checkpointArtifactId}${checkpointVersion ? `@${checkpointVersion}` : ''}`
      };
    }

    const resetAt = nowIso();
    server.store.updateTeamMetadata(teamId, {
      context_reset: {
        reset_at: resetAt,
        checkpoint_artifact_id: artifact.artifact_id,
        checkpoint_version: artifact.version,
        checkpoint_checksum: artifact.checksum
      }
    });

    server.store.logEvent({
      team_id: teamId,
      artifact_id: artifact.artifact_id,
      event_type: 'team_context_reset',
      payload: {
        checkpoint_artifact_id: artifact.artifact_id,
        checkpoint_version: artifact.version,
        checkpoint_checksum: artifact.checksum,
        reset_at: resetAt
      }
    });

    const updated = server.store.getTeam(teamId);
    const metadata = asRecord(updated?.metadata.context_reset);
    return {
      ok: true,
      team_id: teamId,
      context_reset: {
        reset_at: String(metadata.reset_at ?? resetAt),
        checkpoint_artifact_id: String(metadata.checkpoint_artifact_id ?? artifact.artifact_id),
        checkpoint_version: Number(metadata.checkpoint_version ?? artifact.version),
        checkpoint_checksum: String(metadata.checkpoint_checksum ?? artifact.checksum)
      }
    };
  });
}
