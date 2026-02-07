import type { ToolServerLike } from './types.js';
import { newId } from '../ids.js';

const MAX_ARTIFACT_CONTENT_LENGTH = 200000;
const MAX_ARTIFACT_NAME_LENGTH = 256;

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
  return Number.isFinite(value) ? value : null;
}

function readMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const value = input.metadata;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function ensureTeam(server: ToolServerLike, teamId: string): { ok: true } | { ok: false; error: string } {
  const team = server.store.getTeam(teamId);
  if (!team) return { ok: false, error: `team not found: ${teamId}` };
  return { ok: true };
}

export function registerArtifactTools(server: ToolServerLike): void {
  server.registerTool('team_artifact_publish', 'team_artifact_publish.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const guard = ensureTeam(server, teamId);
    if (!guard.ok) return guard;

    const name = String(input.name ?? '');
    const content = String(input.content ?? '');

    if (name.length > MAX_ARTIFACT_NAME_LENGTH) {
      return { ok: false, error: `artifact name too long: max ${MAX_ARTIFACT_NAME_LENGTH}` };
    }
    if (content.length > MAX_ARTIFACT_CONTENT_LENGTH) {
      return { ok: false, error: `artifact content too large: max ${MAX_ARTIFACT_CONTENT_LENGTH}` };
    }

    const publishedBy = readOptionalString(input, 'published_by');
    if (publishedBy) {
      const agent = server.store.getAgent(publishedBy);
      if (!agent || agent.team_id !== teamId) {
        return { ok: false, error: `publisher agent not found in team: ${publishedBy}` };
      }
    }

    const artifactId = readOptionalString(input, 'artifact_id') ?? newId('artifact');
    const artifact = server.store.publishArtifact({
      artifact_id: artifactId,
      team_id: teamId,
      name,
      content,
      published_by: publishedBy,
      metadata: readMetadata(input)
    });
    if (!artifact) {
      return { ok: false, error: `failed to publish artifact: ${artifactId}` };
    }

    server.store.logEvent({
      team_id: teamId,
      agent_id: publishedBy,
      artifact_id: artifact.artifact_id,
      event_type: 'artifact_published',
      payload: {
        artifact_id: artifact.artifact_id,
        version: artifact.version,
        checksum: artifact.checksum
      }
    });

    return {
      ok: true,
      artifact: {
        artifact_id: artifact.artifact_id,
        team_id: artifact.team_id,
        name: artifact.name,
        version: artifact.version,
        checksum: artifact.checksum,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    };
  });

  server.registerTool('team_artifact_read', 'team_artifact_read.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const guard = ensureTeam(server, teamId);
    if (!guard.ok) return guard;

    const artifactId = readString(input, 'artifact_id');
    const version = readOptionalNumber(input, 'version');
    const artifact = server.store.getArtifact(teamId, artifactId, version);
    if (!artifact) {
      return { ok: false, error: `artifact not found: ${artifactId}` };
    }

    return {
      ok: true,
      artifact: {
        artifact_id: artifact.artifact_id,
        team_id: artifact.team_id,
        name: artifact.name,
        version: artifact.version,
        checksum: artifact.checksum,
        content: artifact.content,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    };
  });

  server.registerTool('team_artifact_list', 'team_artifact_list.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const guard = ensureTeam(server, teamId);
    if (!guard.ok) return guard;

    const artifacts = server.store.listArtifacts(teamId).map((artifact) => ({
      artifact_id: artifact.artifact_id,
      name: artifact.name,
      version: artifact.version,
      checksum: artifact.checksum,
      created_at: artifact.created_at,
      metadata: artifact.metadata
    }));

    return {
      ok: true,
      artifacts
    };
  });
}
