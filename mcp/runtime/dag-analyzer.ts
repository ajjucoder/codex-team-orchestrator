import type { TaskRecord } from '../store/entities.js';

export interface DagDependencyEdge {
  task_id: string;
  depends_on_task_id: string;
}

export interface DagAnalysisResult {
  has_cycle: boolean;
  cycle_task_ids: string[];
  depth_by_task_id: Record<string, number>;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareTaskOrder(left: TaskRecord, right: TaskRecord): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.created_at !== right.created_at) return left.created_at.localeCompare(right.created_at);
  return compareText(left.task_id, right.task_id);
}

function sortTaskIdsByOrder(taskIds: string[], orderByTaskId: Map<string, number>): string[] {
  return [...taskIds].sort((left, right) => {
    const leftOrder = Number(orderByTaskId.get(left) ?? Number.MAX_SAFE_INTEGER);
    const rightOrder = Number(orderByTaskId.get(right) ?? Number.MAX_SAFE_INTEGER);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return compareText(left, right);
  });
}

export function analyzeTaskDag(tasks: TaskRecord[], edges: DagDependencyEdge[]): DagAnalysisResult {
  const orderedTasks = [...tasks].sort(compareTaskOrder);
  const taskById = new Map(orderedTasks.map((task) => [task.task_id, task]));
  const orderByTaskId = new Map(orderedTasks.map((task, index) => [task.task_id, index]));

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const depthByTaskId = new Map<string, number>();
  for (const task of orderedTasks) {
    indegree.set(task.task_id, 0);
    outgoing.set(task.task_id, []);
    depthByTaskId.set(task.task_id, 0);
  }

  const selfCycle = new Set<string>();
  for (const edge of edges) {
    const taskId = String(edge.task_id ?? '').trim();
    const dependsOnTaskId = String(edge.depends_on_task_id ?? '').trim();
    if (!taskById.has(taskId) || !taskById.has(dependsOnTaskId)) {
      continue;
    }
    if (taskId === dependsOnTaskId) {
      selfCycle.add(taskId);
      continue;
    }

    const neighbors = outgoing.get(dependsOnTaskId) ?? [];
    if (!neighbors.includes(taskId)) {
      neighbors.push(taskId);
      outgoing.set(dependsOnTaskId, neighbors);
      indegree.set(taskId, Number(indegree.get(taskId) ?? 0) + 1);
    }
  }

  for (const [taskId, neighbors] of outgoing.entries()) {
    outgoing.set(taskId, sortTaskIdsByOrder(neighbors, orderByTaskId));
  }

  let queue = orderedTasks
    .map((task) => task.task_id)
    .filter((taskId) => Number(indegree.get(taskId) ?? 0) === 0);
  queue = sortTaskIdsByOrder(queue, orderByTaskId);

  let cursor = 0;
  let visitedCount = 0;
  while (cursor < queue.length) {
    const currentTaskId = queue[cursor];
    cursor += 1;
    visitedCount += 1;

    const currentDepth = Number(depthByTaskId.get(currentTaskId) ?? 0);
    const neighbors = outgoing.get(currentTaskId) ?? [];
    for (const nextTaskId of neighbors) {
      const nextDepth = Number(depthByTaskId.get(nextTaskId) ?? 0);
      if (currentDepth + 1 > nextDepth) {
        depthByTaskId.set(nextTaskId, currentDepth + 1);
      }
      const updatedInDegree = Number(indegree.get(nextTaskId) ?? 0) - 1;
      indegree.set(nextTaskId, updatedInDegree);
      if (updatedInDegree === 0) {
        queue.push(nextTaskId);
      }
    }

    if (cursor < queue.length) {
      const remaining = queue.slice(cursor);
      const sortedRemaining = sortTaskIdsByOrder(remaining, orderByTaskId);
      queue = [...queue.slice(0, cursor), ...sortedRemaining];
    }
  }

  const cyclicTaskIds = orderedTasks
    .map((task) => task.task_id)
    .filter((taskId) => Number(indegree.get(taskId) ?? 0) > 0);

  const cycleTaskIds = sortTaskIdsByOrder(
    [...new Set([...cyclicTaskIds, ...selfCycle])],
    orderByTaskId
  );

  return {
    has_cycle: cycleTaskIds.length > 0 || visitedCount < orderedTasks.length,
    cycle_task_ids: cycleTaskIds,
    depth_by_task_id: Object.fromEntries(
      orderedTasks.map((task) => [task.task_id, Number(depthByTaskId.get(task.task_id) ?? 0)])
    )
  };
}
