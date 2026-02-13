import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v4-009-model-routing-compat-int.sqlite';
const logPath = '.tmp/v4-009-model-routing-compat-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-009 integration: model routing remains compatible while additive backend routing is honored', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });

  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerAgentLifecycleTools(server);
    registerObservabilityTools(server);

    server.policyEngine.cache.set('v4-009-routing', {
      profile: 'v4-009-routing',
      limits: { default_max_threads: 4, hard_max_threads: 6 },
      model_routing: {
        enabled: true,
        mode: 'role_map',
        default_model: 'gpt-4o-mini',
        role_models: {
          reviewer: 'gpt-4o',
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
      objective: 'routing compatibility integration',
      profile: 'v4-009-routing'
    }, {
      active_session_model: 'gpt-5-codex'
    });
    assert.equal(started.ok, true);
    const teamId = String(started.team.team_id);

    const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
    const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
    const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });
    assert.equal(reviewer.ok, true);
    assert.equal(implementer.ok, true);
    assert.equal(tester.ok, true);

    assert.equal(reviewer.agent.model, 'gpt-4o');
    assert.equal(implementer.agent.model, 'gpt-5');
    assert.equal(tester.agent.model, 'gpt-4o-mini');
    assert.equal(reviewer.agent.metadata.model_source, 'policy_role_route');
    assert.equal(implementer.agent.metadata.model_source, 'policy_role_route');
    assert.equal(tester.agent.metadata.model_source, 'policy_default_route');
    assert.equal(reviewer.agent.metadata.backend, 'claude');
    assert.equal(implementer.agent.metadata.backend, 'opencode');
    assert.equal(tester.agent.metadata.backend, 'codex');
    assert.equal(reviewer.routing.backend_source, 'policy_role_backend');
    assert.equal(tester.routing.backend_source, 'policy_default_backend');

    const explicit = server.callTool('team_spawn', {
      team_id: teamId,
      role: 'reviewer',
      backend: 'codex'
    });
    assert.equal(explicit.ok, true);
    assert.equal(explicit.agent.metadata.backend, 'codex');
    assert.equal(explicit.agent.metadata.backend_source, 'explicit_input');
    assert.equal(explicit.agent.metadata.backend_routing_applied, false);

    const staffPlan = server.callTool('team_staff_plan', {
      team_id: teamId
    });
    assert.equal(staffPlan.ok, true);
    assert.equal(typeof staffPlan.plan.model_routing.default_backend, 'string');
    assert.equal(typeof staffPlan.plan.model_routing.role_backends, 'object');
    assert.equal(
      Object.keys(staffPlan.plan.model_routing.role_backends).length >= 1,
      true
    );
  } finally {
    server.store.close();
  }
});
