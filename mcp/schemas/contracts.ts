export interface TeamEntityContract {
  team_id: string;
  parent_team_id?: string | null;
  root_team_id?: string;
  hierarchy_depth?: number;
  status: 'active' | 'idle' | 'paused' | 'finalized' | 'archived';
  mode?: 'default' | 'delegate' | 'plan';
  profile: string;
  objective?: string;
  max_threads: number;
  session_model?: string;
  created_at: string;
  updated_at: string;
  last_active_at?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentEntityContract {
  agent_id: string;
  team_id: string;
  role: string;
  status: 'idle' | 'busy' | 'offline';
  model?: string;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactRefContract {
  artifact_id: string;
  version: number;
}

export interface MessagePayloadContract {
  summary: string;
  artifact_refs: ArtifactRefContract[];
}

export interface MessageEntityContract {
  message_id: string;
  team_id: string;
  from_agent_id: string;
  to_agent_id?: string;
  delivery_mode: 'direct' | 'broadcast';
  payload: MessagePayloadContract;
  idempotency_key: string;
  created_at: string;
}

export interface TaskEntityContract {
  task_id: string;
  team_id: string;
  title: string;
  description?: string;
  required_role?: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority: number;
  claimed_by?: string;
  lock_version?: number;
  created_at: string;
  updated_at?: string;
}

export interface ArtifactEntityContract {
  artifact_id: string;
  team_id: string;
  name: string;
  version: number;
  checksum: string;
  content: string;
  created_at: string;
  published_by?: string;
  metadata?: Record<string, unknown>;
}

export interface PermissionProfileEntityContract {
  allow_all_tools: boolean;
  tools?: Record<string, boolean>;
}

export interface PermissionDecisionAuditContract {
  allowed: boolean;
  evaluated: boolean;
  source_profile: string | null;
  matched_rule: string;
  deny_reason: string | null;
  action?: string | null;
  actor_agent_id?: string | null;
  actor_role?: string | null;
}

export interface EntityContracts {
  'team.schema.json': TeamEntityContract;
  'agent.schema.json': AgentEntityContract;
  'message.schema.json': MessageEntityContract;
  'task.schema.json': TaskEntityContract;
  'artifact.schema.json': ArtifactEntityContract;
  'permission_profile.schema.json': PermissionProfileEntityContract;
}

export interface ToolInputContracts {
  'team_artifact_list.schema.json': { team_id: string };
  'team_artifact_publish.schema.json': { team_id: string; name: string; content: string; artifact_id?: string; published_by?: string; metadata?: Record<string, unknown> };
  'team_artifact_read.schema.json': { team_id: string; artifact_id: string; version?: number };
  'team_agent_heartbeat.schema.json': { team_id: string; agent_id: string; heartbeat_at?: string };
  'team_child_list.schema.json': { team_id: string; recursive?: boolean; include_metrics?: boolean };
  'team_child_start.schema.json': { team_id: string; objective: string; profile?: string; max_threads?: number; session_model?: string };
  'team_broadcast.schema.json': { team_id: string; from_agent_id: string; summary: string; idempotency_key: string; artifact_refs?: ArtifactRefContract[] };
  'team_delegate_task.schema.json': { team_id: string; child_team_id: string; title: string; description?: string; required_role?: string; priority: number };
  'team_finalize.schema.json': { team_id: string; reason?: string };
  'team_guardrail_check.schema.json': { team_id: string; consensus_reached: boolean; open_tasks: number };
  'team_hierarchy_rollup.schema.json': { team_id: string; include_parent?: boolean };
  'team_idle_sweep.schema.json': { now_iso?: string };
  'team_merge_decide.schema.json': { team_id: string; proposal_id: string; strategy: 'consensus' | 'lead' | 'strict_vote'; votes: Array<{ agent_id: string; decision: 'approve' | 'reject' }>; lead_agent_id?: string };
  'team_mode_get.schema.json': { team_id: string };
  'team_mode_set.schema.json': { team_id: string; mode: 'default' | 'delegate' | 'plan'; reason?: string; ttl_ms?: number; requested_by_agent_id?: string };
  'team_orphan_recover.schema.json': { team_id: string; now_iso?: string; agent_stale_ms?: number };
  'team_plan_fanout.schema.json': { team_id: string; task_size: 'small' | 'medium' | 'high'; estimated_parallel_tasks: number; budget_tokens_remaining: number; token_cost_per_agent?: number; planned_roles?: string[] };
  'team_policy_get.schema.json': { team_id: string };
  'team_policy_set_profile.schema.json': { team_id: string; profile: string };
  'team_pull_inbox.schema.json': { team_id: string; agent_id: string; limit?: number; ack_inbox_ids?: number[] };
  'team_replay.schema.json': { team_id: string; limit?: number };
  'team_runtime_rebalance.schema.json': { team_id: string; task_size?: 'small' | 'medium' | 'high'; budget_tokens_remaining?: number; estimated_parallel_tasks?: number; max_scale_up?: number; max_scale_down?: number; allow_busy_scale_down?: boolean };
  'team_resume.schema.json': { team_id: string };
  'team_role_catalog.schema.json': { team_id: string };
  'team_run_summary.schema.json': { team_id: string };
  'team_send.schema.json': { team_id: string; from_agent_id: string; to_agent_id: string; summary: string; idempotency_key: string; artifact_refs?: ArtifactRefContract[] };
  'team_spawn.schema.json': { team_id: string; role: string; model?: string };
  'team_spawn_ready_roles.schema.json': { team_id: string; max_new_agents?: number };
  'team_start.schema.json': { objective: string; profile?: string; max_threads?: number; session_model?: string; parent_team_id?: string };
  'team_status.schema.json': { team_id: string };
  'team_task_cancel_others.schema.json': { team_id: string; winner_task_id: string; loser_task_ids: string[]; reason?: string };
  'team_task_claim.schema.json': { team_id: string; task_id: string; agent_id: string; expected_lock_version: number };
  'team_task_create.schema.json': { team_id: string; title: string; priority: number; description?: string; required_role?: string; depends_on_task_ids?: string[] };
  'team_task_lease_acquire.schema.json': { team_id: string; task_id: string; agent_id: string; lease_ms?: number; expected_lock_version?: number };
  'team_task_lease_release.schema.json': { team_id: string; task_id: string; agent_id: string };
  'team_task_lease_renew.schema.json': { team_id: string; task_id: string; agent_id: string; lease_ms?: number };
  'team_task_list.schema.json': { team_id: string; status?: string };
  'team_task_next.schema.json': { team_id: string; limit?: number };
  'team_task_update.schema.json': { team_id: string; task_id: string; expected_lock_version: number; status?: string; description?: string; priority?: number; required_role?: string; depends_on_task_ids?: string[]; quality_checks_passed?: boolean; artifact_refs_count?: number; compliance_ack?: boolean };
  'team_trigger.schema.json': { prompt: string; profile?: string; task_size?: 'small' | 'medium' | 'high'; max_threads?: number; auto_spawn?: boolean; estimated_parallel_tasks?: number; budget_tokens_remaining?: number; token_cost_per_agent?: number; active_session_model?: string };
}

export interface ToolOutputContracts {
  'team_start.schema.json': { ok: boolean; team?: TeamEntityContract; error?: string };
  'team_spawn.schema.json': { ok: boolean; agent?: AgentEntityContract; error?: string };
  'team_send.schema.json': { ok: boolean; inserted?: boolean; duplicate_suppressed?: boolean; error?: string };
  'team_task_create.schema.json': { ok: boolean; task?: TaskEntityContract; error?: string };
  'team_task_update.schema.json': { ok: boolean; task?: TaskEntityContract; error?: string };
  'team_task_claim.schema.json': { ok: boolean; task?: TaskEntityContract; error?: string };
  'team_artifact_publish.schema.json': { ok: boolean; artifact?: ArtifactEntityContract; error?: string };
  'team_plan_fanout.schema.json': { ok: boolean; recommendation?: { recommended_threads: number }; error?: string };
  'team_trigger.schema.json': { ok: boolean; triggered: boolean; error?: string };
}

export const ENTITY_REQUIRED_FIELDS = {
  'team.schema.json': ['team_id', 'status', 'profile', 'max_threads', 'created_at', 'updated_at'],
  'agent.schema.json': ['agent_id', 'team_id', 'role', 'status', 'created_at'],
  'message.schema.json': ['message_id', 'team_id', 'from_agent_id', 'delivery_mode', 'payload', 'idempotency_key', 'created_at'],
  'task.schema.json': ['task_id', 'team_id', 'title', 'status', 'priority', 'created_at'],
  'artifact.schema.json': ['artifact_id', 'team_id', 'name', 'version', 'checksum', 'content', 'created_at'],
  'permission_profile.schema.json': ['allow_all_tools']
} as const satisfies Record<keyof EntityContracts, readonly string[]>;

export const TOOL_REQUIRED_FIELDS = {
  'team_artifact_list.schema.json': ['team_id'],
  'team_artifact_publish.schema.json': ['team_id', 'name', 'content'],
  'team_artifact_read.schema.json': ['team_id', 'artifact_id'],
  'team_agent_heartbeat.schema.json': ['team_id', 'agent_id'],
  'team_child_list.schema.json': ['team_id'],
  'team_child_start.schema.json': ['team_id', 'objective'],
  'team_broadcast.schema.json': ['team_id', 'from_agent_id', 'summary', 'idempotency_key'],
  'team_delegate_task.schema.json': ['team_id', 'child_team_id', 'title', 'priority'],
  'team_finalize.schema.json': ['team_id'],
  'team_guardrail_check.schema.json': ['team_id', 'consensus_reached', 'open_tasks'],
  'team_hierarchy_rollup.schema.json': ['team_id'],
  'team_idle_sweep.schema.json': [],
  'team_merge_decide.schema.json': ['team_id', 'proposal_id', 'strategy', 'votes'],
  'team_mode_get.schema.json': ['team_id'],
  'team_mode_set.schema.json': ['team_id', 'mode'],
  'team_orphan_recover.schema.json': ['team_id'],
  'team_plan_fanout.schema.json': ['team_id', 'task_size', 'estimated_parallel_tasks', 'budget_tokens_remaining'],
  'team_policy_get.schema.json': ['team_id'],
  'team_policy_set_profile.schema.json': ['team_id', 'profile'],
  'team_pull_inbox.schema.json': ['team_id', 'agent_id'],
  'team_replay.schema.json': ['team_id'],
  'team_runtime_rebalance.schema.json': ['team_id'],
  'team_resume.schema.json': ['team_id'],
  'team_role_catalog.schema.json': ['team_id'],
  'team_run_summary.schema.json': ['team_id'],
  'team_send.schema.json': ['team_id', 'from_agent_id', 'to_agent_id', 'summary', 'idempotency_key'],
  'team_spawn.schema.json': ['team_id', 'role'],
  'team_spawn_ready_roles.schema.json': ['team_id'],
  'team_start.schema.json': ['objective'],
  'team_status.schema.json': ['team_id'],
  'team_task_cancel_others.schema.json': ['team_id', 'winner_task_id', 'loser_task_ids'],
  'team_task_claim.schema.json': ['team_id', 'task_id', 'agent_id', 'expected_lock_version'],
  'team_task_create.schema.json': ['team_id', 'title', 'priority'],
  'team_task_lease_acquire.schema.json': ['team_id', 'task_id', 'agent_id'],
  'team_task_lease_release.schema.json': ['team_id', 'task_id', 'agent_id'],
  'team_task_lease_renew.schema.json': ['team_id', 'task_id', 'agent_id'],
  'team_task_list.schema.json': ['team_id'],
  'team_task_next.schema.json': ['team_id'],
  'team_task_update.schema.json': ['team_id', 'task_id', 'expected_lock_version'],
  'team_trigger.schema.json': ['prompt']
} as const satisfies Record<keyof ToolInputContracts, readonly string[]>;
