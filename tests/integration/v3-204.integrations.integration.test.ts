import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTeamUpdateToGitHub, mapGitHubInboundEvent } from '../../mcp/integrations/github.js';
import { syncTeamUpdateToJira, mapJiraInboundEvent } from '../../mcp/integrations/jira.js';
import { syncTeamUpdateToSlack, mapSlackInboundEvent } from '../../mcp/integrations/slack.js';

test('V3-204 integration: outbound integrations sync updates with isolated retryable failures', () => {
  const event = {
    team_id: 'team_integrations',
    ticket_id: 'CTO-P2-004',
    status: 'in_progress',
    summary: 'sync integration bridge update'
  };

  const github = syncTeamUpdateToGitHub(event);
  const jira = syncTeamUpdateToJira(event, { simulate_failure: true });
  const slack = syncTeamUpdateToSlack(event);

  assert.equal(github.ok, true);
  assert.equal(slack.ok, true);
  assert.equal(jira.ok, false);
  assert.equal(jira.retryable, true);
  assert.equal(typeof github.payload, 'object');
  assert.equal(typeof slack.payload, 'object');
});

test('V3-204 integration: inbound integration payloads are validated and converted to safe task patches', () => {
  const githubInbound = mapGitHubInboundEvent({
    ticket_id: 'CTO-P2-004',
    status: 'blocked',
    comment: 'waiting on dependency'
  });
  assert.equal(githubInbound.ok, true);
  assert.equal(githubInbound.task_patch?.ticket_id, 'CTO-P2-004');

  const jiraInbound = mapJiraInboundEvent({
    issue_key: 'CTO-P2-004',
    transition: 'done',
    comment: 'resolved'
  });
  assert.equal(jiraInbound.ok, true);
  assert.equal(jiraInbound.task_patch?.status, 'done');

  const slackInbound = mapSlackInboundEvent({
    ticket_id: 'CTO-P2-004',
    command: 'retry',
    note: 'rerun pipeline'
  });
  assert.equal(slackInbound.ok, true);
  assert.equal(slackInbound.task_patch?.status, 'todo');
});
