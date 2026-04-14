import { ChildProcess } from 'child_process';

import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

interface GroupState {
  active: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
}

interface GroupQueueDeps {
  runAgent: (jid: string, groupFolder: string, prompt: string) => Promise<void>;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private shuttingDown = false;
  private deps: GroupQueueDeps;

  constructor(deps: GroupQueueDeps) {
    this.deps = deps;
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  deliver(groupJid: string, groupFolder: string, prompt: string): boolean {
    if (this.shuttingDown) return false;

    const state = this.getGroup(groupJid);
    if (state.active) {
      logger.debug({ groupJid }, 'Agent already active, delivery rejected');
      return false;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      logger.debug({ groupJid, activeCount: this.activeCount }, 'At concurrency limit, delivery rejected');
      return false;
    }
    state.active = true;
    state.groupFolder = groupFolder;
    this.activeCount++;
    logger.debug({ groupJid, activeCount: this.activeCount }, 'Spawning agent for group');

    this.deps
      .runAgent(groupJid, groupFolder, prompt)
      .catch((err) => {
        logger.error({ groupJid, err }, 'Error in runAgent');
      })
      .finally(() => {
        state.active = false;
        state.process = null;
        state.containerName = null;
        state.groupFolder = null;
        this.activeCount--;
      });

    return true;
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.debug({ groupJid, taskId }, 'Agent active, task queued');
      return;
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) => logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'));
  }

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug({ groupJid, taskId: task.id, activeCount: this.activeCount }, 'Running queued task');

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) => logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'));
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    logger.info({ activeCount: this.activeCount }, 'GroupQueue shutting down');
  }
}
