import { logger } from '../logger.js';
import { RegisteredGroup } from './repositories/groups-repository.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

interface GroupData {
  jid: string;
  group: RegisteredGroup;
  prompt: string;
}

// interface GroupState {
//   active: boolean;
//   isTaskContainer: boolean;
//   runningTaskId: string | null;
//   pendingTasks: QueuedTask[];
//   process: ChildProcess | null;
//   containerName: string | null;
//   groupFolder: string | null;
// }

interface GroupQueueDeps {
  runAgent: (jid: string, group: RegisteredGroup, prompt: string) => { pipe: (prompt: string) => void; done: Promise<void> };
}

export class GroupQueue {
  private queue: GroupData[] = [];
  private shuttingDown = false;
  private deps: GroupQueueDeps;
  private pipe?: (prompt: string) => void = undefined;
  private runningJid?: string = undefined;

  constructor(deps: GroupQueueDeps) {
    this.deps = deps;
  }

  // private getGroup(groupJid: string): GroupState {
  //   let state = this.groups.get(groupJid);
  //   if (!state) {
  //     state = {
  //       active: false,
  //       isTaskContainer: false,
  //       runningTaskId: null,
  //       pendingTasks: [],
  //       process: null,
  //       containerName: null,
  //       groupFolder: null,
  //     };
  //     this.groups.set(groupJid, state);
  //   }
  //   return state;
  // }

  deliver(groupJid: string, group: RegisteredGroup, prompt: string): boolean {
    if (this.shuttingDown) return false;

    // const state = this.getGroup(groupJid);
    // if (state.active) {
    //   logger.debug({ groupJid }, 'Agent already active, delivery rejected');
    //   return false;
    // }

    // if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
    //   logger.debug({ groupJid, activeCount: this.activeCount }, 'At concurrency limit, delivery rejected');
    //   return false;
    // }
    // state.active = true;
    // state.groupFolder = groupFolder;
    // this.activeCount++;
    // logger.debug({ groupJid, activeCount: this.activeCount }, 'Spawning agent for group');

    // this.deps
    //   .runAgent(groupJid, groupFolder, prompt)
    //   .catch((err) => {
    //     logger.error({ groupJid, err }, 'Error in runAgent');
    //   })
    //   .finally(() => {
    //     state.active = false;
    //     state.process = null;
    //     state.containerName = null;
    //     state.groupFolder = null;
    //     this.activeCount--;
    //   });

    if (this.runningJid !== undefined) {
      if (this.pipe && this.runningJid === groupJid) {
        this.pipe(prompt);
        logger.debug({ groupJid }, 'Piped message to running agent');
        return true;
      }

      this.queue.push({ jid: groupJid, group, prompt });
      logger.debug({ groupJid, queueLength: this.queue.length }, 'Agent busy, message queued');
      return false;
    }

    this.runningJid = groupJid;
    logger.debug({ groupJid }, 'Spawning agent for group');

    const channel = this.deps.runAgent(groupJid, group, prompt);
    this.pipe = channel.pipe;
    channel.done
      .catch((err) => {
        logger.error({ groupJid, err }, 'Error in runAgent');
      })
      .finally(() => {
        this.pipe = undefined;
        this.runningJid = undefined;
        if (this.queue.length > 0) {
          const next = this.queue.shift()!;
          logger.debug({ groupJid: next.jid, queueLength: this.queue.length }, 'Dequeuing next message');
          this.deliver(next.jid, next.group, next.prompt);
        }
      });

    return true;
  }

  // enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
  //   if (this.shuttingDown) return;
  //
  //   const state = this.getGroup(groupJid);
  //
  //   if (state.runningTaskId === taskId) {
  //     logger.debug({ groupJid, taskId }, 'Task already running, skipping');
  //     return;
  //   }
  //   if (state.pendingTasks.some((t) => t.id === taskId)) {
  //     logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
  //     return;
  //   }
  //
  //   if (state.active) {
  //     state.pendingTasks.push({ id: taskId, groupJid, fn });
  //     logger.debug({ groupJid, taskId }, 'Agent active, task queued');
  //     return;
  //   }
  //
  //   this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) => logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'));
  // }

  // registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void {
  //   const state = this.getGroup(groupJid);
  //   state.process = proc;
  //   state.containerName = containerName;
  //   if (groupFolder) state.groupFolder = groupFolder;
  // }

  // private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
  //   const state = this.getGroup(groupJid);
  //   state.active = true;
  //   state.isTaskContainer = true;
  //   state.runningTaskId = task.id;
  //   this.activeCount++;
  //
  //   logger.debug({ groupJid, taskId: task.id, activeCount: this.activeCount }, 'Running queued task');
  //
  //   try {
  //     await task.fn();
  //   } catch (err) {
  //     logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
  //   } finally {
  //     state.active = false;
  //     state.isTaskContainer = false;
  //     state.runningTaskId = null;
  //     state.process = null;
  //     state.containerName = null;
  //     state.groupFolder = null;
  //     this.activeCount--;
  //     this.drainGroup(groupJid);
  //   }
  // }

  // private drainGroup(groupJid: string): void {
  //   if (this.shuttingDown) return;
  //
  //   const state = this.getGroup(groupJid);
  //
  //   if (state.pendingTasks.length > 0) {
  //     const task = state.pendingTasks.shift()!;
  //     this.runTask(groupJid, task).catch((err) => logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'));
  //   }
  // }

  shutdown() {
    this.shuttingDown = true;
    logger.info({ queueLength: this.queue.length }, 'GroupQueue shutting down');
  }
}
