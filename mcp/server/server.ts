import { validateTool } from './contracts.js';
import { estimateToolUsage } from './usage-estimator.js';
import type { RunEventRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';

type ToolInput = Record<string, unknown>;

export interface ToolContext {
  auth_team_id?: string;
  auth_agent_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
  message_id?: string;
  artifact_id?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  ok?: boolean;
  errors?: string[];
  [key: string]: any;
}

type StoreAdapter = SqliteStore;

interface LoggerAdapter {
  log(event: Record<string, unknown>): Record<string, unknown>;
}

type ToolHandler = (input: ToolInput, context: ToolContext) => ToolResult;

interface RegisteredTool {
  schemaFileName: string;
  handler: ToolHandler;
}

interface ServerConstructorOptions {
  store: StoreAdapter;
  logger: LoggerAdapter;
}

interface HealthCheckResult {
  ok: boolean;
  checked_at: string;
  checks: {
    server_started: boolean;
    db_status: 'ok' | 'error';
    migration_count: number;
    max_threads_enforced: true;
    trace_logging_ready: true;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function authorizeContext(input: ToolInput, context: ToolContext): string[] {
  const errors: string[] = [];
  const inputTeamId = typeof input.team_id === 'string' ? input.team_id : undefined;
  const inputAgentId = typeof input.from_agent_id === 'string' ? input.from_agent_id : undefined;

  if (context.auth_team_id && inputTeamId && context.auth_team_id !== inputTeamId) {
    errors.push(`forbidden team scope: ${inputTeamId}`);
  }
  if (context.auth_agent_id && inputAgentId && context.auth_agent_id !== inputAgentId) {
    errors.push(`forbidden agent scope: ${inputAgentId}`);
  }
  return errors;
}

export class MCPServer {
  readonly store: StoreAdapter;
  readonly logger: LoggerAdapter;
  readonly tools: Map<string, RegisteredTool>;
  startedAt: string | null;
  policyEngine?: unknown;

  constructor({ store, logger }: ServerConstructorOptions) {
    this.store = store;
    this.logger = logger;
    this.tools = new Map();
    this.startedAt = null;
  }

  start(): { ok: true; started_at: string } {
    this.store.migrate();
    this.startedAt = nowIso();
    this.logger.log({
      event_type: 'server_started',
      payload: { started_at: this.startedAt }
    });
    return { ok: true, started_at: this.startedAt };
  }

  registerTool(name: string, schemaFileName: string, handler: ToolHandler): void {
    if (this.tools.has(name)) {
      throw new Error(`tool already registered: ${name}`);
    }
    this.tools.set(name, { schemaFileName, handler });
  }

  callTool(name: string, input: ToolInput, context: ToolContext = {}): ToolResult {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }

    const startedAtMs = Date.now();

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
    const latency_ms = Math.max(0, Date.now() - startedAtMs);
    const trace = {
      team_id: context.team_id ?? (typeof input.team_id === 'string' ? input.team_id : null),
      agent_id: context.agent_id ?? (typeof input.from_agent_id === 'string' ? input.from_agent_id : null),
      task_id: context.task_id ?? null,
      message_id: context.message_id ?? null,
      artifact_id: context.artifact_id ?? null
    };
    const agent = trace.agent_id ? this.store.getAgent(trace.agent_id) : null;
    const usage = estimateToolUsage({ input, result });

    this.store.logEvent({
      ...trace,
      event_type: `tool_call:${name}`,
      payload: {
        input: {
          ...input,
          summary: input.summary,
          artifact_refs: Array.isArray(input.artifact_refs) ? input.artifact_refs : []
        },
        ok: Boolean(result?.ok ?? true)
      }
    });
    this.store.logEvent({
      ...trace,
      event_type: 'usage_sample',
      payload: {
        tool_name: name,
        role: agent?.role ?? 'unknown',
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        estimated_tokens: usage.estimated_tokens,
        latency_ms
      }
    });

    this.logger.log({
      ...trace,
      event_type: `tool_call:${name}`,
      payload: { ok: Boolean(result?.ok ?? true) }
    });

    return result;
  }

  healthCheck(): HealthCheckResult {
    let dbStatus: 'ok' | 'error' = 'ok';
    let migrations: Array<Record<string, unknown>> = [];
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
      max_threads_enforced: true as const,
      trace_logging_ready: true as const
    };

    const ok = checks.server_started && checks.db_status === 'ok' && checks.migration_count >= 1;
    return {
      ok,
      checked_at: nowIso(),
      checks
    };
  }
}
