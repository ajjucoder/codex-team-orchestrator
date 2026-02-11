import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForensicTimeline, computeReplayDigest } from '../../mcp/server/observability.js';

test('V3-108 unit: replay digest is stable for equivalent forensic timelines', () => {
  const events = [
    { id: 3, event_type: 'tool_call:team_task_update', payload: { ok: true } },
    { id: 1, event_type: 'permission_decision:team_task_update', payload: { allowed: true } },
    { id: 2, event_type: 'hook_pre:task_complete', payload: { ok: true } }
  ];
  const timelineA = buildForensicTimeline(events);
  const timelineB = buildForensicTimeline([...events].reverse());
  const digestA = computeReplayDigest(timelineA);
  const digestB = computeReplayDigest(timelineB);

  assert.equal(digestA, digestB);
  assert.equal(timelineA[0].event_type.startsWith('permission_decision:'), true);
});

test('V3-108 unit: forensic timeline retains deterministic ordering by id and event rank', () => {
  const timeline = buildForensicTimeline([
    { id: 5, event_type: 'tool_call:team_merge_decide', payload: {} },
    { id: 4, event_type: 'mode_decision:team_merge_decide', payload: {} },
    { id: 4, event_type: 'permission_decision:team_merge_decide', payload: {} }
  ]);

  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].event_type, 'permission_decision:team_merge_decide');
  assert.equal(timeline[1].event_type, 'mode_decision:team_merge_decide');
  assert.equal(timeline[2].event_type, 'tool_call:team_merge_decide');
});
