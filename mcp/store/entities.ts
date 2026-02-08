export type TeamStatus = 'active' | 'idle' | 'paused' | 'finalized' | 'archived';
export type TeamMode = 'default' | 'delegate' | 'plan';
export type AgentStatus = 'idle' | 'busy' | 'offline';
export type DeliveryMode = 'direct' | 'broadcast';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export interface ArtifactRef {
  artifact_id: string;
  version: number;
}

export interface MessagePayload {
  summary: string;
  artifact_refs: ArtifactRef[];
}

export interface TeamRecord {
  team_id: string;
  parent_team_id: string | null;
  root_team_id: string;
  hierarchy_depth: number;
  status: TeamStatus;
  mode: TeamMode;
  profile: string;
  objective: string | null;
  max_threads: number;
  session_model: string | null;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
  metadata: Record<string, unknown>;
}

export interface TeamCreateInput {
  team_id: string;
  parent_team_id?: string | null;
  status: TeamStatus;
  mode?: TeamMode;
  profile: string;
  objective?: string | null;
  max_threads: number;
  session_model?: string | null;
  created_at: string;
  updated_at: string;
  last_active_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TeamHierarchyLinkRecord {
  ancestor_team_id: string;
  descendant_team_id: string;
  depth: number;
  created_at: string;
}

export interface AgentRecord {
  agent_id: string;
  team_id: string;
  role: string;
  status: AgentStatus;
  model: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface AgentCreateInput {
  agent_id: string;
  team_id: string;
  role: string;
  status: AgentStatus;
  model?: string | null;
  last_heartbeat_at?: string | null;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageRecord {
  message_id: string;
  team_id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  delivery_mode: DeliveryMode;
  payload: MessagePayload;
  idempotency_key: string;
  created_at: string;
}

export interface AppendMessageInput extends MessageRecord {
  recipient_agent_ids?: string[];
}

export interface InboxRecord {
  inbox_id: number;
  message_id: string;
  delivered_at: string;
  from_agent_id: string;
  to_agent_id: string | null;
  delivery_mode: DeliveryMode;
  idempotency_key: string;
  payload: MessagePayload;
}

export interface TaskRecord {
  task_id: string;
  team_id: string;
  title: string;
  description: string;
  required_role: string | null;
  status: TaskStatus;
  priority: number;
  claimed_by: string | null;
  lease_owner_agent_id: string | null;
  lease_expires_at: string | null;
  lock_version: number;
  created_at: string;
  updated_at: string;
}

export interface TaskCreateInput {
  task_id: string;
  team_id: string;
  title: string;
  description?: string;
  required_role?: string | null;
  status: TaskStatus;
  priority: number;
  claimed_by?: string | null;
  lease_owner_agent_id?: string | null;
  lease_expires_at?: string | null;
  lock_version?: number;
  created_at: string;
  updated_at: string;
}

export interface ClaimTaskInput {
  team_id: string;
  task_id: string;
  agent_id: string;
  expected_lock_version: number;
}

export interface UpdateTaskPatch {
  status?: TaskStatus;
  description?: string;
  required_role?: string | null;
  priority?: number;
}

export interface UpdateTaskInput {
  team_id: string;
  task_id: string;
  expected_lock_version: number;
  patch: UpdateTaskPatch;
}

export interface CancelTasksInput {
  team_id: string;
  loser_task_ids: string[];
  reason?: string;
}

export interface ArtifactRecord {
  artifact_id: string;
  team_id: string;
  name: string;
  version: number;
  checksum: string;
  content: string;
  created_at: string;
  published_by: string | null;
  metadata: Record<string, unknown>;
}

export interface PublishArtifactInput {
  artifact_id: string;
  team_id: string;
  name: string;
  content: string;
  published_by?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RunEventRecord {
  team_id?: string | null;
  agent_id?: string | null;
  task_id?: string | null;
  message_id?: string | null;
  artifact_id?: string | null;
  event_type: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

export interface UsageSample {
  id: number;
  team_id: string;
  agent_id: string | null;
  created_at: string;
  tool_name: string;
  role: string;
  estimated_tokens: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
}
