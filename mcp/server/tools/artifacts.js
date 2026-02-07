import { newId } from '../ids.js';

const MAX_ARTIFACT_CONTENT_LENGTH = 200000;
const MAX_ARTIFACT_NAME_LENGTH = 256;

function ensureTeam(server, teamId) {
  const team = server.store.getTeam(teamId);
  if (!team) return { ok: false, error: `team not found: ${teamId}` };
  return { ok: true, team };
}

export function registerArtifactTools(server) {
  server.registerTool('team_artifact_publish', 'team_artifact_publish.schema.json', (input) => {
    const guard = ensureTeam(server, input.team_id);
    if (!guard.ok) return guard;

    if (input.name.length > MAX_ARTIFACT_NAME_LENGTH) {
      return { ok: false, error: `artifact name too long: max ${MAX_ARTIFACT_NAME_LENGTH}` };
    }
    if (input.content.length > MAX_ARTIFACT_CONTENT_LENGTH) {
      return { ok: false, error: `artifact content too large: max ${MAX_ARTIFACT_CONTENT_LENGTH}` };
    }

    if (input.published_by) {
      const agent = server.store.getAgent(input.published_by);
      if (!agent || agent.team_id !== input.team_id) {
        return { ok: false, error: `publisher agent not found in team: ${input.published_by}` };
      }
    }

    const artifactId = input.artifact_id ?? newId('artifact');
    const artifact = server.store.publishArtifact({
      artifact_id: artifactId,
      team_id: input.team_id,
      name: input.name,
      content: input.content,
      published_by: input.published_by ?? null,
      metadata: input.metadata ?? {}
    });

    server.store.logEvent({
      team_id: input.team_id,
      agent_id: input.published_by ?? null,
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
    const guard = ensureTeam(server, input.team_id);
    if (!guard.ok) return guard;

    const artifact = server.store.getArtifact(input.team_id, input.artifact_id, input.version ?? null);
    if (!artifact) {
      return { ok: false, error: `artifact not found: ${input.artifact_id}` };
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
    const guard = ensureTeam(server, input.team_id);
    if (!guard.ok) return guard;

    const artifacts = server.store.listArtifacts(input.team_id).map((artifact) => ({
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
