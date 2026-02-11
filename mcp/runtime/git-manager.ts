import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AgentRecord, TaskRecord, TeamRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';

const DEFAULT_WORKTREE_ROOT = '.tmp/agent-teams';
const DEFAULT_BRANCH_PREFIX = 'team';
const DEFAULT_METADATA_KEY = 'runtime_git_isolation';
const MAX_RELEASE_HISTORY = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sanitizeSegment(value: string, fallback: string): string {
  const safe = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return safe.length > 0 ? safe : fallback;
}

function defaultRunId(teamId: string): string {
  const stamp = nowIso()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  const suffix = sanitizeSegment(teamId, 'team').slice(0, 8);
  return `run-${stamp}-${suffix}`;
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const candidate = resolve(candidatePath);
  const root = resolve(rootPath);
  if (candidate === root) return true;
  return candidate.startsWith(`${root}${sep}`);
}

function safeRemoveWorktree(worktreePath: string, worktreeRoot: string): boolean {
  if (!isPathWithin(worktreePath, worktreeRoot)) {
    return false;
  }
  rmSync(worktreePath, { recursive: true, force: true });
  return true;
}

function readNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface GitIsolationAssignment {
  team_id: string;
  agent_id: string;
  role: string;
  run_id: string;
  slot: number;
  branch: string;
  worktree_path: string;
  assigned_at: string;
  last_seen_at: string;
}

export interface GitIsolationReleaseRecord extends GitIsolationAssignment {
  released_at: string;
  reason: string;
}

interface TeamIsolationState {
  run_id: string;
  next_slot_by_role: Record<string, number>;
  assignments: Record<string, GitIsolationAssignment>;
  released: GitIsolationReleaseRecord[];
  updated_at: string;
}

export interface GitIsolationAllocationResult {
  ok: boolean;
  assignment?: GitIsolationAssignment;
  error?: string;
}

export interface GitIsolationCleanupResult {
  released_count: number;
  released: GitIsolationReleaseRecord[];
}

export interface GitIsolationGuardResult {
  ok: boolean;
  assignment?: GitIsolationAssignment;
  error?: string;
}

export interface RuntimeGitIsolationManagerOptions {
  store: SqliteStore;
  repoRoot?: string;
  worktreeRoot?: string;
  branchPrefix?: string;
  metadataKey?: string;
  runIdFactory?: (teamId: string) => string;
}

function normalizeAssignment(raw: Record<string, unknown>): GitIsolationAssignment | null {
  const teamId = readString(raw.team_id).trim();
  const agentId = readString(raw.agent_id).trim();
  const role = readString(raw.role).trim();
  const runId = readString(raw.run_id).trim();
  const branch = readString(raw.branch).trim();
  const worktreePath = readString(raw.worktree_path).trim();
  const assignedAt = readString(raw.assigned_at).trim();
  const lastSeenAt = readString(raw.last_seen_at).trim();
  const slot = readNumber(raw.slot, 0);
  if (!teamId || !agentId || !role || !runId || !branch || !worktreePath || slot < 1) {
    return null;
  }
  return {
    team_id: teamId,
    agent_id: agentId,
    role,
    run_id: runId,
    slot,
    branch,
    worktree_path: resolve(worktreePath),
    assigned_at: assignedAt || nowIso(),
    last_seen_at: lastSeenAt || assignedAt || nowIso()
  };
}

function normalizeRelease(raw: Record<string, unknown>): GitIsolationReleaseRecord | null {
  const assignment = normalizeAssignment(raw);
  if (!assignment) return null;
  const releasedAt = readString(raw.released_at).trim();
  const reason = readString(raw.reason).trim();
  return {
    ...assignment,
    released_at: releasedAt || nowIso(),
    reason: reason || 'released'
  };
}

export class RuntimeGitIsolationManager {
  readonly store: SqliteStore;
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly branchPrefix: string;
  readonly metadataKey: string;
  readonly runIdFactory: (teamId: string) => string;

  constructor(options: RuntimeGitIsolationManagerOptions) {
    this.store = options.store;
    this.repoRoot = resolve(options.repoRoot ?? process.cwd());
    this.worktreeRoot = resolve(this.repoRoot, options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT);
    this.branchPrefix = sanitizeSegment(options.branchPrefix ?? DEFAULT_BRANCH_PREFIX, DEFAULT_BRANCH_PREFIX);
    this.metadataKey = options.metadataKey ?? DEFAULT_METADATA_KEY;
    this.runIdFactory = options.runIdFactory ?? defaultRunId;
  }

