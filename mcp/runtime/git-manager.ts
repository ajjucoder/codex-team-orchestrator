import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AgentRecord, TaskRecord, TeamRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';

const DEFAULT_WORKTREE_ROOT = '.tmp/agent-teams';
const DEFAULT_BRANCH_PREFIX = 'team';
const DEFAULT_METADATA_KEY = 'runtime_git_isolation';
const MAX_RELEASE_HISTORY = 100;
const TERMINAL_TASK_STATUSES = new Set<string>(['done', 'cancelled']);

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
  git_managed: boolean;
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
  failed?: GitIsolationCleanupFailure[];
  integration?: GitIsolationIntegrationOutcome;
}

export interface GitIsolationGuardResult {
  ok: boolean;
  assignment?: GitIsolationAssignment;
  error?: string;
}

export interface GitIsolationCleanupFailure {
  team_id: string;
  agent_id: string;
  branch: string;
  worktree_path: string;
  error: string;
}

export interface GitIsolationIntegrationOutcome {
  attempted: boolean;
  succeeded: boolean;
  reason?: string;
  target_branch?: string;
  merged_branches?: string[];
  error?: string;
}

export interface RuntimeGitIsolationManagerOptions {
  store: SqliteStore;
  repoRoot?: string;
  worktreeRoot?: string;
  enableGitOperations?: boolean;
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
  const gitManaged = raw.git_managed === true;
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
    git_managed: gitManaged,
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
  readonly enableGitOperations: boolean;
  private gitRepoStatus: boolean | null;

  constructor(options: RuntimeGitIsolationManagerOptions) {
    this.store = options.store;
    this.repoRoot = resolve(options.repoRoot ?? process.cwd());
    this.worktreeRoot = resolve(this.repoRoot, options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT);
    this.enableGitOperations = options.enableGitOperations ?? options.repoRoot !== undefined;
    this.branchPrefix = sanitizeSegment(options.branchPrefix ?? DEFAULT_BRANCH_PREFIX, DEFAULT_BRANCH_PREFIX);
    this.metadataKey = options.metadataKey ?? DEFAULT_METADATA_KEY;
    this.runIdFactory = options.runIdFactory ?? defaultRunId;
    this.gitRepoStatus = null;
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
      const prepared = this.ensureAssignmentWorkspace(existing, false);
      if (!prepared.ok) {
        return { ok: false, error: prepared.error ?? `failed to restore assignment for ${agent_id}` };
      }
      existing.git_managed = prepared.git_managed;
      existing.last_seen_at = nowIso();
      this.persistState(team_id, state);
      return { ok: true, assignment: existing };
    }

