import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerGuardrailTools } from '../../mcp/server/tools/guardrails.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';

const dbPath = '.tmp/v3-106-security-int.sqlite';
const logPath = '.tmp/v3-106-security-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

test('V3-106 integration: secret leakage and command policy are enforced with security events', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArtifactTools(server);
  registerGuardrailTools(server);
  registerObservabilityTools(server);

  const started = server.callTool('team_start', { objective: 'security integration', profile: 'default' });
  const teamId = started.team.team_id as string;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' }).agent.agent_id as string;
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' }).agent.agent_id as string;

  const commandCheck = server.callTool('team_guardrail_check', {
    team_id: teamId,
    consensus_reached: false,
    open_tasks: 2,
    actor_role: 'implementer',
    mode: 'default',
    proposed_command: 'rm -rf /tmp/security-test'
  });
  assert.equal(commandCheck.ok, true);
  assert.equal(commandCheck.command_policy.allowed, false);

  const secretMessage = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: lead,
    to_agent_id: worker,
    summary: 'token=verysecretvalue12345',
    artifact_refs: [],
    idempotency_key: 'v3-106-secret-message'
  });
  assert.equal(secretMessage.ok, false);
  assert.match(String(secretMessage.error ?? ''), /secret-like content/);

  const secretArtifact = server.callTool('team_artifact_publish', {
    team_id: teamId,
    name: 'release-notes',
    content: 'Authorization: Bearer abcdefghijklmnop'
  });
  assert.equal(secretArtifact.ok, false);
  assert.match(String(secretArtifact.error ?? ''), /secret-like content/);

  const redactionCheck = server.callTool('team_guardrail_check', {
    team_id: teamId,
    consensus_reached: false,
    open_tasks: 1,
    actor_role: 'implementer',
    mode: 'default',
    proposed_command: 'echo api_key=1234567890abcdef'
  });
  assert.equal(redactionCheck.ok, true);

  const replay = server.callTool('team_replay', { team_id: teamId, limit: 200 });
  assert.equal(replay.ok, true);
  const securityEvent = replay.events.find((event: Record<string, unknown>) => event.event_type === 'security_policy_block');
  assert.ok(securityEvent);

  const guardrailToolEvent = replay.events.find((event: Record<string, unknown>) => {
    if (event.event_type !== 'tool_call:team_guardrail_check') return false;
    const payload = event.payload as Record<string, unknown>;
    const input = payload?.input as Record<string, unknown>;
    return input?.proposed_command === '[REDACTED_SECRET]';
  });
  assert.ok(guardrailToolEvent);

  server.store.close();
  cleanup();
});
