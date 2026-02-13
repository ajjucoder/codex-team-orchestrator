import { isKnownRole } from './role-pack.js';
import type { AgentRecord } from '../store/entities.js';

type MentionSource = 'summary' | 'mentions';
type MentionKind = 'all' | 'agent' | 'role';

export interface MentionToken {
  raw: string;
  kind: MentionKind;
  value: string | null;
  source: MentionSource;
}

export interface ResolveMentionRecipientsInput {
  summary?: string;
  mentions?: unknown;
  explicit_recipient_agent_ids?: unknown;
  agents: AgentRecord[];
  sender_agent_id?: string | null;
}

export interface ResolveMentionRecipientsResult {
  recipient_agent_ids: string[];
  parsed_mentions: MentionToken[];
  unresolved_mentions: string[];
}

const SUMMARY_MENTION_PATTERN = /@all\b|@agent:[A-Za-z0-9_-]+|@role:[A-Za-z0-9_-]+|@agent_[A-Za-z0-9_-]+/gi;

function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

function normalizeStringList(value: unknown): string[] {
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

function parseMentionToken(rawToken: string, source: MentionSource): MentionToken | null {
  const token = rawToken.trim();
  if (!token.startsWith('@')) return null;

  if (/^@all$/i.test(token)) {
    return {
      raw: token,
      kind: 'all',
      value: null,
      source
    };
  }

  const agentScoped = token.match(/^@agent:([A-Za-z0-9_-]+)$/);
  if (agentScoped) {
    return {
      raw: token,
      kind: 'agent',
      value: agentScoped[1],
      source
    };
  }

  const roleScoped = token.match(/^@role:([A-Za-z0-9_-]+)$/i);
  if (roleScoped) {
    return {
      raw: token,
      kind: 'role',
      value: normalizeRole(roleScoped[1]),
      source
    };
  }

  const agentInline = token.match(/^@(agent_[A-Za-z0-9_-]+)$/);
  if (agentInline) {
    return {
      raw: token,
      kind: 'agent',
      value: agentInline[1],
      source
    };
  }

  return null;
}

function parseSummaryMentions(summary: string): MentionToken[] {
  const parsed: MentionToken[] = [];
  const matches = summary.match(SUMMARY_MENTION_PATTERN) ?? [];
  for (const match of matches) {
    const mention = parseMentionToken(match, 'summary');
    if (!mention) continue;
    parsed.push(mention);
  }
  return parsed;
}

function parseExplicitMentionInputs(mentions: unknown): MentionToken[] {
  const parsed: MentionToken[] = [];
  for (const mention of normalizeStringList(mentions)) {
    const normalized = mention.startsWith('@') ? mention : `@${mention}`;
    const parsedMention = parseMentionToken(normalized, 'mentions');
    if (!parsedMention) continue;
    parsed.push(parsedMention);
  }
  return parsed;
}

export function resolveMentionRecipients({
  summary = '',
  mentions = [],
  explicit_recipient_agent_ids = [],
  agents,
  sender_agent_id = null
}: ResolveMentionRecipientsInput): ResolveMentionRecipientsResult {
  const senderAgentId = typeof sender_agent_id === 'string' ? sender_agent_id : null;
  const parsedMentions = [
    ...parseSummaryMentions(String(summary)),
    ...parseExplicitMentionInputs(mentions)
  ];
  const candidates = new Set<string>();
  const unresolved = new Set<string>();
  const agentById = new Map<string, AgentRecord>();

  for (const agent of agents) {
    agentById.set(agent.agent_id, agent);
  }

  for (const agentId of normalizeStringList(explicit_recipient_agent_ids)) {
    if (!agentById.has(agentId)) {
      unresolved.add(`@agent:${agentId}`);
      continue;
    }
    if (agentId !== senderAgentId) {
      candidates.add(agentId);
    }
  }

  for (const mention of parsedMentions) {
    if (mention.kind === 'all') {
      for (const agent of agents) {
        if (agent.agent_id !== senderAgentId) {
          candidates.add(agent.agent_id);
        }
      }
      continue;
    }

    if (mention.kind === 'agent') {
      const agentId = String(mention.value ?? '');
      if (!agentById.has(agentId)) {
        unresolved.add(mention.raw);
        continue;
      }
      if (agentId !== senderAgentId) {
        candidates.add(agentId);
      }
      continue;
    }

    const role = normalizeRole(String(mention.value ?? ''));
    if (!isKnownRole(role)) {
      unresolved.add(mention.raw);
      continue;
    }
    const roleMatches = agents.filter((agent) => agent.role === role && agent.agent_id !== senderAgentId);
    if (roleMatches.length === 0) {
      unresolved.add(mention.raw);
      continue;
    }
    for (const agent of roleMatches) {
      candidates.add(agent.agent_id);
    }
  }

  const recipientAgentIds = agents
    .map((agent) => agent.agent_id)
    .filter((agentId) => agentId !== senderAgentId && candidates.has(agentId));

  return {
    recipient_agent_ids: recipientAgentIds,
    parsed_mentions: parsedMentions,
    unresolved_mentions: [...unresolved].sort()
  };
}
