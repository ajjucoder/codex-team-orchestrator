import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, 'migrations');

function nowIso() {
  return new Date().toISOString();
}

function isLockError(error) {
  const msg = String(error?.message || '');
  return msg.includes('database is locked') || msg.includes('SQLITE_BUSY');
}

export function withRetry(operation, options = {}) {
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

function parseJSON(json, fallback = {}) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export class SqliteStore {
  constructor(dbPath, options = {}) {
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

  configurePragmas() {
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec(`PRAGMA busy_timeout=${this.options.busyTimeoutMs};`);
  }

  close() {
    this.db.close();
  }

  runWithRetry(operation) {
    return withRetry(operation, {
      retries: this.options.lockRetries,
      backoffMs: this.options.lockBackoffMs
    });
  }

  migrate() {
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

  createTeam(team) {
    this.runWithRetry(() => {
      this.db
        .prepare(
          'INSERT INTO teams(team_id, status, profile, objective, max_threads, session_model, created_at, updated_at, last_active_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          team.team_id,
          team.status,
          team.profile,
          team.objective ?? null,
          team.max_threads,
          team.session_model ?? null,
          team.created_at,
          team.updated_at,
          team.last_active_at ?? team.updated_at,
          JSON.stringify(team.metadata ?? {})
        );
    });
    return this.getTeam(team.team_id);
  }

  getTeam(teamId) {
    const row = this.db.prepare('SELECT * FROM teams WHERE team_id = ?').get(teamId);
    if (!row) return null;
    return {
      ...row,
      metadata: parseJSON(row.metadata_json)
    };
  }

  listTeams() {
    const rows = this.db.prepare('SELECT * FROM teams ORDER BY created_at').all();
    return rows.map((row) => ({ ...row, metadata: parseJSON(row.metadata_json) }));
  }

  updateTeamStatus(teamId, status) {
    this.runWithRetry(() => {
      this.db.prepare('UPDATE teams SET status = ?, updated_at = ?, last_active_at = ? WHERE team_id = ?').run(status, nowIso(), nowIso(), teamId);
    });
    return this.getTeam(teamId);
  }

  updateTeamProfile(teamId, profile, maxThreads) {
    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE teams SET profile = ?, max_threads = ?, updated_at = ?, last_active_at = ? WHERE team_id = ?')
        .run(profile, maxThreads, nowIso(), nowIso(), teamId);
    });
    return this.getTeam(teamId);
  }

  createAgent(agent) {
    this.runWithRetry(() => {
      this.db
        .prepare('INSERT INTO agents(agent_id, team_id, role, status, model, created_at, updated_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          agent.agent_id,
          agent.team_id,
          agent.role,
          agent.status,
          agent.model ?? null,
          agent.created_at,
          agent.updated_at ?? agent.created_at,
          JSON.stringify(agent.metadata ?? {})
        );
    });
    this.touchTeam(agent.team_id);
    return this.getAgent(agent.agent_id);
  }

  getAgent(agentId) {
    const row = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
    if (!row) return null;
    return {
      ...row,
      metadata: parseJSON(row.metadata_json)
    };
  }

  listAgentsByTeam(teamId) {
    const rows = this.db.prepare('SELECT * FROM agents WHERE team_id = ? ORDER BY created_at').all(teamId);
    return rows.map((row) => ({ ...row, metadata: parseJSON(row.metadata_json) }));
  }

  updateAgentStatus(agentId, status) {
    this.runWithRetry(() => {
      this.db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE agent_id = ?').run(status, nowIso(), agentId);
    });
    return this.getAgent(agentId);
  }

  appendMessage(message) {
    const result = this.runWithRetry(() => {
      const existing = this.db
        .prepare('SELECT * FROM messages WHERE team_id = ? AND idempotency_key = ?')
        .get(message.team_id, message.idempotency_key);
      if (existing) {
        return {
          inserted: false,
          message: {
            ...existing,
            payload: parseJSON(existing.payload_json)
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
      return {
        inserted: true,
        message: {
          ...inserted,
          payload: parseJSON(inserted.payload_json)
        }
      };
    });
    this.touchTeam(message.team_id);
    return result;
  }

  pullInbox(teamId, agentId, limit = 20) {
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
      inbox_id: row.inbox_id,
      message_id: row.message_id,
      delivered_at: row.delivered_at,
      from_agent_id: row.from_agent_id,
      to_agent_id: row.to_agent_id,
      delivery_mode: row.delivery_mode,
      idempotency_key: row.idempotency_key,
      payload: parseJSON(row.payload_json)
    }));
  }

  ackInbox(inboxIds = []) {
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

  createTask(task) {
    this.runWithRetry(() => {
      this.db
        .prepare(
          'INSERT INTO tasks(task_id, team_id, title, description, status, priority, claimed_by, lock_version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          task.task_id,
          task.team_id,
          task.title,
          task.description ?? '',
          task.status,
          task.priority,
          task.claimed_by ?? null,
          task.lock_version ?? 0,
          task.created_at,
          task.updated_at
        );
    });
    this.touchTeam(task.team_id);
    return this.getTask(task.task_id);
  }

  getTask(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    return row ?? null;
  }

  listTasks(teamId, status = null) {
    if (status) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE team_id = ? AND status = ? ORDER BY priority ASC, created_at ASC')
        .all(teamId, status);
    }
    return this.db
      .prepare('SELECT * FROM tasks WHERE team_id = ? ORDER BY priority ASC, created_at ASC')
      .all(teamId);
  }

  claimTask({ team_id, task_id, agent_id, expected_lock_version }) {
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

    let changes = 0;
    this.runWithRetry(() => {
      const result = this.db
        .prepare(
          'UPDATE tasks SET claimed_by = ?, status = ?, lock_version = lock_version + 1, updated_at = ? WHERE team_id = ? AND task_id = ? AND lock_version = ?'
        )
        .run(agent_id, 'in_progress', nowIso(), team_id, task_id, expected_lock_version);
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

  updateTask({ team_id, task_id, expected_lock_version, patch }) {
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
      priority: patch.priority ?? current.priority
    };

    let changes = 0;
    this.runWithRetry(() => {
      const result = this.db
        .prepare(
          'UPDATE tasks SET status = ?, description = ?, priority = ?, lock_version = lock_version + 1, updated_at = ? WHERE team_id = ? AND task_id = ? AND lock_version = ?'
        )
        .run(next.status, next.description, next.priority, nowIso(), team_id, task_id, expected_lock_version);
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

  publishArtifact({ artifact_id, team_id, name, content, published_by = null, metadata = {} }) {
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

  getArtifact(teamId, artifactId, version = null) {
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
      metadata: parseJSON(row.metadata_json)
    };
  }

  listArtifacts(teamId) {
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
      metadata: parseJSON(row.metadata_json)
    }));
  }

  touchTeam(teamId, at = nowIso()) {
    this.runWithRetry(() => {
      this.db
        .prepare('UPDATE teams SET last_active_at = ?, updated_at = ? WHERE team_id = ?')
        .run(at, at, teamId);
    });
  }

  listActiveTeams() {
    return this.db.prepare('SELECT * FROM teams WHERE status = ? ORDER BY last_active_at ASC').all('active');
  }

  logEvent(event) {
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

  listEvents(teamId, limit = 100) {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE team_id = ? ORDER BY id DESC LIMIT ?')
      .all(teamId, limit);
    return rows.map((row) => ({ ...row, payload: parseJSON(row.payload_json) }));
  }

  replayEvents(teamId, limit = 1000) {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE team_id = ? ORDER BY id ASC LIMIT ?')
      .all(teamId, limit);
    return rows.map((row) => ({ ...row, payload: parseJSON(row.payload_json) }));
  }

  summarizeTeam(teamId) {
    const team = this.getTeam(teamId);
    if (!team) return null;

    const agents = Number(this.db.prepare('SELECT COUNT(*) as n FROM agents WHERE team_id = ?').get(teamId).n);
    const messages = Number(this.db.prepare('SELECT COUNT(*) as n FROM messages WHERE team_id = ?').get(teamId).n);
    const artifacts = Number(this.db.prepare('SELECT COUNT(*) as n FROM artifacts WHERE team_id = ?').get(teamId).n);
    const tasks = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
           SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
         FROM tasks
         WHERE team_id = ?`
      )
      .get(teamId);
    const events = Number(this.db.prepare('SELECT COUNT(*) as n FROM run_events WHERE team_id = ?').get(teamId).n);

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
          todo: Number(tasks.todo || 0),
          in_progress: Number(tasks.in_progress || 0),
          blocked: Number(tasks.blocked || 0),
          done: Number(tasks.done || 0)
        },
        events
      }
    };
  }
}
