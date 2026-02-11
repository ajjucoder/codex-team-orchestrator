import type { TaskRecord } from '../store/entities.js';

type BucketKey = string;

interface TaskBucket {
  key: BucketKey;
  priority: number;
  required_role: string | null;
  tasks: TaskRecord[];
}

function normalizeCursor(cursor: number, size: number): number {
  if (size <= 0) return 0;
  const rounded = Number.isFinite(cursor) ? Math.floor(cursor) : 0;
  const normalized = rounded % size;
  return normalized < 0 ? normalized + size : normalized;
}

function bucketKeyForTask(task: Pick<TaskRecord, 'priority' | 'required_role'>): BucketKey {
  const role = task.required_role ?? '*';
  return `${task.priority}::${role}`;
}

function compareBuckets(a: TaskBucket, b: TaskBucket): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return (a.required_role ?? '').localeCompare(b.required_role ?? '');
}

export class FairTaskQueue {
  private readonly buckets: Map<BucketKey, TaskBucket>;
  private readonly order: BucketKey[];
  private cursorValue: number;

  constructor(tasks: TaskRecord[], cursor = 0) {
    this.buckets = new Map();
    for (const task of tasks) {
      const key = bucketKeyForTask(task);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          priority: task.priority,
          required_role: task.required_role,
          tasks: []
        };
        this.buckets.set(key, bucket);
      }
      bucket.tasks.push(task);
    }

    this.order = [...this.buckets.values()]
      .sort(compareBuckets)
      .map((bucket) => bucket.key);
    this.cursorValue = normalizeCursor(cursor, this.order.length);
  }

  getCursor(): number {
    return this.cursorValue;
  }

  remaining(): number {
    let remainingCount = 0;
    for (const bucket of this.buckets.values()) {
      remainingCount += bucket.tasks.length;
    }
    return remainingCount;
  }

  takeAny(): TaskRecord | null {
    return this.takeMatching(() => true);
  }

  takeForRole(role: string): TaskRecord | null {
    return this.takeMatching((task) => task.required_role === null || task.required_role === role);
  }

  private takeMatching(matches: (task: TaskRecord) => boolean): TaskRecord | null {
    if (this.order.length === 0) return null;

    const bucketCount = this.order.length;
    for (let offset = 0; offset < bucketCount; offset += 1) {
      const index = (this.cursorValue + offset) % bucketCount;
      const key = this.order[index];
      if (!key) continue;

      const bucket = this.buckets.get(key);
      if (!bucket || bucket.tasks.length === 0) continue;

      const taskIndex = bucket.tasks.findIndex(matches);
      if (taskIndex < 0) continue;

      const [task] = bucket.tasks.splice(taskIndex, 1);
      this.cursorValue = (index + 1) % bucketCount;
      return task ?? null;
    }

    return null;
  }
}

export function createFairTaskQueue(tasks: TaskRecord[], cursor = 0): FairTaskQueue {
  return new FairTaskQueue(tasks, cursor);
}
