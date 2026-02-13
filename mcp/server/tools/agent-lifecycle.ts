import type { ToolResult, ToolServerLike } from './types.js';
import { newId } from '../ids.js';
import { isKnownRole } from '../role-pack.js';
import { resolvePermissionProfileName } from '../permission-profiles.js';
import { scanForSecrets } from '../guardrails.js';
import { resolveMentionRecipients } from '../mention-parser.js';
import type { AgentRecord, ArtifactRef, MessageRecord, TeamRecord } from '../../store/entities.js';
import type {
  WorkerAdapter,
  WorkerCollectArtifactsResult,
  WorkerPollResult,
  WorkerSendInstructionResult
} from '../../runtime/worker-adapter.js';
import { RuntimeGitIsolationManager } from '../../runtime/git-manager.js';

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_SUMMARY_LENGTH = 5000;
const MAX_ARTIFACT_REFS = 50;
const DUPLICATE_SUPPRESS_WINDOW_MS = 120000;

interface TeamLookup {
  team?: TeamRecord;
  error?: string;
}

interface AgentLookup {
  agent?: AgentRecord;
  error?: string;
}

interface AgentMembershipResult extends ToolResult {
  ok: boolean;
  error?: string;
}

interface PayloadValidationResult extends ToolResult {
  ok: boolean;
  error?: string;
}

interface GuardrailPolicy {
  guardrails?: {
    block_secret_leakage?: unknown;
  };
}

interface SpawnModelResolution {
  model: string | null;
  model_source: string;
  model_routing_applied: boolean;
  inherited_model: boolean;
}

interface DuplicateResponse extends ToolResult {
  ok: true;
  inserted: false;
  duplicate_suppressed: true;
  message: {
    message_id: string;
    team_id: string;
    from_agent_id: string;
    to_agent_id: string | null;
    delivery_mode: 'direct' | 'broadcast' | 'group';
    idempotency_key: string;
    payload: Record<string, unknown>;
  };
  recipient_count?: number | null;
}

interface AgentLifecycleToolOptions {
  workerAdapter?: WorkerAdapter;
  gitManager?: RuntimeGitIsolationManager;
}

interface WorkerSessionBinding {
  worker_id: string;
  provider: string;
}

interface WorkerAdapterResolution {
  adapter: WorkerAdapter | null;
  invalid_source: 'options' | 'server' | null;
}

type WorkerAdapterOperation =
  | 'spawn'
  | 'send_instruction'
  | 'poll'
  | 'interrupt'
  | 'collect_artifacts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | null {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : null;
}