    const gitRepo = this.isGitRepoRoot();
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
      if (namesInUse.has(pairKey) || existsSync(worktreePath)) {
        slot += 1;
        continue;
      }
      if (gitRepo && this.gitBranchExists(branch)) {
        slot += 1;
        continue;
      }
      if (!namesInUse.has(pairKey) && !existsSync(worktreePath)) {
        break;
      }
      slot += 1;
    }
    const assignedAt = nowIso();
    const assignment: GitIsolationAssignment = {
      team_id,
      agent_id,
      role: roleKey,
      run_id: state.run_id,
      slot,
      branch,
      worktree_path: worktreePath,
      git_managed: false,
      assigned_at: assignedAt,
      last_seen_at: assignedAt
    };

    const prepared = this.ensureAssignmentWorkspace(assignment, true);
    if (!prepared.ok) {
      return { ok: false, error: prepared.error ?? `failed to prepare assignment for ${agent_id}` };
    }
    assignment.git_managed = prepared.git_managed;

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

    const cleanup = this.releaseAssignments(teamId, state, [assignment], reason);
    if ((cleanup.failed?.length ?? 0) > 0) {
      this.logTeamEvent(teamId, 'git_assignment_cleanup_failed', {
        reason,
        failed: cleanup.failed
      });
    }
    return cleanup;
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
    const releasable = Object.values(state.assignments).filter((assignment) => !active_agent_ids.has(assignment.agent_id));
    return this.releaseAssignments(team_id, state, releasable, reason);
  }

  releaseTeamAssignments(teamId: string, reason = 'team_inactive'): GitIsolationCleanupResult {
    const state = this.readState(teamId);
    if (!state) return { released_count: 0, released: [] };
    return this.releaseAssignments(teamId, state, Object.values(state.assignments), reason);
  }

  cleanupInactiveTeam(team: TeamRecord, tasks: TaskRecord[]): GitIsolationCleanupResult {
    if (team.status === 'active') {
      return { released_count: 0, released: [] };
    }
    if (team.status === 'paused') {
      return {
        released_count: 0,
        released: [],
        integration: {
          attempted: false,
          succeeded: false,
          reason: 'paused'
        }
      };
    }

    const state = this.readState(team.team_id);
    if (!state) return { released_count: 0, released: [] };
    const assignments = Object.values(state.assignments);
    if (assignments.length === 0) {
      return { released_count: 0, released: [] };
    }

    if (!this.isGitRepoRoot()) {
      const cleanup = this.releaseTeamAssignments(team.team_id, `team_${team.status}`);
      if (cleanup.released_count > 0 || (cleanup.failed?.length ?? 0) > 0) {
        this.logTeamEvent(team.team_id, 'git_auto_integration_skipped_non_git', {
          team_status: team.status,
          released_count: cleanup.released_count,
          failed_count: cleanup.failed?.length ?? 0
        });
      }
      return cleanup;
    }

    const openTaskCount = tasks.reduce((count, task) => count + (this.isOpenTask(task) ? 1 : 0), 0);
    if (openTaskCount > 0) {
      return {
        released_count: 0,
        released: [],
        integration: {
          attempted: false,
          succeeded: false,
          reason: 'open_tasks'
        }
      };
    }
    if (assignments.some((assignment) => assignment.git_managed !== true)) {
      return {
        released_count: 0,
        released: [],
        integration: {
          attempted: false,
          succeeded: false,
          reason: 'non_git_assignments'
        }
      };
    }

    const integration = this.integrateAssignments(assignments);
    if (!integration.ok) {
      this.logTeamEvent(team.team_id, 'git_auto_integration_failed', {
        team_status: team.status,
        target_branch: integration.target_branch,
        merged_branches: integration.merged_branches,
        error: integration.error
      });
      return {
        released_count: 0,
        released: [],
        integration: {
          attempted: true,
          succeeded: false,
          target_branch: integration.target_branch,
          merged_branches: integration.merged_branches,
          error: integration.error
        }
      };
    }

    const cleanup = this.releaseTeamAssignments(team.team_id, 'team_completed_integrated');
    const failedCount = cleanup.failed?.length ?? 0;
    this.logTeamEvent(team.team_id, failedCount > 0 ? 'git_auto_integration_partial_cleanup' : 'git_auto_integration_succeeded', {
      team_status: team.status,
      target_branch: integration.target_branch,
      merged_branches: integration.merged_branches,
      released_count: cleanup.released_count,
      failed_count: failedCount
    });
    return {
      ...cleanup,
      integration: {
        attempted: true,
        succeeded: failedCount === 0,
        reason: failedCount > 0 ? 'cleanup_failed' : 'completed',
        target_branch: integration.target_branch,
        merged_branches: integration.merged_branches
      }
    };
  }

  cleanupForTeam(team: TeamRecord, agents: AgentRecord[], tasks: TaskRecord[]): GitIsolationCleanupResult {
    if (team.status !== 'active') {
      return this.cleanupInactiveTeam(team, tasks);
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

  private isGitRepoRoot(): boolean {
    if (!this.enableGitOperations) {
      return false;
    }
    if (this.gitRepoStatus !== null) {
      return this.gitRepoStatus;
    }
    const probe = this.runGit(['rev-parse', '--is-inside-work-tree']);
    this.gitRepoStatus = probe.ok && probe.stdout.trim() === 'true';
    return this.gitRepoStatus;
  }

  private runGit(args: string[], cwd = this.repoRoot): GitCommandResult {
    const command = `git ${args.join(' ')}`;
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8'
    });
    const stdout = readString(result.stdout).trim();
    const stderr = readString(result.stderr).trim();
    const code = typeof result.status === 'number' ? result.status : null;
    if (result.error) {
      return {
        ok: false,
        code,
        stdout,
        stderr,
        command,
        error: String(result.error.message ?? result.error)
      };
    }
    return {
      ok: code === 0,
      code,
      stdout,
      stderr,
      command
    };
  }

  private formatGitError(result: GitCommandResult, fallback: string): string {
    const err = result.stderr || result.error || fallback;
    return `${result.command} failed: ${err}`;
  }

  private gitBranchExists(branch: string): boolean {
    if (!this.isGitRepoRoot()) return false;
    const result = this.runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return result.ok;
  }

  private ensureAssignmentWorkspace(
    assignment: GitIsolationAssignment,
    createBranch: boolean
  ): { ok: boolean; git_managed: boolean; error?: string } {
    if (!isPathWithin(assignment.worktree_path, this.worktreeRoot)) {
      return {
        ok: false,
        git_managed: false,
        error: `worktree path ${assignment.worktree_path} is outside root ${this.worktreeRoot}`
      };
    }
    if (existsSync(assignment.worktree_path)) {
      return { ok: true, git_managed: assignment.git_managed };
    }
    if (!this.isGitRepoRoot()) {
      mkdirSync(assignment.worktree_path, { recursive: true });
      return { ok: true, git_managed: false };
    }

    mkdirSync(resolve(assignment.worktree_path, '..'), { recursive: true });
    if (!assignment.git_managed && !createBranch) {
      mkdirSync(assignment.worktree_path, { recursive: true });
      return { ok: true, git_managed: false };
    }
    if (createBranch) {
      if (this.gitBranchExists(assignment.branch)) {
        const attached = this.runGit(['worktree', 'add', assignment.worktree_path, assignment.branch]);
        if (attached.ok) {
          return { ok: true, git_managed: true };
        }
      }
      const created = this.runGit(['worktree', 'add', '-b', assignment.branch, assignment.worktree_path, 'HEAD']);
      if (!created.ok) {
        // Fail-open to filesystem isolation if git worktree branch allocation is unavailable.
        mkdirSync(assignment.worktree_path, { recursive: true });
        return { ok: true, git_managed: false };
      }
      return { ok: true, git_managed: true };
    }

    if (!this.gitBranchExists(assignment.branch)) {
      mkdirSync(assignment.worktree_path, { recursive: true });
      return { ok: true, git_managed: false };
    }
    const attached = this.runGit(['worktree', 'add', assignment.worktree_path, assignment.branch]);
    if (!attached.ok) {
      mkdirSync(assignment.worktree_path, { recursive: true });
      return { ok: true, git_managed: false };
    }
    return { ok: true, git_managed: true };
  }

  private cleanupAssignmentWorkspace(assignment: GitIsolationAssignment): { ok: boolean; error?: string } {
    if (!isPathWithin(assignment.worktree_path, this.worktreeRoot)) {
      return {
        ok: false,
        error: `worktree path ${assignment.worktree_path} is outside root ${this.worktreeRoot}`
      };
    }

    if (!this.isGitRepoRoot() || !assignment.git_managed) {
      const removed = safeRemoveWorktree(assignment.worktree_path, this.worktreeRoot);
      if (!removed) {
        return {
          ok: false,
          error: `refused to remove worktree outside root: ${assignment.worktree_path}`
        };
      }
      return { ok: true };
    }

    if (existsSync(assignment.worktree_path)) {
      const removedWorktree = this.runGit(['worktree', 'remove', '--force', assignment.worktree_path]);
      if (!removedWorktree.ok) {
        const removed = safeRemoveWorktree(assignment.worktree_path, this.worktreeRoot);
        if (!removed) {
          return {
            ok: false,
            error: this.formatGitError(removedWorktree, `failed to remove worktree ${assignment.worktree_path}`)
          };
        }
      }
    }
    this.runGit(['worktree', 'prune']);

    if (this.gitBranchExists(assignment.branch)) {
      const deletedBranch = this.runGit(['branch', '-D', assignment.branch]);
      if (!deletedBranch.ok) {
        return {
          ok: false,
          error: this.formatGitError(deletedBranch, `failed to delete branch ${assignment.branch}`)
        };
      }
    }

    if (existsSync(assignment.worktree_path)) {
      safeRemoveWorktree(assignment.worktree_path, this.worktreeRoot);
    }
    return { ok: true };
  }

  private releaseAssignments(
    teamId: string,
    state: TeamIsolationState,
    assignments: GitIsolationAssignment[],
    reason: string
  ): GitIsolationCleanupResult {
    if (assignments.length === 0) {
      return { released_count: 0, released: [] };
    }

    const released: GitIsolationReleaseRecord[] = [];
    const failed: GitIsolationCleanupFailure[] = [];

    for (const assignment of assignments) {
      const cleaned = this.cleanupAssignmentWorkspace(assignment);
      if (!cleaned.ok) {
        failed.push({
          team_id: assignment.team_id,
          agent_id: assignment.agent_id,
          branch: assignment.branch,
          worktree_path: assignment.worktree_path,
          error: cleaned.error ?? 'cleanup failed'
        });
        continue;
      }
      const releasedAt = nowIso();
      const releaseRecord: GitIsolationReleaseRecord = {
        ...assignment,
        released_at: releasedAt,
        reason
      };
      delete state.assignments[assignment.agent_id];
      released.push(releaseRecord);
    }

    if (released.length > 0) {
      state.released.push(...released);
      if (state.released.length > MAX_RELEASE_HISTORY) {
        state.released = state.released.slice(state.released.length - MAX_RELEASE_HISTORY);
      }
      state.updated_at = nowIso();
      this.persistState(teamId, state);
    }

    const result: GitIsolationCleanupResult = {
      released_count: released.length,
      released
    };
    if (failed.length > 0) {
      result.failed = failed;
    }
    return result;
  }

  private isOpenTask(task: TaskRecord): boolean {
    return !TERMINAL_TASK_STATUSES.has(String(task.status));
  }

  private integrateAssignments(assignments: GitIsolationAssignment[]): IntegrationAttemptResult {
    const branchResult = this.runGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branchResult.ok || !branchResult.stdout) {
      return {
        ok: false,
        target_branch: undefined,
        merged_branches: [],
        error: this.formatGitError(branchResult, 'failed to resolve integration target branch')
      };
    }
    const targetBranch = branchResult.stdout.trim();
    const cleanStatus = this.runGit(['status', '--porcelain', '--untracked-files=no'], this.repoRoot);
    if (!cleanStatus.ok) {
      return {
        ok: false,
        target_branch: targetBranch,
        merged_branches: [],
        error: this.formatGitError(cleanStatus, 'failed to inspect integration target workspace')
      };
    }
    if (cleanStatus.stdout.length > 0) {
      return {
        ok: false,
        target_branch: targetBranch,
        merged_branches: [],
        error: `integration target branch ${targetBranch} has uncommitted changes`
      };
    }

    const mergedBranches: string[] = [];
    const orderedAssignments = [...assignments].sort((left, right) => left.slot - right.slot);
    for (const assignment of orderedAssignments) {
      if (!this.gitBranchExists(assignment.branch)) {
        return {
          ok: false,
          target_branch: targetBranch,
          merged_branches: mergedBranches,
          error: `assignment branch missing: ${assignment.branch}`
        };
      }
      const mergeResult = this.runGit(['merge', '--no-ff', '--no-edit', assignment.branch], this.repoRoot);
      if (!mergeResult.ok) {
        this.runGit(['merge', '--abort'], this.repoRoot);
        return {
          ok: false,
          target_branch: targetBranch,
          merged_branches: mergedBranches,
          error: this.formatGitError(mergeResult, `failed to merge ${assignment.branch}`)
        };
      }
      mergedBranches.push(assignment.branch);
    }
    return {
      ok: true,
      target_branch: targetBranch,
      merged_branches: mergedBranches
    };
  }

  private logTeamEvent(teamId: string, eventType: string, payload: Record<string, unknown>): void {
    this.store.logEvent({
      team_id: teamId,
      event_type: eventType,
      payload,
      created_at: nowIso()
    });
  }
}

interface GitCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  command: string;
  error?: string;
}

interface IntegrationAttemptResult {
  ok: boolean;
  target_branch?: string;
  merged_branches: string[];
  error?: string;
}
