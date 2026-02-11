import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGuardrailMergeGate,
  evaluateMergeCoordinatorDecision,
  isIntegrationMergeProposal
} from '../../mcp/runtime/merge-coordinator.js';

test('V3-008 unit: integration merge requires reviewer and tester pass evidence', () => {
  const decision = evaluateMergeCoordinatorDecision({
    proposal_id: 'integration_patch_v1',
    votes: [
      { agent_id: 'agent_lead', role: 'lead', decision: 'approve' },
      { agent_id: 'agent_reviewer', role: 'reviewer', decision: 'approve' }
    ],
    arbitration: {
      strategy: 'lead',
      decision: 'approve',
      reason: 'lead decision applied',
      stats: { approve: 2, reject: 0, total: 2 }
    }
  });

  assert.equal(isIntegrationMergeProposal('integration_patch_v1'), true);
  assert.equal(decision.blocked, true);
  assert.equal(decision.action, 'block');
  assert.equal(decision.decision, 'reject');
  assert.deepEqual(decision.failed_gates, ['tester_pass_evidence']);
  assert.match(decision.reason, /tester_pass_evidence/);
});

test('V3-008 unit: failed quality gate blocks merge with traceable reason', () => {
  const decision = evaluateMergeCoordinatorDecision({
    proposal_id: 'integration_patch_v2',
    votes: [
      { agent_id: 'agent_reviewer', role: 'reviewer', decision: 'approve' },
      { agent_id: 'agent_tester', role: 'tester', decision: 'approve' }
    ],
    arbitration: {
      strategy: 'consensus',
      decision: 'reject',
      reason: 'consensus requires unanimous approval',
      stats: { approve: 2, reject: 1, total: 3 }
    }
  });

  assert.equal(decision.blocked, true);
  assert.equal(decision.action, 'block');
  assert.equal(decision.decision, 'reject');
  assert.deepEqual(decision.failed_gates, ['arbitration_approval']);
  assert.match(decision.reason, /arbitration_approval/);
  assert.match(decision.reason, /consensus requires unanimous approval/);
});

test('V3-008 unit: conflict handling is deterministic retry then escalation', () => {
  const first = evaluateMergeCoordinatorDecision({
    proposal_id: 'integration_conflict_1',
    votes: [
      { agent_id: 'agent_reviewer_a', role: 'reviewer', decision: 'approve' },
      { agent_id: 'agent_reviewer_b', role: 'reviewer', decision: 'reject' },
      { agent_id: 'agent_tester', role: 'tester', decision: 'approve' }
    ],
    arbitration: {
      strategy: 'strict_vote',
      decision: 'approve',
      reason: 'strict vote threshold met (>= 2/3 approvals with >= 3 votes)',
      stats: { approve: 2, reject: 1, total: 3 }
    },
    conflict_retry_limit: 1
  });

  assert.equal(first.blocked, true);
  assert.equal(first.action, 'retry');
  assert.equal(first.conflict.retry_attempt, 1);
  assert.equal(first.conflict.next_action, 'retry');

  const second = evaluateMergeCoordinatorDecision({
    proposal_id: 'integration_conflict_1',
    votes: [
      { agent_id: 'agent_reviewer_a', role: 'reviewer', decision: 'approve' },
      { agent_id: 'agent_reviewer_b', role: 'reviewer', decision: 'reject' },
      { agent_id: 'agent_tester', role: 'tester', decision: 'approve' }
    ],
    arbitration: {
      strategy: 'strict_vote',
      decision: 'approve',
      reason: 'strict vote threshold met (>= 2/3 approvals with >= 3 votes)',
      stats: { approve: 2, reject: 1, total: 3 }
    },
    conflict_retry_limit: 1,
    prior_events: [
      {
        event_type: 'merge_gate_decision',
        payload: {
          proposal_id: 'integration_conflict_1',
          conflict: { detected: true },
          outcome: { action: 'retry' }
        }
      }
    ]
  });

  assert.equal(second.blocked, true);
  assert.equal(second.action, 'escalate');
  assert.equal(second.conflict.retry_attempt, 2);
  assert.equal(second.conflict.next_action, 'escalate');
});

test('V3-008 unit: guardrail merge gate emits structured decision contract', () => {
  const gate = evaluateGuardrailMergeGate({
    team_id: 'team_guardrail_v3_008',
    consensus_reached: true,
    open_tasks: 0,
    early_stop_should_stop: true,
    early_stop_reason: 'consensus reached with no open tasks'
  });

  assert.equal(gate.gate.passed, true);
  assert.equal(gate.event_payload.gate.gate_id, 'merge_readiness_consensus');
});
