'use strict';
/**
 * Core Tasks Module
 * Port of Raven/core/tasks.py
 *
 * Node is single-threaded, so "workers" here are concurrent async loops
 * (Promise-based) rather than OS threads - functionally equivalent for the
 * I/O-bound tool calls this queue runs in Raven.
 */

const TaskStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TaskQueue {
  constructor(maxWorkers = 10, queueSize = 100) {
    this.maxWorkers = maxWorkers;
    this.queueSize = queueSize;
    this.tasks = new Map();
    this._queue = [];
    this.running = false;
    this.taskCounter = 0;
    this._workerLoops = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.maxWorkers; i++) {
      this._workerLoops.push(this._worker());
    }
  }

  stop() {
    this.running = false;
  }

  async _worker() {
    while (this.running) {
      const taskId = this._queue.shift();
      if (taskId === undefined) {
        await sleep(50);
        continue;
      }
      const task = this.tasks.get(taskId);
      if (!task) continue;

      const dependenciesMet = task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === TaskStatus.COMPLETED;
      });

      if (!dependenciesMet) {
        this._queue.push(taskId);
        await sleep(100);
        continue;
      }

      await this._executeTask(task);
    }
  }

  async _executeTask(task) {
    task.status = TaskStatus.RUNNING;
    task.started_at = new Date().toISOString();
    try {
      const result = await task.fn(...(task.args || []));
      task.result = result;
      task.status = TaskStatus.COMPLETED;
      task.completed_at = new Date().toISOString();
    } catch (e) {
      task.error = e && e.message ? e.message : String(e);
      task.status = TaskStatus.FAILED;
      task.completed_at = new Date().toISOString();
    }
  }

  submit(name, fn, args = [], kwargs = {}, dependencies = []) {
    this.taskCounter += 1;
    const taskId = `task_${String(this.taskCounter).padStart(4, '0')}`;
    const task = {
      id: taskId,
      name,
      fn,
      args,
      kwargs,
      status: TaskStatus.PENDING,
      result: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      dependencies: dependencies || [],
    };
    this.tasks.set(taskId, task);
    this._queue.push(taskId);
    if (!this.running) this.start();
    return taskId;
  }

  getStatus(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const { id, name, status, result, error, created_at, started_at, completed_at, dependencies } = task;
    return { id, name, status, result, error, created_at, started_at, completed_at, dependencies };
  }

  list() {
    return Array.from(this.tasks.keys()).map((id) => this.getStatus(id));
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if ([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED].includes(task.status)) return false;
    task.status = TaskStatus.CANCELLED;
    task.completed_at = new Date().toISOString();
    return true;
  }

  clearCompleted() {
    let count = 0;
    for (const [id, task] of Array.from(this.tasks.entries())) {
      if ([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED].includes(task.status)) {
        this.tasks.delete(id);
        count += 1;
      }
    }
    return count;
  }

  getStats() {
    const counts = {};
    for (const task of this.tasks.values()) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return {
      total_tasks: this.tasks.size,
      pending_tasks: counts[TaskStatus.PENDING] || 0,
      running_tasks: counts[TaskStatus.RUNNING] || 0,
      completed_tasks: counts[TaskStatus.COMPLETED] || 0,
      failed_tasks: counts[TaskStatus.FAILED] || 0,
      cancelled_tasks: counts[TaskStatus.CANCELLED] || 0,
      queue_size: this._queue.length,
      max_workers: this.maxWorkers,
      active_workers: this.running ? this.maxWorkers : 0,
    };
  }
}

module.exports = { TaskQueue, TaskStatus };
