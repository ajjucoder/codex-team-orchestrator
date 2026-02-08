import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateModeDecision } from '../../mcp/server/mode-policy.js';

test('V2-006 mode policy matrix enforces default/delegate/plan semantics', () => {
  const defaultSpawn = evaluateModeDecision({
    mode: 'default',
    tool_name: 'team_spawn',
    actor_role: 'lead'
  });
  assert.equal(defaultSpawn.allowed, true);

  const planSpawn = evaluateModeDecision({
    mode: 'plan',
    tool_name: 'team_spawn',
    actor_role: 'lead'
  });
  assert.equal(planSpawn.allowed, false);
  assert.match(String(planSpawn.deny_reason ?? ''), /plan mode blocks execution tool team_spawn/);

  const delegateLeadClaim = evaluateModeDecision({
    mode: 'delegate',
    tool_name: 'team_task_claim',
    actor_role: 'lead'
  });
  assert.equal(delegateLeadClaim.allowed, false);
  assert.match(String(delegateLeadClaim.deny_reason ?? ''), /delegate mode blocks lead/);

  const delegateImplementerClaim = evaluateModeDecision({
    mode: 'delegate',
    tool_name: 'team_task_claim',
    actor_role: 'implementer'
  });
  assert.equal(delegateImplementerClaim.allowed, true);
});
