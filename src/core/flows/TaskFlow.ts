import path from 'path';
import fs from 'fs';
import { CronExpressionParser } from 'cron-parser';

import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from '../../config.js';
import { logger } from '../../logger.js';

import { resolveGroupIpcPath } from '../utils/index.js';
import { RegisteredGroup, ScheduledTask } from '../repositories/index.js';

export interface TaskFlow {
  onTasksChangedFor: (group: RegisteredGroup) => void;
  onTasksChanged: () => void;
  startSchedulerLoop: () => void;
}

export interface SnapshotTaskRow {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  status: 'active' | 'paused' | 'completed';
  next_run?: string;
}

interface TasksFlowDeps {
  getAllScheduledTasks: () => ScheduledTask[];
  getAllRegisteredGroupsAsRecord: () => Record<string, RegisteredGroup>;
  getDueTasks: () => ScheduledTask[];
  getTaskById: (id: string) => ScheduledTask | undefined;
  updateTask: (task: ScheduledTask) => void;
  updateTaskAfterRun: (id: string, lastResult: string, nextRun?: string) => void;
  enqueueTask: (jid: string, taskId: string, fn: () => Promise<void>) => void;
  runTaskAgent: (group: RegisteredGroup, task: ScheduledTask) => Promise<{ result: string | null; error: string | null }>;
}

export const createTaskFlow = (deps: TasksFlowDeps): TaskFlow => {
  let schedulerRunning = false;

  const writeTasksSnapshotIntoFile = (folder: string, isMain: boolean, taskRows: SnapshotTaskRow[]) => {
    const groupIpcDir = resolveGroupIpcPath(folder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    const filteredTasks = isMain ? taskRows : taskRows.filter((t) => t.groupFolder === folder);
    const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
  };

  const runTask = async (task: ScheduledTask) => {
    const startTime = Date.now();

    const groups = deps.getAllRegisteredGroupsAsRecord();
    const group = Object.values(groups).find((g) => g.folder === task.groupFolder);
    if (!group) {
      deps.updateTask({ ...task, status: 'paused' });
      logger.error({ taskId: task.id, groupFolder: task.groupFolder }, 'Group not found for task');
      throw Error(`Group not found for task: ${task.id}`);;
    }

    // Write task snapshot for container
    const taskRows = toSnapshotRows(deps.getAllScheduledTasks());
    writeTasksSnapshotIntoFile(group.folder, group.isMain, taskRows);

    logger.info({ taskId: task.id, group: task.groupFolder }, 'Running scheduled task');

    const { result, error } = await deps.runTaskAgent(group, task);

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');

    const nextRun = computeNextRunForRecurringTask(task);
    const resultSummary = error ? `Error: ${error}` : result ? result.slice(0, 200) : 'Completed';
    deps.updateTaskAfterRun(task.id, resultSummary, nextRun);
  };

  const watchForDueTasks = () => {
    const dueTasks = deps.getDueTasks();
    if (dueTasks.length <= 0) return;

    logger.debug({ count: dueTasks.length }, 'Found due tasks');
    for (const task of dueTasks) {
      const currentTask = deps.getTaskById(task.id);
      if (!currentTask || currentTask.status !== 'active') continue;

      deps.enqueueTask(currentTask.chatJid, currentTask.id, () => runTask(currentTask));
    }
  };

  const loop = async () => {
    try {
      watchForDueTasks();
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  return {
    onTasksChangedFor: (group) => {
      const taskRows = toSnapshotRows(deps.getAllScheduledTasks());
      writeTasksSnapshotIntoFile(group.folder, group.isMain, taskRows);
    },

    onTasksChanged: () => {
      const taskRows = toSnapshotRows(deps.getAllScheduledTasks());
      const registeredGroups = deps.getAllRegisteredGroupsAsRecord();
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshotIntoFile(group.folder, group.isMain === true, taskRows);
      }
    },

    startSchedulerLoop: () => {
      if (schedulerRunning) {
        logger.debug('Scheduler loop already running, skipping duplicate start');
        return;
      }
      schedulerRunning = true;
      logger.info('Scheduler loop started');

      loop();
    },
  };
};

// Drift-resistant next run computation for recurring tasks.
// For intervals, anchors to task.nextRun (not Date.now()) to prevent cumulative drift.
const computeNextRunForRecurringTask = (task: ScheduledTask): string | undefined => {
  if (task.scheduleType === 'once') return undefined;

  const now = Date.now();

  if (task.scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(task.scheduleValue, { tz: TIMEZONE });
    return interval.next().toISOString() ?? undefined;
  }

  if (task.scheduleType === 'interval') {
    const ms = parseInt(task.scheduleValue, 10);
    if (!ms || ms <= 0) {
      logger.warn({ taskId: task.id, value: task.scheduleValue }, 'Invalid interval value');
      return new Date(now + 60_000).toISOString();
    }
    let next = new Date(task.nextRun!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return undefined;
};

const toSnapshotRows = (tasks: ScheduledTask[]): SnapshotTaskRow[] =>
  tasks.map((t) => ({
    id: t.id,
    groupFolder: t.groupFolder,
    prompt: t.prompt,
    script: t.script ?? undefined,
    schedule_type: t.scheduleType,
    schedule_value: t.scheduleValue,
    status: t.status,
    next_run: t.nextRun,
  }));
