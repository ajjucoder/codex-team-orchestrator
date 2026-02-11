export interface TeamUpdateEvent {
  team_id: string;
  ticket_id: string;
  status: string;
  summary: string;
}

export interface OutboundSyncResult {
  ok: boolean;
  retryable: boolean;
  target: string;
  payload: Record<string, unknown> | null;
  error?: string;
}

function sanitizeText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

export function syncTeamUpdateToGitHub(event: TeamUpdateEvent, options: { simulate_failure?: boolean } = {}): OutboundSyncResult {
  if (options.simulate_failure) {
    return {
      ok: false,
      retryable: true,
      target: 'github',
      payload: null,
      error: 'transient github api failure'
    };
  }
  return {
    ok: true,
    retryable: false,
    target: 'github',
    payload: {
      issue_title: `[${event.ticket_id}] ${sanitizeText(event.summary)}`,
      state: event.status,
      labels: ['orchestrator', `team:${event.team_id}`]
    }
  };
}

export function mapGitHubInboundEvent(payload: Record<string, unknown>): { ok: boolean; task_patch?: Record<string, unknown>; error?: string } {
  const ticketId = typeof payload.ticket_id === 'string' ? payload.ticket_id : '';
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (!ticketId || !status) {
    return { ok: false, error: 'missing ticket_id or status' };
  }
  return {
    ok: true,
    task_patch: {
      ticket_id: ticketId,
      status,
      description: typeof payload.comment === 'string' ? sanitizeText(payload.comment) : ''
    }
  };
}
