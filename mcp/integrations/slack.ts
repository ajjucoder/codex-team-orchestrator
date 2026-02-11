import type { TeamUpdateEvent, OutboundSyncResult } from './github.js';

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function syncTeamUpdateToSlack(event: TeamUpdateEvent, options: { simulate_failure?: boolean } = {}): OutboundSyncResult {
  if (options.simulate_failure) {
    return {
      ok: false,
      retryable: true,
      target: 'slack',
      payload: null,
      error: 'slack rate limit'
    };
  }
  return {
    ok: true,
    retryable: false,
    target: 'slack',
    payload: {
      channel: `team-${event.team_id}`,
      text: `[${event.ticket_id}] ${event.status} - ${compact(event.summary)}`
    }
  };
}

export function mapSlackInboundEvent(payload: Record<string, unknown>): { ok: boolean; task_patch?: Record<string, unknown>; error?: string } {
  const ticketId = typeof payload.ticket_id === 'string' ? payload.ticket_id : '';
  const command = typeof payload.command === 'string' ? payload.command : '';
  if (!ticketId || !command) {
    return { ok: false, error: 'missing ticket_id or command' };
  }
  return {
    ok: true,
    task_patch: {
      ticket_id: ticketId,
      status: command === 'retry' ? 'todo' : command,
      description: typeof payload.note === 'string' ? compact(payload.note) : ''
    }
  };
}
