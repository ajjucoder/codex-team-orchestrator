import type { TeamUpdateEvent, OutboundSyncResult } from './github.js';

function sanitize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function syncTeamUpdateToJira(event: TeamUpdateEvent, options: { simulate_failure?: boolean } = {}): OutboundSyncResult {
  if (options.simulate_failure) {
    return {
      ok: false,
      retryable: true,
      target: 'jira',
      payload: null,
      error: 'jira temporary outage'
    };
  }
  return {
    ok: true,
    retryable: false,
    target: 'jira',
    payload: {
      issue_key: event.ticket_id,
      transition: event.status,
      comment: sanitize(event.summary),
      labels: [`team-${event.team_id}`]
    }
  };
}

export function mapJiraInboundEvent(payload: Record<string, unknown>): { ok: boolean; task_patch?: Record<string, unknown>; error?: string } {
  const issueKey = typeof payload.issue_key === 'string' ? payload.issue_key : '';
  const transition = typeof payload.transition === 'string' ? payload.transition : '';
  if (!issueKey || !transition) {
    return { ok: false, error: 'missing issue_key or transition' };
  }
  return {
    ok: true,
    task_patch: {
      ticket_id: issueKey,
      status: transition,
      description: typeof payload.comment === 'string' ? sanitize(payload.comment) : ''
    }
  };
}