  allocateForAgent({
    team_id,
    agent_id,
    role
  }: {
    team_id: string;
    agent_id: string;
    role: string;
  }): GitIsolationAllocationResult {
    const team = this.store.getTeam(team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${team_id}` };
    }
    const agent = this.store.getAgent(agent_id);
    if (!agent || agent.team_id !== team_id) {
      return { ok: false, error: `agent not found in team: ${agent_id}` };
    }

    const state = this.readOrCreateState(team);
    const existing = state.assignments[agent_id];
    if (existing) {
      existing.last_seen_at = nowIso();
      this.persistState(team_id, state);
      if (!existsSync(existing.worktree_path)) {
        mkdirSync(existing.worktree_path, { recursive: true });
      }
      return { ok: true, assignment: existing };
    }

    const roleKey = sanitizeSegment(role, 'worker');
    const namesInUse = new Set(
      Object.values(state.assignments).map((assignment) => `${assignment.branch}::${assignment.worktree_path}`)
    );
    let slot = readNumber(state.next_slot_by_role[roleKey], 0) + 1;
    let branch = '';
    let worktreePath = '';
    while (true) {
      const workerName = `${roleKey}-${slot}`;
      branch = `${this.branchPrefix}/${state.run_id}/${workerName}`;
      worktreePath = resolve(this.worktreeRoot, state.run_id, workerName);
      const pairKey = `${branch}::${worktreePath}`;
      if (!namesInUse.has(pairKey) && !existsSync(worktreePath)) {
        break;
      }
      slot += 1;
    }

    mkdirSync(worktreePath, { recursive: true });
    const assignedAt = nowIso();
    const assignment: GitIsolationAssignment = {
      team_id,
      agent_id,
      role: roleKey,
      run_id: state.run_id,
      slot,
      branch,
      worktree_path: worktreePath,
      assigned_at: assignedAt,
      last_seen_at: assignedAt
    };
    state.assignments[agent_id] = assignment;
    state.next_slot_by_role[roleKey] = slot;
    state.updated_at = assignedAt;
    this.persistState(team_id, state);
    return { ok: true, assignment };
  }

  assertWorkerContext({
    team_id,
    agent_id,
    cwd
  }: {
    team_id: string;
    agent_id: string;
    cwd: string;
  }): GitIsolationGuardResult {
    const state = this.readState(team_id);
    if (!state) {
      return { ok: false, error: `no git isolation state for team ${team_id}` };
    }
    const assignment = state.assignments[agent_id];
    if (!assignment) {
      return { ok: false, error: `no git assignment for worker ${agent_id}` };
    }
    const resolvedCwd = resolve(cwd);
    if (!isPathWithin(resolvedCwd, assignment.worktree_path)) {
      return {
        ok: false,
        error: `worker command rejected: ${resolvedCwd} is outside assigned worktree ${assignment.worktree_path}`
      };
    }
    return { ok: true, assignment };
  }

  releaseAgentAssignment(teamId: string, agentId: string, reason = 'released'): GitIsolationCleanupResult {
    const state = this.readState(teamId);
    if (!state) return { released_count: 0, released: [] };
    const assignment = state.assignments[agentId];
    if (!assignment) return { released_count: 0, released: [] };

    const releasedAt = nowIso();
    const released: GitIsolationReleaseRecord = {
      ...assignment,
      released_at: releasedAt,
      reason
    };

    safeRemoveWorktree(assignment.worktree_path, this.worktreeRoot);
    delete state.assignments[agentId];
    state.released.push(released);
    if (state.released.length > MAX_RELEASE_HISTORY) {
      state.released = state.released.slice(state.released.length - MAX_RELEASE_HISTORY);
    }
    state.updated_at = releasedAt;
    this.persistState(teamId, state);
    return {
      released_count: 1,
      released: [released]
    };
  }

  cleanupOrphanAssignments({
    team_id,
    active_agent_ids,
    reason = 'orphan_cleanup'
  }: {
    team_id: string;
    active_agent_ids: Set<string>;
    reason?: string;
  }): GitIsolationCleanupResult {
    const state = this.readState(team_id);
    if (!state) return { released_count: 0, released: [] };

    const released: GitIsolationReleaseRecord[] = [];
    for (const assignment of Object.values(state.assignments)) {
      if (active_agent_ids.has(assignment.agent_id)) {
        continue;
      }
      const releasedAt = nowIso();
      released.push({
        ...assignment,
        released_at: releasedAt,
        reason
      });
      safeRemoveWorktree(assignment.worktree_path, this.worktreeRoot);
      delete state.assignments[assignment.agent_id];
    }

    if (released.length === 0) {
      return { released_count: 0, released: [] };
    }

    state.released.push(...released);
    if (state.released.length > MAX_RELEASE_HISTORY) {
      state.released = state.released.slice(state.released.length - MAX_RELEASE_HISTORY);
    }
    state.updated_at = nowIso();
    this.persistState(team_id, state);
    return {
      released_count: released.length,
      released
    };
  }

  releaseTeamAssignments(teamId: string, reason = 'team_inactive'): GitIsolationCleanupResult {
    const state = this.readState(teamId);
    if (!state) return { released_count: 0, released: [] };

    const released: GitIsolationReleaseRecord[] = [];
    for (const assignment of Object.values(state.assignments)) {
      const releasedAt = nowIso();
      released.push({
        ...assignment,
        released_at: releasedAt,
        reason
      });
      safeRemoveWorktree(assignment.worktree_path, this.worktreeRoot);
    }

    if (released.length === 0) {
      return { released_count: 0, released: [] };
    }

    state.assignments = {};
    state.released.push(...released);
    if (state.released.length > MAX_RELEASE_HISTORY) {
      state.released = state.released.slice(state.released.length - MAX_RELEASE_HISTORY);
    }
    state.updated_at = nowIso();
    this.persistState(teamId, state);
    return {
      released_count: released.length,
      released
    };
  }

  cleanupForTeam(team: TeamRecord, agents: AgentRecord[], tasks: TaskRecord[]): GitIsolationCleanupResult {
    if (team.status !== 'active') {
      return this.releaseTeamAssignments(team.team_id, `team_${team.status}`);
    }

    const activeAgentIds = new Set<string>();
    for (const agent of agents) {
      if (agent.status === 'busy') {
        activeAgentIds.add(agent.agent_id);
      }
    }
    for (const task of tasks) {
      if (task.status === 'in_progress' && task.claimed_by) {
        activeAgentIds.add(task.claimed_by);
      }
    }
    return this.cleanupOrphanAssignments({
      team_id: team.team_id,
      active_agent_ids: activeAgentIds
    });
  }

  getTeamAssignments(teamId: string): GitIsolationAssignment[] {
    const state = this.readState(teamId);
    if (!state) return [];
    return Object.values(state.assignments).sort((left, right) => left.assigned_at.localeCompare(right.assigned_at));
  }

  private readOrCreateState(team: TeamRecord): TeamIsolationState {
    const existing = this.parseState(team.metadata?.[this.metadataKey], team.team_id);
    if (existing) return existing;
    return {
      run_id: this.runIdFactory(team.team_id),
      next_slot_by_role: {},
      assignments: {},
      released: [],
      updated_at: nowIso()
    };
  }

  private readState(teamId: string): TeamIsolationState | null {
    const team = this.store.getTeam(teamId);
    if (!team) return null;
    return this.parseState(team.metadata?.[this.metadataKey], teamId);
  }

  private parseState(rawValue: unknown, teamId: string): TeamIsolationState | null {
    const raw = asRecord(rawValue);
    if (Object.keys(raw).length === 0) {
      return null;
    }
    const runId = readString(raw.run_id).trim() || this.runIdFactory(teamId);
    const nextSlotByRoleRaw = asRecord(raw.next_slot_by_role);
    const nextSlotByRole: Record<string, number> = {};
    for (const [role, slot] of Object.entries(nextSlotByRoleRaw)) {
      nextSlotByRole[sanitizeSegment(role, 'worker')] = readNumber(slot, 0);
    }

    const assignmentsRaw = asRecord(raw.assignments);
    const assignments: Record<string, GitIsolationAssignment> = {};
    for (const [agentId, value] of Object.entries(assignmentsRaw)) {
      const assignment = normalizeAssignment(asRecord(value));
      if (!assignment) continue;
      if (assignment.team_id !== teamId) continue;
      assignments[agentId] = assignment;
      const roleKey = sanitizeSegment(assignment.role, 'worker');
      nextSlotByRole[roleKey] = Math.max(nextSlotByRole[roleKey] ?? 0, assignment.slot);
    }

    const releasedRaw = Array.isArray(raw.released) ? raw.released : [];
    const released = releasedRaw
      .map((entry) => normalizeRelease(asRecord(entry)))
      .filter((entry): entry is GitIsolationReleaseRecord => Boolean(entry))
      .slice(-MAX_RELEASE_HISTORY);

    return {
      run_id: runId,
      next_slot_by_role: nextSlotByRole,
      assignments,
      released,
      updated_at: readString(raw.updated_at).trim() || nowIso()
    };
  }

  private persistState(teamId: string, state: TeamIsolationState): void {
    const metadataPatch: Record<string, unknown> = {};
    metadataPatch[this.metadataKey] = state;
    this.store.updateTeamMetadata(teamId, metadataPatch);
  }
}
