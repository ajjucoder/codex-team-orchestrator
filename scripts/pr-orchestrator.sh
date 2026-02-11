#!/usr/bin/env bash
set -euo pipefail

manifest=""
dry_run="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      manifest="$2"
      shift 2
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    --apply)
      dry_run="false"
      shift
      ;;
    *)
      echo "pr-orchestrator:error unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$manifest" ]]; then
  echo "pr-orchestrator:error --manifest is required" >&2
  exit 1
fi

node --input-type=module - "$manifest" "$dry_run" <<'NODE'
import { readFileSync } from 'node:fs';

const manifestPath = process.argv[2];
const dryRun = process.argv[3] === 'true';

const riskRank = { P0: 0, P1: 1, P2: 2 };
const payload = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(payload) || payload.length === 0) {
  throw new Error('manifest must be a non-empty array');
}

const normalized = payload.map((entry, index) => {
  if (!entry || typeof entry !== 'object') throw new Error(`invalid entry at index ${index}`);
  const ticketId = String(entry.ticket_id ?? '');
  const branch = String(entry.pushed_branch ?? entry.branch ?? '');
  const commitSha = String(entry.commit_sha ?? '');
  const riskTier = String(entry.risk_tier ?? '');
  const testEvidence = String(entry.test_evidence ?? '');
  const commitMessage = String(entry.commit_message ?? '');

  if (!/^CTO-P[0-2]-\d{3}$/.test(ticketId)) {
    throw new Error(`invalid ticket_id: ${ticketId}`);
  }
  if (!branch) throw new Error(`missing branch for ${ticketId}`);
  if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) throw new Error(`invalid commit_sha for ${ticketId}`);
  if (!(riskTier in riskRank)) throw new Error(`invalid risk_tier for ${ticketId}`);
  if (!testEvidence) throw new Error(`missing test_evidence for ${ticketId}`);
  if (commitMessage && !commitMessage.startsWith(`${ticketId}:`)) {
    throw new Error(`commit_message must start with ticket id for ${ticketId}`);
  }

  return {
    ticket_id: ticketId,
    branch,
    commit_sha: commitSha,
    risk_tier: riskTier,
    test_evidence: testEvidence
  };
});

normalized.sort((a, b) => {
  const riskDelta = riskRank[a.risk_tier] - riskRank[b.risk_tier];
  if (riskDelta !== 0) return riskDelta;
  return a.ticket_id.localeCompare(b.ticket_id);
});

console.log(`pr-orchestrator:dry_run=${dryRun}`);
console.log(`pr-orchestrator:queue_size=${normalized.length}`);
console.log(`pr-orchestrator:queue_order=${normalized.map((entry) => entry.ticket_id).join(',')}`);

for (const entry of normalized) {
  console.log(
    `pr-orchestrator:item ticket=${entry.ticket_id} branch=${entry.branch} risk=${entry.risk_tier} commit=${entry.commit_sha} tests=${entry.test_evidence}`
  );
}

if (!dryRun) {
  console.log('pr-orchestrator:apply=not_implemented_safe_mode');
}
console.log('pr-orchestrator:ok');
NODE