function readNumberList(input: Record<string, unknown>, key: string): number[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function readStringList(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readArtifactRefs(input: Record<string, unknown>): ArtifactRef[] {
  if (!Array.isArray(input.artifact_refs)) return [];
  return normalizeArtifactRefs(input.artifact_refs);
}

function getTeamOrError(server: ToolServerLike, teamId: string): TeamLookup {
  const team = server.store.getTeam(teamId);
  if (!team) {
    return { error: `team not found: ${teamId}` };
  }
  return { team };
}

function getAgentOrError(server: ToolServerLike, agentId: string): AgentLookup {
  const agent = server.store.getAgent(agentId);
  if (!agent) {
    return { error: `agent not found: ${agentId}` };
  }
  return { agent };
}

function ensureAgentInTeam(agent: AgentRecord, teamId: string, label: string): AgentMembershipResult {
  if (agent.team_id !== teamId) {
    return { ok: false, error: `${label} not in team ${teamId}: ${agent.agent_id}` };
  }
  return { ok: true };
}

function shouldBlockSecretLeakage(policy: GuardrailPolicy | null | undefined): boolean {
  const guardrails = policy?.guardrails;
  if (!guardrails || typeof guardrails !== 'object') return true;
  return guardrails.block_secret_leakage !== false;
}

function validateMessagePayload(
  summary: string,
  artifactRefs: ArtifactRef[],
  policy: GuardrailPolicy | null | undefined
): PayloadValidationResult {
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: `summary too long: max ${MAX_SUMMARY_LENGTH}` };
  }
  if (artifactRefs.length > MAX_ARTIFACT_REFS) {
    return { ok: false, error: `too many artifact refs: max ${MAX_ARTIFACT_REFS}` };
  }
  if (shouldBlockSecretLeakage(policy)) {
    const secretScan = scanForSecrets(summary);
    if (secretScan.matched) {
      return {
        ok: false,
        error: `summary contains secret-like content (${secretScan.matched_rule})`
      };
    }
  }
  return { ok: true };
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSpawnModel({
  inputModel,
  team,
  role,
  policy
}: {
  inputModel: unknown;
  team: TeamRecord;
  role: string;
  policy: Record<string, unknown>;
}): SpawnModelResolution {
  const explicit = pickString(inputModel);
  if (explicit) {
    return {
      model: explicit,
      model_source: 'explicit_input',
      model_routing_applied: false,
      inherited_model: false
    };
  }

  const modelRouting = (
    policy.model_routing && typeof policy.model_routing === 'object'
      ? policy.model_routing as Record<string, unknown>
      : {}
  );
  if (modelRouting.enabled === true) {
    const roleModels = (
      modelRouting.role_models && typeof modelRouting.role_models === 'object'
        ? modelRouting.role_models as Record<string, unknown>
        : {}
    );
    const roleModel = pickString(roleModels[role]);
    const defaultModel = pickString(modelRouting.default_model);
    const routedModel = roleModel ?? defaultModel;
    if (routedModel) {
      return {
        model: routedModel,
        model_source: roleModel ? 'policy_role_route' : 'policy_default_route',
        model_routing_applied: true,
        inherited_model: false
      };
    }
  }

  return {
    model: team.session_model ?? null,
    model_source: 'session_inherited',
    model_routing_applied: false,
    inherited_model: true
  };
}

function normalizeArtifactRefs(artifactRefs: unknown[] = []): ArtifactRef[] {
  return artifactRefs
    .filter(isRecord)
    .map((ref) => ({
      artifact_id: String(ref.artifact_id ?? ''),
      version: Number(ref.version)
    }))
    .filter((ref) => ref.artifact_id.length > 0 && Number.isFinite(ref.version))
    .sort((a, b) => {
      const aid = a.artifact_id.localeCompare(b.artifact_id);
      if (aid !== 0) return aid;
      return a.version - b.version;
    });
}

function artifactRefKey(ref: ArtifactRef): string {
  return `${ref.artifact_id}@${ref.version}`;
}

function diffArtifactRefs(currentRefs: ArtifactRef[] = [], previousRefs: ArtifactRef[] = []): ArtifactRef[] {
  const previousKeys = new Set(previousRefs.map(artifactRefKey));
  return currentRefs.filter((ref) => !previousKeys.has(artifactRefKey(ref)));
}

function duplicateResponse(
  existingMessage: MessageRecord,
  mode: 'direct' | 'broadcast' | 'group'
): DuplicateResponse {
  const base: DuplicateResponse = {
    ok: true,
    inserted: false,
    duplicate_suppressed: true,
    message: {
      message_id: existingMessage.message_id,
      team_id: existingMessage.team_id,
      from_agent_id: existingMessage.from_agent_id,
      to_agent_id: existingMessage.to_agent_id,
      delivery_mode: existingMessage.delivery_mode,
      idempotency_key: existingMessage.idempotency_key,
      payload: existingMessage.payload as unknown as Record<string, unknown>
    }
  };
  if (mode === 'broadcast') {
    base.recipient_count = null;
  }
  return base;
}

function recipientCountExcludingSender(server: ToolServerLike, teamId: string, senderAgentId: string): number {
  return server
    .store
    .listAgentsByTeam(teamId)
    .filter((agent) => agent.agent_id !== senderAgentId)
    .length;
}

function isWorkerAdapterCandidate(value: unknown): value is WorkerAdapter {
  if (!isRecord(value)) return false;
  return (
    typeof value.spawn === 'function' &&
    typeof value.sendInstruction === 'function' &&
    typeof value.poll === 'function' &&
    typeof value.interrupt === 'function' &&
    typeof value.collectArtifacts === 'function'
  );
}

function resolveWorkerAdapter(server: ToolServerLike, options: AgentLifecycleToolOptions): WorkerAdapterResolution {
  if (options.workerAdapter !== undefined) {
    if (isWorkerAdapterCandidate(options.workerAdapter)) {
      return {
        adapter: options.workerAdapter,
        invalid_source: null
      };
    }
    return {
      adapter: null,
      invalid_source: 'options'
    };
  }

  const fromServer = server.workerAdapter;
  if (fromServer === undefined) {
    return {
      adapter: null,
      invalid_source: null
    };
  }
  if (isWorkerAdapterCandidate(fromServer)) {
    return {
      adapter: fromServer,
      invalid_source: null
    };
  }
  return {
    adapter: null,
    invalid_source: 'server'
  };
}

function resolveGitIsolationManager(server: ToolServerLike, options: AgentLifecycleToolOptions): RuntimeGitIsolationManager {
  if (options.gitManager) {
    return options.gitManager;
  }

  const fromServer = server.gitManager;
  if (fromServer) {
    return fromServer;
  }

  return new RuntimeGitIsolationManager({
    store: server.store
  });
}

function readPersistedWorkerSession(
  server: ToolServerLike,
  teamId: string,
  agentId: string
): WorkerSessionBinding | null {
  const persisted = server.store.getWorkerRuntimeSession(agentId);
  if (!persisted || persisted.team_id !== teamId) return null;
  if (persisted.lifecycle_state === 'offline') {
    return null;
  }
  return {
    worker_id: persisted.worker_id,
    provider: persisted.provider
  };
}

function workerEnvelopeFailure(prefix: string, error: { message?: unknown }): ToolResult {
  return {
    ok: false,
    error: `${prefix}: ${String(error.message ?? 'worker adapter failure')}`,
    worker_error: error
  };
}

function invalidWorkerAdapterFailure(
  source: 'options' | 'server',
  operation: WorkerAdapterOperation
): ToolResult {
  const workerError = {
    domain: 'worker_adapter',
    provider: 'worker_adapter',
    operation,
    code: 'INVALID_WORKER_ADAPTER',
    message: `invalid worker adapter configuration from ${source}`,
    retryable: false,
    worker_id: null,
    details: {
      source
    }
  };
  return workerEnvelopeFailure('worker adapter configuration invalid', workerError);
}

export function registerAgentLifecycleTools(
  server: ToolServerLike,
  options: AgentLifecycleToolOptions = {}
): void {
  const workerAdapterResolution = resolveWorkerAdapter(server, options);
  const workerAdapter = workerAdapterResolution.adapter;
  const gitManager = resolveGitIsolationManager(server, options);
  
  function listActiveAgentsByTeam(teamId: string): AgentRecord[] {
    return server
      .store
      .listAgentsByTeam(teamId)
      .filter((agent) => agent.status !== 'offline');
  }
  server.registerTool('team_spawn', 'team_spawn.schema.json', (input) => {
    if (workerAdapterResolution.invalid_source) {
      return invalidWorkerAdapterFailure(workerAdapterResolution.invalid_source, 'spawn');
    }

    const teamId = readString(input, 'team_id');
    const role = readString(input, 'role');
    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error || !teamLookup.team) {
      return { ok: false, error: teamLookup.error };
    }
    if (!isKnownRole(role)) {
      return { ok: false, error: `unknown role: ${role}` };
    }

    const team = teamLookup.team;
    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const agentCount = listActiveAgentsByTeam(teamId).length;
    if (agentCount >= team.max_threads) {
      return {
        ok: false,
        error: `max_threads exceeded for team ${team.team_id}`
      };
    }

    const ts = nowIso();
    const modelAssignment = resolveSpawnModel({
      inputModel: input.model,
      team,
      role,
      policy
    });
    const permissionProfile = resolvePermissionProfileName(policy, role);
    const agentId = newId('agent');
    let workerSession: WorkerSessionBinding | null = null;

    if (workerAdapter) {
      const workerSpawn = workerAdapter.spawn({
        team_id: teamId,
        agent_id: agentId,
        role,
        model: modelAssignment.model,
        instruction: readOptionalString(input, 'instruction') ?? undefined,
        metadata: {
          team_id: teamId,
          role,
          permission_profile: permissionProfile
        }
      });
      if (!workerSpawn.ok) {
        return workerEnvelopeFailure('worker adapter spawn failed', workerSpawn.error);
      }
      workerSession = {
        worker_id: workerSpawn.data.worker_id,
        provider: workerSpawn.provider
      };
    }

    const agent = server.store.createAgent({
      agent_id: agentId,
      team_id: teamId,
      role,
      status: 'idle',
      model: modelAssignment.model,
      created_at: ts,
      updated_at: ts,
      metadata: {
        inherited_model: modelAssignment.inherited_model,
        model_source: modelAssignment.model_source,
        model_routing_applied: modelAssignment.model_routing_applied,
        permission_profile: permissionProfile
      }
    });
    if (!agent) {
      if (workerAdapter && workerSession) {
        workerAdapter.interrupt({
          worker_id: workerSession.worker_id,
          reason: 'agent_create_failed'
        });
      }
      return { ok: false, error: 'failed to create agent' };
    }

    if (workerSession) {
      server.store.upsertWorkerRuntimeSession({
        team_id: teamId,
        agent_id: agent.agent_id,
        worker_id: workerSession.worker_id,
        provider: workerSession.provider,
        transport_backend: workerSession.provider,
        lifecycle_state: 'active',
        metadata: {
          role,
          model: modelAssignment.model,
          model_source: modelAssignment.model_source
        },
        created_at: ts,
        updated_at: ts,
        last_seen_at: ts
      });
    }

    return {
      ok: true,
      agent,
      worker_session: workerSession,
      runtime_mode: server.runtimeMode ?? 'host_orchestrated_default',
      managed_runtime_enabled: server.managedRuntimeEnabled ?? false
    };
  });

  server.registerTool('team_spawn_ready_roles', 'team_spawn_ready_roles.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error || !teamLookup.team) {
      return { ok: false, error: teamLookup.error };
    }
    if (!server.tools?.has('team_task_next')) {
      return { ok: false, error: 'team_task_next not registered' };
    }

    const team = teamLookup.team;
    const existingAgents = listActiveAgentsByTeam(teamId);
    const capacity = Math.max(0, Number(team.max_threads ?? 0) - existingAgents.length);
    if (capacity === 0) {
      return {
        ok: true,
        team_id: teamId,
        budget: 0,
        ready_task_count: 0,
        role_candidates: [],
        spawned_count: 0,
        spawned_agents: [],
        errors: []
      };
    }

    const budget = Math.min(readOptionalNumber(input, 'max_new_agents') ?? capacity, capacity, 6);
    const readyTaskLimit = readOptionalNumber(input, 'ready_task_limit') ?? Math.min(100, Math.max(20, budget * 4));
    const ready = server.callTool('team_task_next', {
      team_id: teamId,
      limit: readyTaskLimit
    });
    if (!ready.ok) {
      return { ok: false, error: String(ready.error ?? 'team_task_next failed') };
    }

    const existingRoles = new Set(existingAgents.map((agent) => agent.role));
    const roleCandidates: string[] = [];
    const readyTasks = Array.isArray(ready.tasks)
      ? ready.tasks.filter(isRecord)
      : [];
    for (const task of readyTasks) {
      const role = String(task.required_role ?? '');
      if (!role || !isKnownRole(role)) continue;
      if (existingRoles.has(role) || roleCandidates.includes(role)) continue;
      roleCandidates.push(role);
      if (roleCandidates.length >= budget) break;
    }

    const spawnedAgents: AgentRecord[] = [];
    const errors: string[] = [];
    for (const role of roleCandidates) {
      const spawned = server.callTool('team_spawn', { team_id: teamId, role });
      if (spawned.ok && isRecord(spawned.agent)) {
        spawnedAgents.push(spawned.agent as unknown as AgentRecord);
      } else {
        errors.push(String(spawned.error ?? `failed to spawn role: ${role}`));
      }
    }

    return {
      ok: true,
      team_id: teamId,
      budget,
      ready_task_count: Number(ready.ready_count ?? readyTasks.length),
      role_candidates: roleCandidates,
      spawned_count: spawnedAgents.length,
      spawned_agents: spawnedAgents.map((agent) => ({
        agent_id: agent.agent_id,
        role: agent.role,
        model: agent.model
      })),
      errors
    };
  });

  server.registerTool('team_send', 'team_send.schema.json', (input) => {
    if (workerAdapterResolution.invalid_source) {
      return invalidWorkerAdapterFailure(workerAdapterResolution.invalid_source, 'send_instruction');
    }

    const teamId = readString(input, 'team_id');
    const fromAgentId = readString(input, 'from_agent_id');
    const toAgentId = readString(input, 'to_agent_id');
    const idempotencyKey = readString(input, 'idempotency_key');
    const summary = String(input.summary ?? '');
    const requestedCwd = readOptionalString(input, 'cwd');
    const artifactRefs = readArtifactRefs(input);

    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }
    const fromLookup = getAgentOrError(server, fromAgentId);
    if (fromLookup.error || !fromLookup.agent) {
      return { ok: false, error: fromLookup.error };
    }
    const toLookup = getAgentOrError(server, toAgentId);
    if (toLookup.error || !toLookup.agent) {
      return { ok: false, error: toLookup.error };
    }
    const fromMembership = ensureAgentInTeam(fromLookup.agent, teamId, 'from_agent');
    if (!fromMembership.ok) {
      return fromMembership;
    }
    const toMembership = ensureAgentInTeam(toLookup.agent, teamId, 'to_agent');
    if (!toMembership.ok) {
      return toMembership;
    }

    const teamPolicy = server.policyEngine?.resolveTeamPolicy(teamLookup.team) as GuardrailPolicy | undefined;
    const payloadValidation = validateMessagePayload(summary, artifactRefs, teamPolicy ?? null);
    if (!payloadValidation.ok) {
      return payloadValidation;
    }

    let effectiveArtifactRefs = artifactRefs;
    let deltaApplied = false;

    const previousRouteMessage = server.store.getLatestRouteMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      delivery_mode: 'direct'
    });
    if (previousRouteMessage?.payload?.summary === summary) {
      const deltaRefs = diffArtifactRefs(
        effectiveArtifactRefs,
        normalizeArtifactRefs(previousRouteMessage.payload.artifact_refs ?? [])
      );
      if (deltaRefs.length === 0) {
        server.store.logEvent({
          team_id: teamId,
          agent_id: fromAgentId,
          message_id: previousRouteMessage.message_id,
          event_type: 'message_duplicate_suppressed',
          payload: { delivery_mode: 'direct' }
        });
        return duplicateResponse(previousRouteMessage, 'direct');
      }
      if (deltaRefs.length < effectiveArtifactRefs.length) {
        effectiveArtifactRefs = deltaRefs;
        deltaApplied = true;
      }
    }

    const duplicate = server.store.findRecentDuplicateMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      delivery_mode: 'direct',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      within_ms: DUPLICATE_SUPPRESS_WINDOW_MS
    });
    if (duplicate) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: duplicate.message_id,
        event_type: 'message_duplicate_suppressed',
        payload: { delivery_mode: 'direct' }
      });
      return duplicateResponse(duplicate, 'direct');
    }

    const recipientWorkerSession = readPersistedWorkerSession(server, teamId, toAgentId);
    let effectiveWorkerCwd: string | undefined;
    if (workerAdapter && recipientWorkerSession) {
      const assignment = gitManager.allocateForAgent({
        team_id: teamId,
        agent_id: toAgentId,
        role: toLookup.agent.role
      });
      if (!assignment.ok || !assignment.assignment) {
        return {
          ok: false,
          error: assignment.error ?? `failed to allocate git assignment for worker ${toAgentId}`
        };
      }

      effectiveWorkerCwd = requestedCwd ?? assignment.assignment.worktree_path;
      const guard = gitManager.assertWorkerContext({
        team_id: teamId,
        agent_id: toAgentId,
        cwd: effectiveWorkerCwd
      });
      if (!guard.ok) {
        return {
          ok: false,
          error: guard.error ?? 'worker command rejected by git isolation policy'
        };
      }
    }

    const createdAt = nowIso();
    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      delivery_mode: 'direct',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      idempotency_key: idempotencyKey,
      created_at: createdAt,
      recipient_agent_ids: [toAgentId]
    });
    if (deltaApplied && result.inserted) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: result.message.message_id,
        event_type: 'message_delta_applied',
        payload: {
          delivery_mode: 'direct',
          artifact_refs_reduced_to: effectiveArtifactRefs.length
        }
      });
    }

    let workerDelivery: WorkerSendInstructionResult | null = null;
    if (result.inserted) {
      if (workerAdapter && recipientWorkerSession) {
        const delivery = workerAdapter.sendInstruction({
          worker_id: recipientWorkerSession.worker_id,
          instruction: summary,
          cwd: effectiveWorkerCwd,
          idempotency_key: idempotencyKey,
          artifact_refs: effectiveArtifactRefs,
          metadata: {
            team_id: teamId,
            from_agent_id: fromAgentId,
            to_agent_id: toAgentId
          }
        });
        if (!delivery.ok) {
          server.store.updateWorkerRuntimeSessionState({
            agent_id: toAgentId,
            lifecycle_state: 'failed',
            metadata_patch: {
              last_error_code: String(delivery.error.code ?? ''),
              last_error_message: String(delivery.error.message ?? '')
            },
            touch_seen: true,
            team_id: teamId
          });
          const rollback = server.store.rollbackMessageInsert(teamId, result.message.message_id);
          server.store.logEvent({
            team_id: teamId,
            agent_id: fromAgentId,
            message_id: result.message.message_id,
            event_type: 'worker_instruction_dispatch_rollback',
            payload: {
              from_agent_id: fromAgentId,
              to_agent_id: toAgentId,
              worker_error: delivery.error,
              rollback
            }
          });
          const rollbackSuffix = rollback.ok
            ? `dispatch compensation ${rollback.rolled_back ? 'succeeded' : 'skipped'}`
            : `dispatch compensation failed: ${String(rollback.error ?? 'unknown rollback error')}`;
          return {
            ok: false,
            error: `worker adapter send failed: ${String(delivery.error.message ?? 'worker adapter failure')} (${rollbackSuffix})`,
            worker_error: delivery.error,
            rollback
          };
        }
        workerDelivery = delivery.data;
        server.store.updateWorkerRuntimeSessionState({
          agent_id: toAgentId,
          lifecycle_state: 'active',
          metadata_patch: {
            last_instruction_id: workerDelivery.instruction_id ?? null,
            last_delivery_status: workerDelivery.status ?? null
          },
          touch_seen: true,
          team_id: teamId
        });
      }
    }

    if (result.inserted) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: toAgentId,
        message_id: result.message.message_id,
        event_type: 'worker_instruction_dispatched',
        payload: {
          from_agent_id: fromAgentId,
          to_agent_id: toAgentId,
          summary_length: summary.length,
          artifact_refs_count: effectiveArtifactRefs.length,
          worker_delivery_status: workerDelivery?.status ?? null,
          worker_instruction_id: workerDelivery?.instruction_id ?? null
        }
      });
    }

    return {
      ok: true,
      inserted: result.inserted,
      duplicate_suppressed: false,
      delta_applied: deltaApplied,
      message: {
        message_id: result.message.message_id,
        team_id: result.message.team_id,
        from_agent_id: result.message.from_agent_id,
        to_agent_id: result.message.to_agent_id,
        delivery_mode: result.message.delivery_mode,
        idempotency_key: result.message.idempotency_key,
        payload: result.message.payload
      },
      worker_delivery: workerDelivery
    };
  });

  server.registerTool('team_group_send', 'team_group_send.schema.json', (input) => {
    if (workerAdapterResolution.invalid_source) {
      return invalidWorkerAdapterFailure(workerAdapterResolution.invalid_source, 'send_instruction');
    }

    const teamId = readString(input, 'team_id');
    const fromAgentId = readString(input, 'from_agent_id');
    const idempotencyKey = readString(input, 'idempotency_key');
    const summary = String(input.summary ?? '');
    const requestedCwd = readOptionalString(input, 'cwd');
    const mentionInputs = readStringList(input, 'mentions');
    const explicitRecipientAgentIds = readStringList(input, 'recipient_agent_ids');
    const artifactRefs = readArtifactRefs(input);

    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error || !teamLookup.team) {
      return { ok: false, error: teamLookup.error };
    }
    const fromLookup = getAgentOrError(server, fromAgentId);
    if (fromLookup.error || !fromLookup.agent) {
      return { ok: false, error: fromLookup.error };
    }
    const fromMembership = ensureAgentInTeam(fromLookup.agent, teamId, 'from_agent');
    if (!fromMembership.ok) {
      return fromMembership;
    }

    const teamPolicy = server.policyEngine?.resolveTeamPolicy(teamLookup.team) as GuardrailPolicy | undefined;
    const payloadValidation = validateMessagePayload(summary, artifactRefs, teamPolicy ?? null);
    if (!payloadValidation.ok) {
      return payloadValidation;
    }

    const teamAgents = server.store.listAgentsByTeam(teamId);
    const mentionResolution = resolveMentionRecipients({
      summary,
      mentions: mentionInputs,
      explicit_recipient_agent_ids: explicitRecipientAgentIds,
      agents: teamAgents,
      sender_agent_id: fromAgentId
    });
    if (mentionResolution.unresolved_mentions.length > 0) {
      return {
        ok: false,
        error: `unresolved mentions: ${mentionResolution.unresolved_mentions.join(', ')}`,
        unresolved_mentions: mentionResolution.unresolved_mentions
      };
    }
    const recipients = mentionResolution.recipient_agent_ids;
    if (recipients.length === 0) {
      return {
        ok: false,
        error: 'group send requires at least one resolved recipient',
        unresolved_mentions: mentionResolution.unresolved_mentions
      };
    }

    let effectiveArtifactRefs = artifactRefs;
    let deltaApplied = false;
    const previousRouteMessage = server.store.getLatestRouteMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      delivery_mode: 'group',
      recipient_agent_ids: recipients
    });
    if (previousRouteMessage?.payload?.summary === summary) {
      const deltaRefs = diffArtifactRefs(
        effectiveArtifactRefs,
        normalizeArtifactRefs(previousRouteMessage.payload.artifact_refs ?? [])
      );
      if (deltaRefs.length === 0) {
        server.store.logEvent({
          team_id: teamId,
          agent_id: fromAgentId,
          message_id: previousRouteMessage.message_id,
          event_type: 'message_duplicate_suppressed',
          payload: { delivery_mode: 'group', recipient_count: recipients.length }
        });
        const response = duplicateResponse(previousRouteMessage, 'group');
        response.recipient_count = recipients.length;
        return {
          ...response,
          recipient_agent_ids: recipients
        };
      }
      if (deltaRefs.length < effectiveArtifactRefs.length) {
        effectiveArtifactRefs = deltaRefs;
        deltaApplied = true;
      }
    }

    const duplicate = server.store.findRecentDuplicateMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      delivery_mode: 'group',
      recipient_agent_ids: recipients,
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      within_ms: DUPLICATE_SUPPRESS_WINDOW_MS
    });
    if (duplicate) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: duplicate.message_id,
        event_type: 'message_duplicate_suppressed',
        payload: { delivery_mode: 'group', recipient_count: recipients.length }
      });
      const response = duplicateResponse(duplicate, 'group');
      response.recipient_count = recipients.length;
      return {
        ...response,
        recipient_agent_ids: recipients
      };
    }

    const createdAt = nowIso();
    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: null,
      delivery_mode: 'group',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      idempotency_key: idempotencyKey,
      created_at: createdAt,
      recipient_agent_ids: recipients
    });
    if (deltaApplied && result.inserted) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: result.message.message_id,
        event_type: 'message_delta_applied',
        payload: {
          delivery_mode: 'group',
          recipient_count: recipients.length,
          artifact_refs_reduced_to: effectiveArtifactRefs.length
        }
      });
    }

    const recipientById = new Map(teamAgents.map((agent) => [agent.agent_id, agent]));
    const workerDeliveries: Array<{
      agent_id: string;
      worker_id: string;
      instruction_id: string | null;
      status: string | null;
    }> = [];
    const workerErrors: Array<{
      agent_id: string;
      worker_error: Record<string, unknown>;
    }> = [];

    if (result.inserted && workerAdapter) {
      for (const recipientAgentId of recipients) {
        const recipientWorkerSession = readPersistedWorkerSession(server, teamId, recipientAgentId);
        if (!recipientWorkerSession) continue;
        const recipientAgent = recipientById.get(recipientAgentId);
        if (!recipientAgent) continue;

        const assignment = gitManager.allocateForAgent({
          team_id: teamId,
          agent_id: recipientAgentId,
          role: recipientAgent.role
        });
        if (!assignment.ok || !assignment.assignment) {
          const assignmentError = String(
            assignment.error ?? `failed to allocate git assignment for worker ${recipientAgentId}`
          );
          server.store.updateWorkerRuntimeSessionState({
            agent_id: recipientAgentId,
            lifecycle_state: 'failed',
            metadata_patch: {
              last_error_code: 'GIT_ASSIGNMENT_FAILED',
              last_error_message: assignmentError
            },
            touch_seen: true,
            team_id: teamId
          });
          workerErrors.push({
            agent_id: recipientAgentId,
            worker_error: {
              code: 'GIT_ASSIGNMENT_FAILED',
              message: assignmentError,
              retryable: false
            }
          });
          continue;
        }

        const effectiveWorkerCwd = requestedCwd ?? assignment.assignment.worktree_path;
        const guard = gitManager.assertWorkerContext({
          team_id: teamId,
          agent_id: recipientAgentId,
          cwd: effectiveWorkerCwd
        });
        if (!guard.ok) {
          const guardError = String(guard.error ?? 'worker command rejected by git isolation policy');
          server.store.updateWorkerRuntimeSessionState({
            agent_id: recipientAgentId,
            lifecycle_state: 'failed',
            metadata_patch: {
              last_error_code: 'GIT_CONTEXT_REJECTED',
              last_error_message: guardError
            },
            touch_seen: true,
            team_id: teamId
          });
          workerErrors.push({
            agent_id: recipientAgentId,
            worker_error: {
              code: 'GIT_CONTEXT_REJECTED',
              message: guardError,
              retryable: false
            }
          });
          continue;
        }

        const delivery = workerAdapter.sendInstruction({
          worker_id: recipientWorkerSession.worker_id,
          instruction: summary,
          cwd: effectiveWorkerCwd,
          idempotency_key: idempotencyKey,
          artifact_refs: effectiveArtifactRefs,
          metadata: {
            team_id: teamId,
            from_agent_id: fromAgentId,
            to_agent_id: recipientAgentId,
            delivery_mode: 'group'
          }
        });
        if (!delivery.ok) {
          server.store.updateWorkerRuntimeSessionState({
            agent_id: recipientAgentId,
            lifecycle_state: 'failed',
            metadata_patch: {
              last_error_code: String(delivery.error.code ?? ''),
              last_error_message: String(delivery.error.message ?? '')
            },
            touch_seen: true,
            team_id: teamId
          });
          workerErrors.push({
            agent_id: recipientAgentId,
            worker_error: delivery.error
          });
          continue;
        }

        const workerDelivery = delivery.data;
        server.store.updateWorkerRuntimeSessionState({
          agent_id: recipientAgentId,
          lifecycle_state: 'active',
          metadata_patch: {
            last_instruction_id: workerDelivery.instruction_id ?? null,
            last_delivery_status: workerDelivery.status ?? null
          },
          touch_seen: true,
          team_id: teamId
        });
        workerDeliveries.push({
          agent_id: recipientAgentId,
          worker_id: recipientWorkerSession.worker_id,
          instruction_id: workerDelivery.instruction_id ?? null,
          status: workerDelivery.status ?? null
        });
        server.store.logEvent({
          team_id: teamId,
          agent_id: recipientAgentId,
          message_id: result.message.message_id,
          event_type: 'worker_instruction_dispatched',
          payload: {
            delivery_mode: 'group',
            from_agent_id: fromAgentId,
            to_agent_id: recipientAgentId,
            summary_length: summary.length,
            artifact_refs_count: effectiveArtifactRefs.length,
            worker_delivery_status: workerDelivery.status ?? null,
            worker_instruction_id: workerDelivery.instruction_id ?? null
          }
        });
      }
    }

    if (result.inserted) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: result.message.message_id,
        event_type: 'worker_group_instruction_dispatch_summary',
        payload: {
          delivery_mode: 'group',
          recipient_count: recipients.length,
          worker_dispatch_count: workerDeliveries.length,
          worker_error_count: workerErrors.length,
          summary_length: summary.length,
          artifact_refs_count: effectiveArtifactRefs.length
        }
      });
    }

    return {
      ok: true,
      inserted: result.inserted,
      duplicate_suppressed: false,
      delta_applied: deltaApplied,
      recipient_count: recipients.length,
      recipient_agent_ids: recipients,
      parsed_mentions: mentionResolution.parsed_mentions.map((mention) => mention.raw),
      unresolved_mentions: mentionResolution.unresolved_mentions,
      message: {
        message_id: result.message.message_id,
        team_id: result.message.team_id,
        from_agent_id: result.message.from_agent_id,
        to_agent_id: result.message.to_agent_id,
        delivery_mode: result.message.delivery_mode,
        idempotency_key: result.message.idempotency_key,
        payload: result.message.payload
      },
      worker_deliveries: workerDeliveries,
      worker_errors: workerErrors
    };
  });

  server.registerTool('team_broadcast', 'team_broadcast.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const fromAgentId = readString(input, 'from_agent_id');
    const idempotencyKey = readString(input, 'idempotency_key');
    const summary = String(input.summary ?? '');
    const artifactRefs = readArtifactRefs(input);

    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }

    const fromLookup = getAgentOrError(server, fromAgentId);
    if (fromLookup.error || !fromLookup.agent) {
      return { ok: false, error: fromLookup.error };
    }
    const fromMembership = ensureAgentInTeam(fromLookup.agent, teamId, 'from_agent');
    if (!fromMembership.ok) {
      return fromMembership;
    }

    const teamPolicy = server.policyEngine?.resolveTeamPolicy(teamLookup.team) as GuardrailPolicy | undefined;
    const payloadValidation = validateMessagePayload(summary, artifactRefs, teamPolicy ?? null);
    if (!payloadValidation.ok) {
      return payloadValidation;
    }

    let effectiveArtifactRefs = artifactRefs;
    let deltaApplied = false;

    const previousRouteMessage = server.store.getLatestRouteMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      delivery_mode: 'broadcast'
    });
    if (previousRouteMessage?.payload?.summary === summary) {
      const deltaRefs = diffArtifactRefs(
        effectiveArtifactRefs,
        normalizeArtifactRefs(previousRouteMessage.payload.artifact_refs ?? [])
      );
      if (deltaRefs.length === 0) {
        server.store.logEvent({
          team_id: teamId,
          agent_id: fromAgentId,
          message_id: previousRouteMessage.message_id,
          event_type: 'message_duplicate_suppressed',
          payload: { delivery_mode: 'broadcast' }
        });
        const response = duplicateResponse(previousRouteMessage, 'broadcast');
        response.recipient_count = recipientCountExcludingSender(server, teamId, fromAgentId);
        return response;
      }
      if (deltaRefs.length < effectiveArtifactRefs.length) {
        effectiveArtifactRefs = deltaRefs;
        deltaApplied = true;
      }
    }

    const duplicate = server.store.findRecentDuplicateMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      delivery_mode: 'broadcast',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      within_ms: DUPLICATE_SUPPRESS_WINDOW_MS
    });
    if (duplicate) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: duplicate.message_id,
        event_type: 'message_duplicate_suppressed',
        payload: { delivery_mode: 'broadcast' }
      });
      const response = duplicateResponse(duplicate, 'broadcast');
      response.recipient_count = recipientCountExcludingSender(server, teamId, fromAgentId);
      return response;
    }

    const recipients = server
      .store
      .listAgentsByTeam(teamId)
      .filter((agent) => agent.agent_id !== fromAgentId)
      .map((agent) => agent.agent_id);

    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: null,
      delivery_mode: 'broadcast',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      idempotency_key: idempotencyKey,
      created_at: nowIso(),
      recipient_agent_ids: recipients
    });
    if (deltaApplied) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: result.message.message_id,
        event_type: 'message_delta_applied',
        payload: {
          delivery_mode: 'broadcast',
          artifact_refs_reduced_to: effectiveArtifactRefs.length
        }
      });
    }

    return {
      ok: true,
      inserted: result.inserted,
      duplicate_suppressed: false,
      delta_applied: deltaApplied,
      recipient_count: recipients.length,
      message: {
        message_id: result.message.message_id,
        delivery_mode: result.message.delivery_mode,
        payload: result.message.payload,
        idempotency_key: result.message.idempotency_key
      }
    };
  });

  server.registerTool('team_pull_inbox', 'team_pull_inbox.schema.json', (input) => {
    if (workerAdapterResolution.invalid_source) {
      return invalidWorkerAdapterFailure(workerAdapterResolution.invalid_source, 'poll');
    }

    const teamId = readString(input, 'team_id');
    const agentId = readString(input, 'agent_id');
    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }
    const agentLookup = getAgentOrError(server, agentId);
    if (agentLookup.error || !agentLookup.agent) {
      return { ok: false, error: agentLookup.error };
    }
    const agentMembership = ensureAgentInTeam(agentLookup.agent, teamId, 'agent');
    if (!agentMembership.ok) {
      return agentMembership;
    }

    const limit = readOptionalNumber(input, 'limit') ?? 20;
    const messages = server.store.pullInbox(teamId, agentId, limit);
    let acked = 0;
    const requestedAckIds = readNumberList(input, 'ack_inbox_ids');
    if (requestedAckIds.length > 0) {
      const pulledIds = new Set(messages.map((message) => message.inbox_id));
      const scopedAckIds = requestedAckIds.filter((id) => pulledIds.has(id));
      acked = server.store.ackInbox(scopedAckIds);
    } else if (readBoolean(input, 'ack', true)) {
      acked = server.store.ackInbox(messages.map((message) => message.inbox_id));
    }

    let workerPoll: WorkerPollResult | null = null;
    let workerArtifacts: WorkerCollectArtifactsResult['artifacts'] | null = null;
    const workerErrors: Array<{ message?: unknown }> = [];
    const workerSession = readPersistedWorkerSession(server, teamId, agentId);
    const workerAdapterActive = Boolean(workerAdapter && workerSession);
    if (workerAdapter && workerSession) {
      const poll = workerAdapter.poll({
        worker_id: workerSession.worker_id,
        limit
      });
      if (!poll.ok) {
        workerErrors.push(poll.error);
        server.store.updateWorkerRuntimeSessionState({
          agent_id: agentId,
          lifecycle_state: 'failed',
          metadata_patch: {
            last_error_code: String(poll.error.code ?? ''),
            last_error_message: String(poll.error.message ?? '')
          },
          touch_seen: true,
          team_id: teamId
        });
      } else {
        workerPoll = poll.data;
        server.store.updateWorkerRuntimeSessionState({
          agent_id: agentId,
          lifecycle_state: workerPoll.status === 'interrupted' ? 'interrupted' : 'active',
          metadata_patch: {
            last_poll_status: workerPoll.status,
            last_poll_cursor: workerPoll.cursor ?? null
          },
          touch_seen: true,
          team_id: teamId
        });
      }

      const artifacts = workerAdapter.collectArtifacts({
        worker_id: workerSession.worker_id,
        limit: MAX_ARTIFACT_REFS
      });
      if (!artifacts.ok) {
        workerErrors.push(artifacts.error);
      } else {
        workerArtifacts = artifacts.data.artifacts;
      }
    }

    if (workerPoll || workerArtifacts || workerErrors.length > 0) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: agentId,
        event_type: 'worker_execution_snapshot',
        payload: {
          worker_id: workerSession?.worker_id ?? null,
          poll_status: workerPoll?.status ?? null,
          poll_event_count: Array.isArray(workerPoll?.events) ? workerPoll.events.length : 0,
          artifact_count: Array.isArray(workerArtifacts) ? workerArtifacts.length : 0,
          artifact_ids: Array.isArray(workerArtifacts)
            ? workerArtifacts.map((artifact) => String(artifact.artifact_id ?? '')).filter(Boolean)
            : [],
          worker_error_count: workerErrors.length
        }
      });
    }

    return {
      ok: true,
      messages: messages.map((msg) => ({
        inbox_id: msg.inbox_id,
        message_id: msg.message_id,
        from_agent_id: msg.from_agent_id,
        to_agent_id: msg.to_agent_id,
        delivery_mode: msg.delivery_mode,
        idempotency_key: msg.idempotency_key,
        payload: msg.payload,
        delivered_at: msg.delivered_at
      })),
      acked,
      worker_poll: workerPoll,
      worker_artifacts: workerArtifacts,
      worker_errors: workerErrors,
      worker_adapter_active: workerAdapterActive
    };
  });
}
