import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v4-010-model-routing-compat-unit.sqlite';
const logPath = '.tmp/v4-010-model-routing-compat-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-010 unit: legacy model_routing keys remain supported without backend keys', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  server.policyEngine.cache.set('legacy-routing', {
    profile: 'legacy-routing',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    model_routing: {
      enabled: true,
      mode: 'role_map',
      default_model: 'gpt-4o-mini',
      role_models: {
        reviewer: 'gpt-4o'
      }
    }
  });

  const started = server.callTool('team_start', {
    objective: 'legacy routing unit',
    profile: 'legacy-routing'
  }, {
    active_session_model: 'gpt-5-codex'
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });
  assert.equal(reviewer.ok, true);
  assert.equal(tester.ok, true);
  assert.equal(reviewer.agent.model, 'gpt-4o');
  assert.equal(tester.agent.model, 'gpt-4o-mini');
  assert.equal(reviewer.agent.metadata.model_routing_applied, true);
  assert.equal(tester.agent.metadata.model_routing_applied, true);
  assert.equal(reviewer.agent.metadata.backend, null);
  assert.equal(tester.agent.metadata.backend, null);
  assert.equal(reviewer.agent.metadata.backend_routing_applied, false);
  assert.equal(tester.agent.metadata.backend_routing_applied, false);

  server.store.close();
});

test('V4-010 unit: additive backend routing keys apply role/default backends with explicit override precedence', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  server.policyEngine.cache.set('backend-routing', {
    profile: 'backend-routing',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    model_routing: {
      enabled: true,
      mode: 'role_map',
      default_model: 'gpt-4o-mini',
      role_models: {
        implementer: 'gpt-5'
      },
      default_backend: 'codex',
      role_backends: {
        reviewer: 'claude',
        implementer: 'opencode'
      }
    }
  });

  const started = server.callTool('team_start', {
    objective: 'backend routing unit',
    profile: 'backend-routing'
  }, {
    active_session_model: 'gpt-5-codex'
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });
  const explicit = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer',
    model: 'gpt-4.1',
    backend: 'codex'
  });

  assert.equal(reviewer.ok, true);
  assert.equal(implementer.ok, true);
  assert.equal(tester.ok, true);
  assert.equal(explicit.ok, true);

  assert.equal(reviewer.agent.metadata.backend, 'claude');
  assert.equal(reviewer.agent.metadata.backend_source, 'policy_role_backend');
  assert.equal(reviewer.agent.metadata.backend_routing_applied, true);

  assert.equal(implementer.agent.metadata.backend, 'opencode');
  assert.equal(implementer.agent.metadata.backend_source, 'policy_role_backend');
  assert.equal(implementer.agent.metadata.backend_routing_applied, true);
  assert.equal(implementer.agent.model, 'gpt-5');
  assert.equal(implementer.agent.metadata.model_source, 'policy_role_route');

  assert.equal(tester.agent.metadata.backend, 'codex');
  assert.equal(tester.agent.metadata.backend_source, 'policy_default_backend');
  assert.equal(tester.agent.metadata.backend_routing_applied, true);
  assert.equal(tester.agent.model, 'gpt-4o-mini');
  assert.equal(tester.agent.metadata.model_source, 'policy_default_route');

  assert.equal(explicit.agent.model, 'gpt-4.1');
  assert.equal(explicit.agent.metadata.model_source, 'explicit_input');
  assert.equal(explicit.agent.metadata.model_routing_applied, false);
  assert.equal(explicit.agent.metadata.backend, 'codex');
  assert.equal(explicit.agent.metadata.backend_source, 'explicit_input');
  assert.equal(explicit.agent.metadata.backend_routing_applied, false);

  server.store.close();
});
