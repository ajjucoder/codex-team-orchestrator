import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentCreateInput,
  AgentRecord,
  AppendMessageInput,
  ArtifactRecord,
  ArtifactRef,
  ClaimTaskInput,
  InboxRecord,
  MessagePayload,
  MessageRecord,
  PublishArtifactInput,
  RunEventRecord,
  TaskCreateInput,
  TaskRecord,
  TeamCreateInput,
  TeamHierarchyLinkRecord,
  TeamMode,
  TeamRecord,
  TeamStatus,
  UpdateTaskInput,
  UsageSample
} from './entities.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, 'migrations');

interface StoreOptions {
  busyTimeoutMs?: number;
  lockRetries?: number;
  lockBackoffMs?: number;
}

interface RetryOptions {
  retries?: number;
  backoffMs?: number;
}

interface RetryConfig {
  busyTimeoutMs: number;
  lockRetries: number;
  lockBackoffMs: number;
}

interface AppendMessageResult {
  inserted: boolean;
  message: MessageRecord;
}

interface TaskMutationResult {
  ok: boolean;
  error?: string;
  task?: TaskRecord | null;
}

interface CancelTasksResult {
  cancelled: number;
  tasks: TaskRecord[];
}

const DEFAULT_TASK_LEASE_MS = 5 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function isLockError(error: unknown): boolean {
  const msg = String((error as { message?: unknown })?.message ?? '');
  return msg.includes('database is locked') || msg.includes('SQLITE_BUSY');
}

export function withRetry<T>(operation: () => T, options: RetryOptions = {}): T {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 30;

  let attempt = 0;
  while (attempt <= retries) {
    try {
      return operation();
    } catch (error) {
      if (!isLockError(error) || attempt === retries) {
        throw error;
      }
      const target = Date.now() + backoffMs * Math.pow(2, attempt);
      while (Date.now() < target) {
        // Busy wait is acceptable in this in-process SQLite control path.
      }
    }
    attempt += 1;
  }

  throw new Error('unexpected retry loop exit');
}

