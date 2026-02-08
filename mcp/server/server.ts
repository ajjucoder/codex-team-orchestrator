import { validateTool } from './contracts.js';
import { estimateToolUsage } from './usage-estimator.js';
import { evaluatePermissionDecision, type PermissionDecision } from './permission-profiles.js';
import { evaluateModeDecision } from './mode-policy.js';
import type { HookContext, HookDispatchResult, HookEngine } from './hooks.js';
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

interface PolicyEngineAdapter {
  resolveTeamPolicy(team: { profile?: string | null } | null | undefined): Record<string, unknown>;
}

interface PermissionAudit extends PermissionDecision {
  evaluated: boolean;
  actor_agent_id: string | null;
  actor_role: string | null;
  team_id: string | null;
  action: string | null;
}

interface ModeAudit {
  allowed: boolean;
  mode: string;
  matched_rule: string;
  deny_reason: string | null;
  evaluated: boolean;
  team_id: string | null;
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

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function derivePermissionAction(toolName: string, input: ToolInput, context: ToolContext): string | null {
  const fromContext = pickString(context.permission_action);
  if (fromContext) return fromContext;
  const fromInput = pickString(input.action);
  if (fromInput) return fromInput;
  if (toolName === 'team_task_update') {
    const status = pickString(input.status);
    if (status) {
      return `status:${status}`;
    }
  }
  return null;
}

function resolveActorAgentId(input: ToolInput, context: ToolContext): string | null {
  return pickString(context.auth_agent_id)
    ?? pickString(input.from_agent_id);
}

function resolveTeamId(input: ToolInput, context: ToolContext): string | null {
  return pickString(input.team_id) ?? pickString(context.team_id);
}

function deriveHookEvent(toolName: string, input: ToolInput): string | null {
  if (toolName === 'team_spawn') return 'spawn';
  if (toolName === 'team_task_claim') return 'task_claim';
  if (toolName === 'team_task_update') {
    const status = pickString(input.status);
    if (status === 'done') return 'task_complete';
    return null;
  }
  if (toolName === 'team_finalize') return 'finalize';
  if (toolName === 'team_resume') return 'resume';
  return null;
}

function authorizeContext(input: ToolInput, context: ToolContext): string[] {
  const errors: string[] = [];
  const inputTeamId = pickString(input.team_id) ?? undefined;
  const inputAgentId = pickString(input.from_agent_id) ?? undefined;

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
  hookEngine?: HookEngine;

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

  private resolvePermissionAudit(name: string, input: ToolInput, context: ToolContext): PermissionAudit {
    const actorAgentId = resolveActorAgentId(input, context);
    const action = derivePermissionAction(name, input, context);
    if (!actorAgentId) {
      return {
        allowed: true,
        source_profile: null,
        matched_rule: 'no_actor_default_allow',
        deny_reason: null,
        evaluated: false,
        actor_agent_id: null,
        actor_role: null,
        team_id: resolveTeamId(input, context),
        action
      };
    }

    const actor = this.store.getAgent(actorAgentId);
    if (!actor) {
      return {
        allowed: false,
        source_profile: null,
        matched_rule: 'actor_not_found',
        deny_reason: `actor agent not found: ${actorAgentId}`,
        evaluated: true,
        actor_agent_id: actorAgentId,
        actor_role: null,
        team_id: resolveTeamId(input, context),
        action
      };
    }

    const teamId = resolveTeamId(input, context) ?? actor.team_id;
    if (actor.team_id !== teamId) {
      const scopeLabel = pickString(input.from_agent_id) ? 'from_agent' : 'agent';
      return {
        allowed: false,
        source_profile: null,
        matched_rule: 'cross_team_agent_scope',
        deny_reason: `${scopeLabel} not in team ${teamId}: ${actorAgentId}`,
        evaluated: true,
        actor_agent_id: actorAgentId,
        actor_role: actor.role,
        team_id: teamId,
        action
      };
    }

    const team = this.store.getTeam(teamId);
    if (!team) {
      return {
        allowed: false,
        source_profile: null,
        matched_rule: 'team_not_found',
        deny_reason: `team not found: ${teamId}`,
        evaluated: true,
        actor_agent_id: actorAgentId,
        actor_role: actor.role,
        team_id: teamId,
        action
      };
    }

    const policyEngine = this.policyEngine as PolicyEngineAdapter | undefined;
    if (!policyEngine || typeof policyEngine.resolveTeamPolicy !== 'function') {
      return {
        allowed: true,
        source_profile: null,
        matched_rule: 'policy_engine_missing_default_allow',
        deny_reason: null,
        evaluated: true,
        actor_agent_id: actorAgentId,
        actor_role: actor.role,
        team_id: teamId,
        action
      };
    }

    const policy = policyEngine.resolveTeamPolicy(team) ?? {};
    const profileHint = pickString(actor.metadata.permission_profile);
    const decision = evaluatePermissionDecision({
      policy,
      role: actor.role,
      tool_name: name,
      action,
      profile_name_hint: profileHint
    });
    return {
      ...decision,
      evaluated: true,
      actor_agent_id: actorAgentId,
      actor_role: actor.role,
      team_id: teamId,
      action
    };
  }

  private resolveModeAudit(name: string, input: ToolInput, context: ToolContext, permission: PermissionAudit): ModeAudit {
    const teamId = resolveTeamId(input, context) ?? permission.team_id;
    if (!teamId) {
      return {
        allowed: true,
        mode: 'default',
        matched_rule: 'no_team_context_allow',
        deny_reason: null,
        evaluated: false,
        team_id: null
      };
    }

    const team = this.store.getTeam(teamId);
    if (!team) {
      return {
        allowed: true,
        mode: 'default',
        matched_rule: 'team_not_found_mode_bypass',
        deny_reason: null,
        evaluated: false,
        team_id: teamId
      };
    }

    const decision = evaluateModeDecision({
      mode: team.mode,
      tool_name: name,
      actor_role: permission.actor_role
    });
    return {
      ...decision,
      evaluated: true,
      team_id: teamId
    };
  }

  private dispatchHooks(phase: 'pre' | 'post', hookContext: HookContext): HookDispatchResult {
    if (!this.hookEngine) {
      return {
        ok: true,
        blocked_by: null,
        deny_reason: null,
        traces: []
      };
    }
    return this.hookEngine.dispatch(phase, hookContext);
  }

  callTool(name: string, input: ToolInput, context: ToolContext = {}): ToolResult {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }

    const startedAtMs = Date.now();
    const permission = this.resolvePermissionAudit(name, input, context);
    const mode = this.resolveModeAudit(name, input, context, permission);
    const hookEvent = deriveHookEvent(name, input);
    const hookContext: HookContext = {
      event: hookEvent ?? 'none',
      tool_name: name,
      input,
      context,
      result: null
    };
    const preHook = hookEvent
      ? this.dispatchHooks('pre', hookContext)
      : {
        ok: true,
        blocked_by: null,
        deny_reason: null,
        traces: []
      };
    let result: ToolResult;

    const authErrors = authorizeContext(input, context);
    if (authErrors.length > 0) {
      result = {
        ok: false,
        errors: authErrors
      };
    } else {
      const validated = validateTool(tool.schemaFileName, input);
      if (!validated.ok) {
        result = {
          ok: false,
          errors: validated.errors
        };
      } else if (!permission.allowed) {
        const denyReason = permission.deny_reason ?? `permission denied for ${name}`;
        result = {
          ok: false,
          error: denyReason,
          errors: [denyReason]
        };
      } else if (!mode.allowed) {
        const denyReason = mode.deny_reason ?? `mode ${mode.mode} denies ${name}`;
        result = {
          ok: false,
          error: denyReason,
          errors: [denyReason]
        };
      } else if (!preHook.ok) {
        const denyReason = preHook.deny_reason ?? `hook blocked ${name}`;
        result = {
          ok: false,
          error: denyReason,
          errors: [denyReason],
          hook: {
            event: hookEvent,
            phase: 'pre',
            blocked_by: preHook.blocked_by,
            traces: preHook.traces
          }
        };
      } else {
        result = tool.handler(input, context);
      }
    }

    const postHook = hookEvent
      ? this.dispatchHooks('post', {
        ...hookContext,
        result
      })
      : {
        ok: true,
        blocked_by: null,
        deny_reason: null,
        traces: []
      };

    const latency_ms = Math.max(0, Date.now() - startedAtMs);
    const trace = {
      team_id: context.team_id ?? permission.team_id ?? (typeof input.team_id === 'string' ? input.team_id : null),
      agent_id: context.agent_id ?? permission.actor_agent_id ?? (typeof input.from_agent_id === 'string' ? input.from_agent_id : null),
      task_id: context.task_id ?? null,
      message_id: context.message_id ?? null,
      artifact_id: context.artifact_id ?? null
    };
    const agent = trace.agent_id ? this.store.getAgent(trace.agent_id) : null;
    const usage = estimateToolUsage({ input, result });

    this.store.logEvent({
      ...trace,
      event_type: `permission_decision:${name}`,
      payload: {
        allowed: permission.allowed,
        evaluated: permission.evaluated,
        source_profile: permission.source_profile,
        matched_rule: permission.matched_rule,
        deny_reason: permission.deny_reason,
        action: permission.action,
        actor_agent_id: permission.actor_agent_id,
        actor_role: permission.actor_role
      }
    });
    this.store.logEvent({
      ...trace,
      event_type: `mode_decision:${name}`,
      payload: {
        allowed: mode.allowed,
        mode: mode.mode,
        matched_rule: mode.matched_rule,
        deny_reason: mode.deny_reason,
        evaluated: mode.evaluated
      }
    });
    if (hookEvent) {
      this.store.logEvent({
        ...trace,
        event_type: `hook_pre:${hookEvent}`,
        payload: {
          ok: preHook.ok,
          blocked_by: preHook.blocked_by,
          deny_reason: preHook.deny_reason,
          traces: preHook.traces
        }
      });
      this.store.logEvent({
        ...trace,
        event_type: `hook_post:${hookEvent}`,
        payload: {
          ok: postHook.ok,
          traces: postHook.traces
        }
      });
    }
    this.store.logEvent({
      ...trace,
      event_type: `tool_call:${name}`,
      payload: {
        input: {
          ...input,
          summary: input.summary,
          artifact_refs: Array.isArray(input.artifact_refs) ? input.artifact_refs : []
        },
        ok: Boolean(result?.ok ?? true),
        permission: {
          allowed: permission.allowed,
          source_profile: permission.source_profile,
          matched_rule: permission.matched_rule,
          deny_reason: permission.deny_reason,
          action: permission.action
        },
        mode: {
          allowed: mode.allowed,
          mode: mode.mode,
          matched_rule: mode.matched_rule,
          deny_reason: mode.deny_reason
        },
        hooks: {
          event: hookEvent,
          pre: {
            ok: preHook.ok,
            blocked_by: preHook.blocked_by,
            deny_reason: preHook.deny_reason
          },
          post: {
            ok: postHook.ok
          }
        }
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
      event_type: `permission_decision:${name}`,
      payload: {
        allowed: permission.allowed,
        evaluated: permission.evaluated,
        source_profile: permission.source_profile,
        matched_rule: permission.matched_rule,
        deny_reason: permission.deny_reason,
        action: permission.action,
        actor_agent_id: permission.actor_agent_id,
        actor_role: permission.actor_role
      }
    });
    this.logger.log({
      ...trace,
      event_type: `mode_decision:${name}`,
      payload: {
        allowed: mode.allowed,
        mode: mode.mode,
        matched_rule: mode.matched_rule,
        deny_reason: mode.deny_reason,
        evaluated: mode.evaluated
      }
    });
    if (hookEvent) {
      this.logger.log({
        ...trace,
        event_type: `hook_pre:${hookEvent}`,
        payload: {
          ok: preHook.ok,
          blocked_by: preHook.blocked_by,
          deny_reason: preHook.deny_reason,
          traces: preHook.traces
        }
      });
      this.logger.log({
        ...trace,
        event_type: `hook_post:${hookEvent}`,
        payload: {
          ok: postHook.ok,
          traces: postHook.traces
        }
      });
    }
    this.logger.log({
      ...trace,
      event_type: `tool_call:${name}`,
      payload: {
        ok: Boolean(result?.ok ?? true),
        permission: {
          allowed: permission.allowed,
          source_profile: permission.source_profile,
          matched_rule: permission.matched_rule,
          deny_reason: permission.deny_reason,
          action: permission.action
        },
        mode: {
          allowed: mode.allowed,
          mode: mode.mode,
          matched_rule: mode.matched_rule,
          deny_reason: mode.deny_reason
        },
        hooks: {
          event: hookEvent,
          pre: {
            ok: preHook.ok,
            blocked_by: preHook.blocked_by,
            deny_reason: preHook.deny_reason
          },
          post: {
            ok: postHook.ok
          }
        }
      }
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
