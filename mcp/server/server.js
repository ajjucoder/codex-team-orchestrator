import { validateTool } from './contracts.js';

function nowIso() {
  return new Date().toISOString();
}

function authorizeContext(input, context) {
  const errors = [];
  if (context?.auth_team_id && input?.team_id && context.auth_team_id !== input.team_id) {
    errors.push(`forbidden team scope: ${input.team_id}`);
  }
  if (context?.auth_agent_id && input?.from_agent_id && context.auth_agent_id !== input.from_agent_id) {
    errors.push(`forbidden agent scope: ${input.from_agent_id}`);
  }
  return errors;
}

export class MCPServer {
  constructor({ store, logger }) {
    this.store = store;
    this.logger = logger;
    this.tools = new Map();
    this.startedAt = null;
  }

  start() {
    this.store.migrate();
    this.startedAt = nowIso();
    this.logger.log({
      event_type: 'server_started',
      payload: { started_at: this.startedAt }
    });
    return { ok: true, started_at: this.startedAt };
  }

  registerTool(name, schemaFileName, handler) {
    if (this.tools.has(name)) {
      throw new Error(`tool already registered: ${name}`);
    }
    this.tools.set(name, { schemaFileName, handler });
  }

  callTool(name, input, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }

    const authErrors = authorizeContext(input, context);
    if (authErrors.length > 0) {
      return {
        ok: false,
        errors: authErrors
      };
    }

    const validated = validateTool(tool.schemaFileName, input);
    if (!validated.ok) {
      return {
        ok: false,
        errors: validated.errors
      };
    }

    const result = tool.handler(input, context);
    const trace = {
      team_id: context.team_id ?? input.team_id ?? null,
      agent_id: context.agent_id ?? input.from_agent_id ?? null,
      task_id: context.task_id ?? null,
      message_id: context.message_id ?? null,
      artifact_id: context.artifact_id ?? null
    };

    this.store.logEvent({
      ...trace,
      event_type: `tool_call:${name}`,
      payload: {
        input: {
          ...input,
          summary: input.summary,
          artifact_refs: input.artifact_refs ?? []
        },
        ok: Boolean(result?.ok ?? true)
      }
    });

    this.logger.log({
      ...trace,
      event_type: `tool_call:${name}`,
      payload: { ok: Boolean(result?.ok ?? true) }
    });

    return result;
  }

  healthCheck() {
    let dbStatus = 'ok';
    let migrations = [];
    try {
      migrations = this.store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      this.store.db.prepare('SELECT 1 as ok').get();
    } catch {
      dbStatus = 'error';
    }

    const checks = {
      server_started: Boolean(this.startedAt),
      db_status: dbStatus,
      migration_count: migrations.length,
      max_threads_enforced: true,
      trace_logging_ready: true
    };

    const ok = checks.server_started && checks.db_status === 'ok' && checks.migration_count >= 1;
    return {
      ok,
      checked_at: nowIso(),
      checks
    };
  }
}