function parseJSON<T>(json: unknown, fallback?: T): T {
  const normalizedFallback = (fallback ?? ({} as T));
  try {
    return JSON.parse(String(json)) as T;
  } catch {
    return normalizedFallback;
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeArtifactRefs(artifactRefs: ArtifactRef[] = []): ArtifactRef[] {
  return [...artifactRefs]
    .map((ref) => ({
      artifact_id: String(ref.artifact_id),
      version: Number(ref.version)
    }))
    .sort((a, b) => {
      const aid = a.artifact_id.localeCompare(b.artifact_id);
      if (aid !== 0) return aid;
      return a.version - b.version;
    }) as ArtifactRef[];
}

function normalizeMessagePayload(payload: Partial<MessagePayload> = {}): MessagePayload {
  return {
    summary: String(payload.summary ?? ''),
    artifact_refs: normalizeArtifactRefs(payload.artifact_refs ?? [])
  };
}

function normalizeTeamMode(value: unknown): TeamMode {
  if (value === 'delegate' || value === 'plan') return value;
  return 'default';
}

function normalizeTeamId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHierarchyDepth(value: unknown): number {
  const depth = Number(value);
  if (!Number.isFinite(depth) || depth < 0) return 0;
  return Math.floor(depth);
}

function payloadEquals(a: Partial<MessagePayload>, b: Partial<MessagePayload>): boolean {
  const left = normalizeMessagePayload(a);
  const right = normalizeMessagePayload(b);
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SqliteStore {
  readonly dbPath: string;
  readonly options: RetryConfig;
  readonly db: DatabaseSync;

  constructor(dbPath: string, options: StoreOptions = {}) {
    this.dbPath = dbPath;
    this.options = {
      busyTimeoutMs: options.busyTimeoutMs ?? 500,
      lockRetries: options.lockRetries ?? 3,
      lockBackoffMs: options.lockBackoffMs ?? 30
    };

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.configurePragmas();
  }

  configurePragmas(): void {
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec(`PRAGMA busy_timeout=${this.options.busyTimeoutMs};`);
  }

  close(): void {
    this.db.close();
  }

  runWithRetry<T>(operation: () => T): T {
    return withRetry(operation, {
      retries: this.options.lockRetries,
      backoffMs: this.options.lockBackoffMs
    });
  }

  migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);'
    );
    const files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const already = this.db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version);
      if (already) continue;

      const sql = readFileSync(join(migrationDir, file), 'utf8');
      this.runWithRetry(() => {
        this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
        try {
          this.db.exec(sql);
          this.db
            .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
            .run(version, nowIso());
          this.db.exec('COMMIT;');
        } catch (error) {
          this.db.exec('ROLLBACK;');
          throw error;
        }
      });
    }
  }

  createTeam(team: TeamCreateInput): TeamRecord | null {
    const parentTeamId = normalizeTeamId(team.parent_team_id);
    try {
      this.runWithRetry(() => {
        this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
        try {
          let rootTeamId = team.team_id;
          let hierarchyDepth = 0;
          if (parentTeamId) {
            const parent = this.db
              .prepare('SELECT team_id, root_team_id, hierarchy_depth FROM teams WHERE team_id = ?')
              .get(parentTeamId);
            if (!parent) {
              throw new Error(`parent team not found: ${parentTeamId}`);
            }
            rootTeamId = normalizeTeamId(parent.root_team_id) ?? String(parent.team_id);
            hierarchyDepth = normalizeHierarchyDepth(parent.hierarchy_depth) + 1;
          }

          this.db
            .prepare(
              'INSERT INTO teams(team_id, parent_team_id, root_team_id, hierarchy_depth, status, mode, profile, objective, max_threads, session_model, created_at, updated_at, last_active_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              team.team_id,
              parentTeamId,
              rootTeamId,
              hierarchyDepth,
              team.status,
              team.mode ?? 'default',
              team.profile,
              team.objective ?? null,
              team.max_threads,
              team.session_model ?? null,
              team.created_at,
              team.updated_at,
              team.last_active_at ?? team.updated_at,
              JSON.stringify(team.metadata ?? {})
            );

          this.db
            .prepare(
              'INSERT OR IGNORE INTO team_hierarchy(ancestor_team_id, descendant_team_id, depth, created_at) VALUES(?, ?, 0, ?)'
            )
            .run(team.team_id, team.team_id, team.created_at);

          if (parentTeamId) {
            const ancestorRows = this.db
              .prepare(
                'SELECT ancestor_team_id, depth FROM team_hierarchy WHERE descendant_team_id = ? ORDER BY depth ASC'
              )
              .all(parentTeamId);
            const insertAncestor = this.db.prepare(
              'INSERT OR IGNORE INTO team_hierarchy(ancestor_team_id, descendant_team_id, depth, created_at) VALUES(?, ?, ?, ?)'
            );
            for (const row of ancestorRows) {
              insertAncestor.run(
                String(row.ancestor_team_id),
                team.team_id,
                normalizeHierarchyDepth(row.depth) + 1,
                team.created_at
              );
            }
          }
          this.db.exec('COMMIT;');
        } catch (error) {
          this.db.exec('ROLLBACK;');
          throw error;
        }
      });
    } catch {
      return null;
    }
    return this.getTeam(team.team_id);
  }

  getTeam(teamId: string): TeamRecord | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE team_id = ?').get(teamId);
    if (!row) return null;
    return {
      ...row,
      parent_team_id: normalizeTeamId(row.parent_team_id),
      root_team_id: normalizeTeamId(row.root_team_id) ?? String(row.team_id),
      hierarchy_depth: normalizeHierarchyDepth(row.hierarchy_depth),
      mode: normalizeTeamMode(row.mode),
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    } as TeamRecord;
  }

  listTeams(): TeamRecord[] {
    const rows = this.db.prepare('SELECT * FROM teams ORDER BY created_at').all();
    return rows.map((row) => ({
      ...row,
      parent_team_id: normalizeTeamId(row.parent_team_id),
      root_team_id: normalizeTeamId(row.root_team_id) ?? String(row.team_id),
      hierarchy_depth: normalizeHierarchyDepth(row.hierarchy_depth),
      mode: normalizeTeamMode(row.mode),
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    })) as TeamRecord[];
  }

  listChildTeams(parentTeamId: string, recursive = false): TeamRecord[] {
    if (!recursive) {
      const rows = this.db
        .prepare('SELECT * FROM teams WHERE parent_team_id = ? ORDER BY created_at ASC')
        .all(parentTeamId);
      return rows.map((row) => ({
        ...row,
        parent_team_id: normalizeTeamId(row.parent_team_id),
        root_team_id: normalizeTeamId(row.root_team_id) ?? String(row.team_id),
        hierarchy_depth: normalizeHierarchyDepth(row.hierarchy_depth),
        mode: normalizeTeamMode(row.mode),
        metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
      })) as TeamRecord[];
    }

    const rows = this.db
      .prepare(
        `SELECT t.*
         FROM team_hierarchy h
         JOIN teams t ON t.team_id = h.descendant_team_id
         WHERE h.ancestor_team_id = ? AND h.depth > 0
         ORDER BY h.depth ASC, t.created_at ASC`
      )
      .all(parentTeamId);
    return rows.map((row) => ({
      ...row,
      parent_team_id: normalizeTeamId(row.parent_team_id),
      root_team_id: normalizeTeamId(row.root_team_id) ?? String(row.team_id),
      hierarchy_depth: normalizeHierarchyDepth(row.hierarchy_depth),
      mode: normalizeTeamMode(row.mode),
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    })) as TeamRecord[];
  }

  listTeamLineage(teamId: string): TeamRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.*
         FROM team_hierarchy h
         JOIN teams t ON t.team_id = h.ancestor_team_id
         WHERE h.descendant_team_id = ? AND h.depth > 0
         ORDER BY h.depth DESC, t.created_at ASC`
      )
      .all(teamId);
    return rows.map((row) => ({
      ...row,
      parent_team_id: normalizeTeamId(row.parent_team_id),
      root_team_id: normalizeTeamId(row.root_team_id) ?? String(row.team_id),
      hierarchy_depth: normalizeHierarchyDepth(row.hierarchy_depth),
      mode: normalizeTeamMode(row.mode),
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    })) as TeamRecord[];
  }

  isDescendantTeam(ancestorTeamId: string, descendantTeamId: string, allowSame = true): boolean {
    if (allowSame && ancestorTeamId === descendantTeamId) return true;
    const row = this.db
      .prepare(
        `SELECT 1 as ok
         FROM team_hierarchy
         WHERE ancestor_team_id = ? AND descendant_team_id = ? AND depth > 0
         LIMIT 1`
      )
      .get(ancestorTeamId, descendantTeamId);
    return Boolean(row);
  }

  listTeamHierarchyLinks(teamId: string): TeamHierarchyLinkRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ancestor_team_id, descendant_team_id, depth, created_at
         FROM team_hierarchy
         WHERE ancestor_team_id = ? OR descendant_team_id = ?
         ORDER BY ancestor_team_id ASC, descendant_team_id ASC`
      )
      .all(teamId, teamId);
    return rows.map((row) => ({
      ancestor_team_id: String(row.ancestor_team_id),
      descendant_team_id: String(row.descendant_team_id),
      depth: normalizeHierarchyDepth(row.depth),
      created_at: String(row.created_at)
    }));
  }

  updateTeamStatus(teamId: string, status: TeamStatus): TeamRecord | null {
    this.runWithRetry(() => {
      this.db.prepare('UPDATE teams SET status = ?, updated_at = ?, last_active_at = ? WHERE team_id = ?').run(status, nowIso(), nowIso(), teamId);
    });
    return this.getTeam(teamId);
  }

  updateTeamProfile(teamId: string, profile: string, maxThreads: number): TeamRecord | null {
    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE teams SET profile = ?, max_threads = ?, updated_at = ?, last_active_at = ? WHERE team_id = ?')
        .run(profile, maxThreads, nowIso(), nowIso(), teamId);
    });
    return this.getTeam(teamId);
  }

  updateTeamMode(teamId: string, mode: TeamMode): TeamRecord | null {
    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE teams SET mode = ?, updated_at = ?, last_active_at = ? WHERE team_id = ?')
        .run(mode, nowIso(), nowIso(), teamId);
    });
    return this.getTeam(teamId);
  }

  updateTeamMetadata(teamId: string, metadataPatch: Record<string, unknown>): TeamRecord | null {
    const team = this.getTeam(teamId);
    if (!team) return null;

    const mergedMetadata = {
      ...(team.metadata ?? {}),
      ...metadataPatch
    };

    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE teams SET metadata_json = ?, updated_at = ?, last_active_at = ? WHERE team_id = ?')
        .run(JSON.stringify(mergedMetadata), nowIso(), nowIso(), teamId);
    });
    return this.getTeam(teamId);
  }

  createAgent(agent: AgentCreateInput): AgentRecord | null {
    this.runWithRetry(() => {
      this.db
        .prepare('INSERT INTO agents(agent_id, team_id, role, status, model, last_heartbeat_at, created_at, updated_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          agent.agent_id,
          agent.team_id,
          agent.role,
          agent.status,
          agent.model ?? null,
          agent.last_heartbeat_at ?? null,
          agent.created_at,
          agent.updated_at ?? agent.created_at,
          JSON.stringify(agent.metadata ?? {})
        );
    });
    this.touchTeam(agent.team_id);
    return this.getAgent(agent.agent_id);
  }

  getAgent(agentId: string): AgentRecord | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
    if (!row) return null;
    return {
      ...row,
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    } as AgentRecord;
  }

  listAgentsByTeam(teamId: string): AgentRecord[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE team_id = ? ORDER BY created_at').all(teamId);
    return rows.map((row) => ({ ...row, metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {}) })) as AgentRecord[];
  }

  updateAgentStatus(agentId: string, status: AgentRecord['status']): AgentRecord | null {
    this.runWithRetry(() => {
      this.db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE agent_id = ?').run(status, nowIso(), agentId);
    });
    return this.getAgent(agentId);
  }

  heartbeatAgent(agentId: string, at = nowIso()): AgentRecord | null {
    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE agents SET last_heartbeat_at = ?, updated_at = ? WHERE agent_id = ?')
        .run(at, at, agentId);
    });
    return this.getAgent(agentId);
  }

  appendMessage(message: AppendMessageInput): AppendMessageResult {
    const result = this.runWithRetry(() => {
      const existing = this.db
        .prepare('SELECT * FROM messages WHERE team_id = ? AND idempotency_key = ?')
        .get(message.team_id, message.idempotency_key);
      if (existing) {
        return {
          inserted: false,
          message: {
            ...existing,
            payload: parseJSON<MessagePayload>(existing.payload_json)
          }
        };
      }

      this.db
        .prepare(
          'INSERT INTO messages(message_id, team_id, from_agent_id, to_agent_id, delivery_mode, payload_json, idempotency_key, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          message.message_id,
          message.team_id,
          message.from_agent_id,
          message.to_agent_id ?? null,
          message.delivery_mode,
          JSON.stringify(message.payload),
          message.idempotency_key,
          message.created_at
        );

      if (message.recipient_agent_ids?.length) {
        const stmt = this.db.prepare('INSERT OR IGNORE INTO inbox(message_id, team_id, agent_id, delivered_at, ack_at) VALUES(?, ?, ?, ?, NULL)');
        for (const agentId of message.recipient_agent_ids) {
          stmt.run(message.message_id, message.team_id, agentId, message.created_at);
        }
      }

      const inserted = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(message.message_id);
      if (!inserted) {
        throw new Error(`failed to read inserted message: ${message.message_id}`);
      }
      return {
        inserted: true,
        message: {
          ...inserted,
          payload: parseJSON<MessagePayload>(inserted.payload_json)
        }
      };
    });
    this.touchTeam(message.team_id);
    return result as AppendMessageResult;
  }

  getLatestRouteMessage({
    team_id,
    from_agent_id,
    to_agent_id = null,
    delivery_mode
  }: Pick<MessageRecord, 'team_id' | 'from_agent_id' | 'delivery_mode'> & { to_agent_id?: string | null }): MessageRecord | null {
    let row;
    if (delivery_mode === 'direct') {
      row = this.db
        .prepare(
          `SELECT *
           FROM messages
           WHERE team_id = ? AND from_agent_id = ? AND to_agent_id = ? AND delivery_mode = 'direct'
           ORDER BY created_at DESC, message_id DESC
           LIMIT 1`
        )
        .get(team_id, from_agent_id, to_agent_id);
    } else {
      row = this.db
        .prepare(
          `SELECT *
           FROM messages
           WHERE team_id = ? AND from_agent_id = ? AND delivery_mode = 'broadcast'
           ORDER BY created_at DESC, message_id DESC
           LIMIT 1`
        )
        .get(team_id, from_agent_id);
    }

    if (!row) return null;
    return {
      ...row,
      payload: parseJSON<MessagePayload>(row.payload_json)
    } as MessageRecord;
  }

  findRecentDuplicateMessage({
    team_id,
    from_agent_id,
    to_agent_id = null,
    delivery_mode,
    payload,
    within_ms = 120000,
    limit = 25
  }: Pick<MessageRecord, 'team_id' | 'from_agent_id' | 'delivery_mode'> & {
    to_agent_id?: string | null;
    payload: MessagePayload;
    within_ms?: number;
    limit?: number;
  }): MessageRecord | null {
    let rows;
    if (delivery_mode === 'direct') {
      rows = this.db
        .prepare(
          `SELECT *
           FROM messages
           WHERE team_id = ? AND from_agent_id = ? AND to_agent_id = ? AND delivery_mode = 'direct'
           ORDER BY created_at DESC, message_id DESC
           LIMIT ?`
        )
        .all(team_id, from_agent_id, to_agent_id, limit);
    } else {
      rows = this.db
        .prepare(
          `SELECT *
           FROM messages
           WHERE team_id = ? AND from_agent_id = ? AND delivery_mode = 'broadcast'
           ORDER BY created_at DESC, message_id DESC
           LIMIT ?`
        )
        .all(team_id, from_agent_id, limit);
    }

    const cutoffMs = Date.now() - within_ms;
    for (const row of rows) {
      const createdAtMs = Date.parse(String(row.created_at ?? ''));
      if (Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) {
        continue;
      }
      const candidatePayload = parseJSON<MessagePayload>(row.payload_json);
      if (payloadEquals(candidatePayload, payload)) {
        return {
          ...row,
          payload: candidatePayload
        } as MessageRecord;
      }
    }
    return null;
  }

  pullInbox(teamId: string, agentId: string, limit = 20): InboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT i.id as inbox_id, i.message_id, i.delivered_at, m.from_agent_id, m.to_agent_id, m.delivery_mode, m.payload_json, m.idempotency_key
         FROM inbox i
         JOIN messages m ON m.message_id = i.message_id
         WHERE i.team_id = ? AND i.agent_id = ? AND i.ack_at IS NULL
         ORDER BY i.delivered_at ASC
         LIMIT ?`
      )
      .all(teamId, agentId, limit);

    return rows.map((row) => ({
      inbox_id: Number(row.inbox_id),
      message_id: String(row.message_id),
      delivered_at: String(row.delivered_at),
      from_agent_id: String(row.from_agent_id),
      to_agent_id: row.to_agent_id ? String(row.to_agent_id) : null,
      delivery_mode: String(row.delivery_mode) as InboxRecord['delivery_mode'],
      idempotency_key: String(row.idempotency_key),
      payload: parseJSON<MessagePayload>(row.payload_json)
    }));
  }

  ackInbox(inboxIds: number[] = []): number {
    if (inboxIds.length === 0) return 0;
    const stmt = this.db.prepare('UPDATE inbox SET ack_at = ? WHERE id = ?');
    let count = 0;
    this.runWithRetry(() => {
      for (const id of inboxIds) {
        const res = stmt.run(nowIso(), id);
        count += Number(res.changes || 0);
      }
    });
    return count;
  }

  createTask(task: TaskCreateInput): TaskRecord | null {
    this.runWithRetry(() => {
      this.db
        .prepare(
          'INSERT INTO tasks(task_id, team_id, title, description, required_role, status, priority, claimed_by, lease_owner_agent_id, lease_expires_at, lock_version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          task.task_id,
          task.team_id,
          task.title,
          task.description ?? '',
          task.required_role ?? null,
          task.status,
          task.priority,
          task.claimed_by ?? null,
          task.lease_owner_agent_id ?? null,
          task.lease_expires_at ?? null,
          task.lock_version ?? 0,
          task.created_at,
          task.updated_at
        );
    });
    this.touchTeam(task.team_id);
    return this.getTask(task.task_id);
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    return (row as unknown as TaskRecord) ?? null;
  }

  listTasks(teamId: string, status: TaskRecord['status'] | null = null): TaskRecord[] {
    if (status) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE team_id = ? AND status = ? ORDER BY priority ASC, created_at ASC')
        .all(teamId, status) as unknown as TaskRecord[];
    }
    return this.db
      .prepare('SELECT * FROM tasks WHERE team_id = ? ORDER BY priority ASC, created_at ASC')
      .all(teamId) as unknown as TaskRecord[];
  }

  claimTask({ team_id, task_id, agent_id, expected_lock_version }: ClaimTaskInput): TaskMutationResult {
    const current = this.db.prepare('SELECT * FROM tasks WHERE team_id = ? AND task_id = ?').get(team_id, task_id);
    if (!current) {
      return { ok: false, error: `task not found: ${task_id}` };
    }

    if (current.lock_version !== expected_lock_version) {
      return {
        ok: false,
        error: `lock conflict for task ${task_id}: expected ${expected_lock_version}, actual ${current.lock_version}`
      };
    }

    if (current.status !== 'todo') {
      return { ok: false, error: `task not claimable from status ${current.status}` };
    }

    const unresolvedDependencies = this.countUnresolvedDependencies(team_id, task_id);
    if (unresolvedDependencies > 0) {
      return { ok: false, error: `task ${task_id} has unresolved dependencies (${unresolvedDependencies})` };
    }

    let changes = 0;
    const leaseExpiresAt = new Date(Date.now() + DEFAULT_TASK_LEASE_MS).toISOString();
    this.runWithRetry(() => {
      const result = this.db
        .prepare(
          'UPDATE tasks SET claimed_by = ?, status = ?, lease_owner_agent_id = ?, lease_expires_at = ?, lock_version = lock_version + 1, updated_at = ? WHERE team_id = ? AND task_id = ? AND lock_version = ?'
        )
        .run(agent_id, 'in_progress', agent_id, leaseExpiresAt, nowIso(), team_id, task_id, expected_lock_version);
      changes = Number(result.changes || 0);
    });

    if (changes === 0) {
      const latest = this.getTask(task_id);
      return {
        ok: false,
        error: `lock conflict for task ${task_id}: expected ${expected_lock_version}, actual ${latest?.lock_version ?? 'unknown'}`
      };
    }

    return { ok: true, task: this.getTask(task_id) };
  }

  updateTask({ team_id, task_id, expected_lock_version, patch }: UpdateTaskInput): TaskMutationResult {
    const current = this.db.prepare('SELECT * FROM tasks WHERE team_id = ? AND task_id = ?').get(team_id, task_id);
    if (!current) {
      return { ok: false, error: `task not found: ${task_id}` };
    }

    if (current.lock_version !== expected_lock_version) {
      return {
        ok: false,
        error: `lock conflict for task ${task_id}: expected ${expected_lock_version}, actual ${current.lock_version}`
      };
    }

    const next = {
      status: patch.status ?? current.status,
      description: patch.description ?? current.description,
      required_role: patch.required_role ?? current.required_role,
      priority: patch.priority ?? current.priority
    };
    const clearLease = next.status === 'done' || next.status === 'cancelled';

    let changes = 0;
    this.runWithRetry(() => {
      const result = this.db
        .prepare(
          'UPDATE tasks SET status = ?, description = ?, required_role = ?, priority = ?, lease_owner_agent_id = ?, lease_expires_at = ?, lock_version = lock_version + 1, updated_at = ? WHERE team_id = ? AND task_id = ? AND lock_version = ?'
        )
        .run(
          next.status,
          next.description,
          next.required_role ?? null,
          next.priority,
          clearLease ? null : current.lease_owner_agent_id ?? null,
          clearLease ? null : current.lease_expires_at ?? null,
          nowIso(),
          team_id,
          task_id,
          expected_lock_version
        );
      changes = Number(result.changes || 0);
    });

    if (changes === 0) {
      const latest = this.getTask(task_id);
      return {
        ok: false,
        error: `lock conflict for task ${task_id}: expected ${expected_lock_version}, actual ${latest?.lock_version ?? 'unknown'}`
      };
    }

    return { ok: true, task: this.getTask(task_id) };
  }

  cancelTasks({
    team_id,
    loser_task_ids,
    reason = 'speculative_loser'
  }: {
    team_id: string;
    loser_task_ids: string[];
    reason?: string;
  }): CancelTasksResult {
    const ids = [...new Set(loser_task_ids)];
    if (!ids.length) {
      return { cancelled: 0, tasks: [] };
    }

    const stmt = this.db.prepare(
      `UPDATE tasks
       SET status = 'cancelled',
           description = CASE
             WHEN description IS NULL OR description = '' THEN ?
             ELSE description || '\n' || ?
           END,
           lock_version = lock_version + 1,
           updated_at = ?
       WHERE team_id = ?
         AND task_id = ?
         AND status IN ('todo', 'in_progress', 'blocked')`
    );

    let cancelled = 0;
    const now = nowIso();
    this.runWithRetry(() => {
      for (const taskId of ids) {
        const res = stmt.run(
          `[cancelled] ${reason}`,
          `[cancelled] ${reason}`,
          now,
          team_id,
          taskId
        );
        cancelled += Number(res.changes || 0);
      }
    });

    const tasks = ids
      .map((taskId) => this.getTask(taskId))
      .filter((task): task is TaskRecord => Boolean(task && task.team_id === team_id));
    return { cancelled, tasks };
  }

  publishArtifact({
    artifact_id,
    team_id,
    name,
    content,
    published_by = null,
    metadata = {}
  }: PublishArtifactInput): ArtifactRecord | null {
    const existingMax = this.db
      .prepare('SELECT MAX(version) as max_version FROM artifacts WHERE artifact_id = ? AND team_id = ?')
      .get(artifact_id, team_id);
    const nextVersion = Number(existingMax?.max_version || 0) + 1;
    const createdAt = nowIso();
    const checksum = sha256(content);

    this.runWithRetry(() => {
      this.db
        .prepare(
          'INSERT INTO artifacts(artifact_id, team_id, name, version, checksum, content, created_at, published_by, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          artifact_id,
          team_id,
          name,
          nextVersion,
          checksum,
          content,
          createdAt,
          published_by,
          JSON.stringify(metadata)
        );
    });
    this.touchTeam(team_id);

    return this.getArtifact(team_id, artifact_id, nextVersion);
  }

  getArtifact(teamId: string, artifactId: string, version: number | null = null): ArtifactRecord | null {
    let row;
    if (version === null || version === undefined) {
      row = this.db
        .prepare('SELECT * FROM artifacts WHERE team_id = ? AND artifact_id = ? ORDER BY version DESC LIMIT 1')
        .get(teamId, artifactId);
    } else {
      row = this.db
        .prepare('SELECT * FROM artifacts WHERE team_id = ? AND artifact_id = ? AND version = ?')
        .get(teamId, artifactId, version);
    }

    if (!row) return null;
    return {
      ...row,
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    } as ArtifactRecord;
  }

  listArtifacts(teamId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.*
         FROM artifacts a
         INNER JOIN (
           SELECT artifact_id, MAX(version) AS max_version
           FROM artifacts
           WHERE team_id = ?
           GROUP BY artifact_id
         ) latest
         ON latest.artifact_id = a.artifact_id AND latest.max_version = a.version
         WHERE a.team_id = ?
         ORDER BY a.created_at ASC`
      )
      .all(teamId, teamId);

    return rows.map((row) => ({
      ...row,
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    })) as ArtifactRecord[];
  }

  touchTeam(teamId: string, at = nowIso()): void {
    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE teams SET last_active_at = ?, updated_at = ? WHERE team_id = ?')
        .run(at, at, teamId);
    });
  }

  listActiveTeams(): TeamRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM teams WHERE status = ? ORDER BY last_active_at ASC')
      .all('active');
    return rows.map((row) => ({
      ...row,
      parent_team_id: normalizeTeamId(row.parent_team_id),
      root_team_id: normalizeTeamId(row.root_team_id) ?? String(row.team_id),
      hierarchy_depth: normalizeHierarchyDepth(row.hierarchy_depth),
      mode: normalizeTeamMode(row.mode),
      metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {})
    })) as TeamRecord[];
  }

  logEvent(event: RunEventRecord): void {
    this.runWithRetry(() => {
      this.db
        .prepare(
          'INSERT INTO run_events(team_id, agent_id, task_id, message_id, artifact_id, event_type, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          event.team_id ?? null,
          event.agent_id ?? null,
          event.task_id ?? null,
          event.message_id ?? null,
          event.artifact_id ?? null,
          event.event_type,
          JSON.stringify(event.payload ?? {}),
          event.created_at ?? nowIso()
        );
    });
  }

  listEvents(teamId: string, limit = 100): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE team_id = ? ORDER BY id DESC LIMIT ?')
      .all(teamId, limit);
    return rows.map((row) => ({ ...row, payload: parseJSON<Record<string, unknown>>(row.payload_json, {}) }));
  }

  listUsageSamples(teamId: string, limit = 200): UsageSample[] {
    const rows = this.db
      .prepare(
        `SELECT id, team_id, agent_id, payload_json, created_at
         FROM run_events
         WHERE team_id = ? AND event_type = 'usage_sample'
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(teamId, limit);

    return rows.map((row) => {
      const payload = parseJSON<Record<string, unknown>>(row.payload_json, {});
      return {
        id: Number(row.id),
        team_id: String(row.team_id),
        agent_id: row.agent_id ? String(row.agent_id) : null,
        created_at: String(row.created_at),
        tool_name: String(payload.tool_name ?? 'unknown'),
        role: String(payload.role ?? 'unknown'),
        estimated_tokens: Number(payload.estimated_tokens ?? 0),
        latency_ms: Number(payload.latency_ms ?? 0),
        input_tokens: Number(payload.input_tokens ?? 0),
        output_tokens: Number(payload.output_tokens ?? 0)
      };
    });
  }

  listUsageSamplesGlobal(limit = 400): UsageSample[] {
    const rows = this.db
      .prepare(
        `SELECT id, team_id, agent_id, payload_json, created_at
         FROM run_events
         WHERE event_type = 'usage_sample'
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit);

    return rows.map((row) => {
      const payload = parseJSON<Record<string, unknown>>(row.payload_json, {});
      return {
        id: Number(row.id),
        team_id: String(row.team_id),
        agent_id: row.agent_id ? String(row.agent_id) : null,
        created_at: String(row.created_at),
        tool_name: String(payload.tool_name ?? 'unknown'),
        role: String(payload.role ?? 'unknown'),
        estimated_tokens: Number(payload.estimated_tokens ?? 0),
        latency_ms: Number(payload.latency_ms ?? 0),
        input_tokens: Number(payload.input_tokens ?? 0),
        output_tokens: Number(payload.output_tokens ?? 0)
      };
    });
  }

  summarizeUsage(teamId: string, limit = 500): Record<string, unknown> {
    const samples = this.listUsageSamples(teamId, limit);
    type UsageAggregate = {
      samples: number;
      estimated_tokens: number;
      latency_ms: number;
      avg_estimated_tokens?: number;
      avg_latency_ms?: number;
    };
    const byRole: Record<string, UsageAggregate> = {};
    const byTool: Record<string, UsageAggregate> = {};

    let tokenSum = 0;
    let latencySum = 0;
    for (const sample of samples) {
      tokenSum += sample.estimated_tokens;
      latencySum += sample.latency_ms;

      if (!byRole[sample.role]) {
        byRole[sample.role] = { samples: 0, estimated_tokens: 0, latency_ms: 0 };
      }
      byRole[sample.role].samples += 1;
      byRole[sample.role].estimated_tokens += sample.estimated_tokens;
      byRole[sample.role].latency_ms += sample.latency_ms;

      if (!byTool[sample.tool_name]) {
        byTool[sample.tool_name] = { samples: 0, estimated_tokens: 0, latency_ms: 0 };
      }
      byTool[sample.tool_name].samples += 1;
      byTool[sample.tool_name].estimated_tokens += sample.estimated_tokens;
      byTool[sample.tool_name].latency_ms += sample.latency_ms;
    }

    const finalizeAverageMap = (map: Record<string, UsageAggregate>): Record<string, UsageAggregate> => {
      for (const key of Object.keys(map)) {
        const entry = map[key];
        entry.avg_estimated_tokens = entry.samples > 0
          ? Math.round(entry.estimated_tokens / entry.samples)
          : 0;
        entry.avg_latency_ms = entry.samples > 0
          ? Math.round(entry.latency_ms / entry.samples)
          : 0;
      }
      return map;
    };

    return {
      sample_count: samples.length,
      avg_estimated_tokens: samples.length > 0 ? Math.round(tokenSum / samples.length) : 0,
      avg_latency_ms: samples.length > 0 ? Math.round(latencySum / samples.length) : 0,
      by_role: finalizeAverageMap(byRole),
      by_tool: finalizeAverageMap(byTool)
    };
  }

  replayEvents(teamId: string, limit = 1000): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE team_id = ? ORDER BY id ASC LIMIT ?')
      .all(teamId, limit);
    return rows.map((row) => ({ ...row, payload: parseJSON<Record<string, unknown>>(row.payload_json, {}) }));
  }

  summarizeTeam(teamId: string): Record<string, unknown> | null {
    const team = this.getTeam(teamId);
    if (!team) return null;

    const agents = Number(this.db.prepare('SELECT COUNT(*) as n FROM agents WHERE team_id = ?').get(teamId)?.n ?? 0);
    const messages = Number(this.db.prepare('SELECT COUNT(*) as n FROM messages WHERE team_id = ?').get(teamId)?.n ?? 0);
    const artifacts = Number(this.db.prepare('SELECT COUNT(*) as n FROM artifacts WHERE team_id = ?').get(teamId)?.n ?? 0);
    const tasks = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
           SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
         FROM tasks
         WHERE team_id = ?`
      )
      .get(teamId) ?? {};
    const events = Number(this.db.prepare('SELECT COUNT(*) as n FROM run_events WHERE team_id = ?').get(teamId)?.n ?? 0);

    return {
      team_id: teamId,
      status: team.status,
      profile: team.profile,
      created_at: team.created_at,
      updated_at: team.updated_at,
      last_active_at: team.last_active_at,
      metrics: {
        agents,
        messages,
        artifacts,
        tasks: {
          todo: Number((tasks as Record<string, unknown>).todo ?? 0),
          in_progress: Number((tasks as Record<string, unknown>).in_progress ?? 0),
          blocked: Number((tasks as Record<string, unknown>).blocked ?? 0),
          done: Number((tasks as Record<string, unknown>).done ?? 0),
          cancelled: Number((tasks as Record<string, unknown>).cancelled ?? 0)
        },
        events
      },
      usage: this.summarizeUsage(teamId, 500)
    };
  }

  listTaskDependencyEdges(teamId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT team_id, task_id, depends_on_task_id, created_at
         FROM task_dependencies
         WHERE team_id = ?
         ORDER BY task_id ASC, depends_on_task_id ASC`
      )
      .all(teamId);
  }

  getTaskDependencies(teamId: string, taskId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT depends_on_task_id
         FROM task_dependencies
         WHERE team_id = ? AND task_id = ?
         ORDER BY depends_on_task_id ASC`
      )
      .all(teamId, taskId);
    return rows.map((row) => String(row.depends_on_task_id));
  }

  setTaskDependencies({
    team_id,
    task_id,
    depends_on_task_ids
  }: {
    team_id: string;
    task_id: string;
    depends_on_task_ids: string[];
  }): void {
    const unique = [...new Set(depends_on_task_ids)];
    this.runWithRetry(() => {
      this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
      try {
        this.db
          .prepare('DELETE FROM task_dependencies WHERE team_id = ? AND task_id = ?')
          .run(team_id, task_id);

        if (unique.length > 0) {
          const insert = this.db.prepare(
            `INSERT INTO task_dependencies(team_id, task_id, depends_on_task_id, created_at)
             VALUES(?, ?, ?, ?)`
          );
          const createdAt = nowIso();
          for (const dependsOnTaskId of unique) {
            insert.run(team_id, task_id, dependsOnTaskId, createdAt);
          }
        }
        this.db.exec('COMMIT;');
      } catch (error) {
        this.db.exec('ROLLBACK;');
        throw error;
      }
    });
  }

  countUnresolvedDependencies(teamId: string, taskId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n
         FROM task_dependencies td
         JOIN tasks dep
           ON dep.team_id = td.team_id
          AND dep.task_id = td.depends_on_task_id
         WHERE td.team_id = ? AND td.task_id = ? AND dep.status != 'done'`
      )
      .get(teamId, taskId);
    return Number(row?.n ?? 0);
  }

  refreshTaskReadiness(teamId: string, taskId: string): TaskRecord | null {
    const current = this.db
      .prepare('SELECT * FROM tasks WHERE team_id = ? AND task_id = ?')
      .get(teamId, taskId);
    if (!current) return null;
    if (current.status === 'done' || current.status === 'in_progress' || current.status === 'cancelled') return current as unknown as TaskRecord;

    const unresolved = this.countUnresolvedDependencies(teamId, taskId);
    if (unresolved > 0 && current.status !== 'blocked') {
      this.runWithRetry(() => {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'blocked', lock_version = lock_version + 1, updated_at = ?
             WHERE team_id = ? AND task_id = ?`
          )
          .run(nowIso(), teamId, taskId);
      });
    }
    if (unresolved === 0 && current.status === 'blocked') {
      this.runWithRetry(() => {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'todo', lock_version = lock_version + 1, updated_at = ?
             WHERE team_id = ? AND task_id = ?`
          )
          .run(nowIso(), teamId, taskId);
      });
    }
    return this.getTask(taskId);
  }

  refreshDependentTasks(teamId: string, completedTaskId: string): TaskRecord[] {
    const dependents = this.db
      .prepare(
        `SELECT DISTINCT task_id
         FROM task_dependencies
         WHERE team_id = ? AND depends_on_task_id = ?`
      )
      .all(teamId, completedTaskId)
      .map((row) => String(row.task_id));

    const promoted = [];
    for (const taskId of dependents) {
      const before = this.getTask(taskId);
      const after = this.refreshTaskReadiness(teamId, taskId);
      if (before?.status === 'blocked' && after?.status === 'todo') {
        promoted.push(after);
      }
    }
    return promoted;
  }

  refreshAllTaskReadiness(teamId: string): void {
    const candidates = this.db
      .prepare(
        `SELECT task_id
         FROM tasks
         WHERE team_id = ? AND status IN ('todo', 'blocked')
         ORDER BY created_at ASC`
      )
      .all(teamId)
      .map((row) => String(row.task_id));

    for (const taskId of candidates) {
      this.refreshTaskReadiness(teamId, taskId);
    }
  }

  listReadyTasks(teamId: string, limit = 20): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.*
         FROM tasks t
         LEFT JOIN task_dependencies td
           ON td.team_id = t.team_id
          AND td.task_id = t.task_id
         LEFT JOIN tasks dep
           ON dep.team_id = td.team_id
          AND dep.task_id = td.depends_on_task_id
          AND dep.status != 'done'
         WHERE t.team_id = ? AND t.status = 'todo'
         GROUP BY t.task_id
         HAVING COUNT(dep.task_id) = 0
         ORDER BY t.priority ASC, t.created_at ASC
         LIMIT ?`
      )
      .all(teamId, limit);
    return rows as unknown as TaskRecord[];
  }

  acquireTaskLease({
    team_id,
    task_id,
    agent_id,
    lease_ms = DEFAULT_TASK_LEASE_MS,
    expected_lock_version = null
  }: {
    team_id: string;
    task_id: string;
    agent_id: string;
    lease_ms?: number;
    expected_lock_version?: number | null;
  }): TaskMutationResult {
    const current = this.db.prepare('SELECT * FROM tasks WHERE team_id = ? AND task_id = ?').get(team_id, task_id);
    if (!current) {
      return { ok: false, error: `task not found: ${task_id}` };
    }
    if (current.status !== 'in_progress') {
      return { ok: false, error: `task lease requires in_progress status (current: ${current.status})` };
    }
    if (expected_lock_version !== null && current.lock_version !== expected_lock_version) {
      return { ok: false, error: `lock conflict for task ${task_id}: expected ${expected_lock_version}, actual ${current.lock_version}` };
    }

    const expiresAtMs = Date.parse(String(current.lease_expires_at ?? ''));
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
    const owner = current.lease_owner_agent_id ? String(current.lease_owner_agent_id) : null;
    const canAcquire = !owner || owner === agent_id || expired;
    if (!canAcquire) {
      return { ok: false, error: `lease is currently held by ${owner}` };
    }

    const safeLeaseMs = Math.max(1, Math.floor(Number(lease_ms) || DEFAULT_TASK_LEASE_MS));
    const leaseExpiresAt = new Date(Date.now() + safeLeaseMs).toISOString();
    let changes = 0;
    this.runWithRetry(() => {
      const result = this.db
        .prepare(
          'UPDATE tasks SET lease_owner_agent_id = ?, lease_expires_at = ?, lock_version = lock_version + 1, updated_at = ? WHERE team_id = ? AND task_id = ? AND lock_version = ?'
        )
        .run(agent_id, leaseExpiresAt, nowIso(), team_id, task_id, current.lock_version);
      changes = Number(result.changes || 0);
    });
    if (changes === 0) {
      const latest = this.getTask(task_id);
      return { ok: false, error: `lock conflict for task ${task_id}: actual ${latest?.lock_version ?? 'unknown'}` };
    }

    return { ok: true, task: this.getTask(task_id) };
  }

  renewTaskLease({
    team_id,
    task_id,
    agent_id,
    lease_ms = DEFAULT_TASK_LEASE_MS
  }: {
    team_id: string;
    task_id: string;
    agent_id: string;
    lease_ms?: number;
  }): TaskMutationResult {
    const current = this.db.prepare('SELECT * FROM tasks WHERE team_id = ? AND task_id = ?').get(team_id, task_id);
    if (!current) {
      return { ok: false, error: `task not found: ${task_id}` };
    }
    if (String(current.lease_owner_agent_id ?? '') !== agent_id) {
      return { ok: false, error: `lease owner mismatch for task ${task_id}` };
    }

    const safeLeaseMs = Math.max(1, Math.floor(Number(lease_ms) || DEFAULT_TASK_LEASE_MS));
    const leaseExpiresAt = new Date(Date.now() + safeLeaseMs).toISOString();
    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE team_id = ? AND task_id = ?')
        .run(leaseExpiresAt, nowIso(), team_id, task_id);
    });
    return { ok: true, task: this.getTask(task_id) };
  }

  releaseTaskLease({
    team_id,
    task_id,
    agent_id
  }: {
    team_id: string;
    task_id: string;
    agent_id: string;
  }): TaskMutationResult {
    const current = this.db.prepare('SELECT * FROM tasks WHERE team_id = ? AND task_id = ?').get(team_id, task_id);
    if (!current) {
      return { ok: false, error: `task not found: ${task_id}` };
    }
    if (String(current.lease_owner_agent_id ?? '') !== agent_id) {
      return { ok: false, error: `lease owner mismatch for task ${task_id}` };
    }

    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE tasks SET lease_owner_agent_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE team_id = ? AND task_id = ?')
        .run(nowIso(), team_id, task_id);
    });
    return { ok: true, task: this.getTask(task_id) };
  }

  listExpiredTaskLeases(team_id: string, now = nowIso()): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM tasks
         WHERE team_id = ?
           AND status = 'in_progress'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC, updated_at ASC`
      )
      .all(team_id, now);
    return rows as unknown as TaskRecord[];
  }

  recoverExpiredTaskLeases(team_id: string, now = nowIso()): { recovered: number; tasks: TaskRecord[] } {
    const expired = this.listExpiredTaskLeases(team_id, now);
    if (!expired.length) {
      return { recovered: 0, tasks: [] };
    }

    const update = this.db.prepare(
      `UPDATE tasks
       SET status = 'todo',
           claimed_by = NULL,
           lease_owner_agent_id = NULL,
           lease_expires_at = NULL,
           lock_version = lock_version + 1,
           updated_at = ?
       WHERE team_id = ?
         AND task_id = ?
         AND status = 'in_progress'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?`
    );

    let recovered = 0;
    this.runWithRetry(() => {
      for (const task of expired) {
        const result = update.run(nowIso(), team_id, task.task_id, now);
        recovered += Number(result.changes || 0);
      }
    });

    const tasks = expired
      .map((task) => this.getTask(task.task_id))
      .filter((task): task is TaskRecord => Boolean(task));

    return { recovered, tasks };
  }

  markStaleAgentsOffline(team_id: string, cutoff_iso: string): { marked_offline: number; agents: AgentRecord[] } {
    const candidates = this.db
      .prepare(
        `SELECT *
         FROM agents
         WHERE team_id = ?
           AND status != 'offline'
           AND COALESCE(last_heartbeat_at, created_at) <= ?
         ORDER BY updated_at ASC, agent_id ASC`
      )
      .all(team_id, cutoff_iso) as unknown as AgentRecord[];

    if (!candidates.length) {
      return { marked_offline: 0, agents: [] };
    }

    let marked = 0;
    this.runWithRetry(() => {
      const update = this.db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE team_id = ? AND agent_id = ? AND status != ?');
      for (const agent of candidates) {
        const result = update.run('offline', nowIso(), team_id, agent.agent_id, 'offline');
        marked += Number(result.changes || 0);
      }
    });

    const agents = candidates
      .map((agent) => this.getAgent(agent.agent_id))
      .filter((agent): agent is AgentRecord => Boolean(agent));
    return {
      marked_offline: marked,
      agents
    };
  }
}
