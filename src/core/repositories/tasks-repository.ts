import { CronExpressionParser } from 'cron-parser';

import { logger } from '../../logger.js';
import type { TasksLocalResource, TaskRow, TaskRunLogRow } from '../db/index.js';
import { TIMEZONE } from '../../config.js';

// --- Types and interfaces ---

export interface NewScheduledTask {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  script?: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  nextRun: string;
}

export interface ScheduledTask extends Omit<NewScheduledTask, `nextRun`> {
  status: 'active' | 'paused' | 'completed';
  createdAt: string;
  nextRun?: string;
  lastRun?: string;
  lastResult?: string;
}

export interface TaskRunLog {
  taskId: string;
  runAt: string;
  durationMs: number;
  status: 'success' | 'error';
  result?: string;
  error?: string;
}

// --- Repository interface and implementation ---

export interface TasksRepository {
  saveTask: (task: NewScheduledTask) => void;
  getTaskById: (id: string) => ScheduledTask | undefined;
  getAllTasksForGroup: (groupFolder: string) => ScheduledTask[];
  getAllTasks: () => ScheduledTask[];
  updateTask: (task: ScheduledTask) => void;
  deleteTask: (id: string) => void;
  getAllDueScheduledTasks: () => ScheduledTask[];
  updateAfterRun: (id: string, lastResult: string, nextRun?: string) => void;
  saveTaskRunLog: (log: TaskRunLog) => void;
}

export const createTasksRepository = (resource: TasksLocalResource): TasksRepository => ({
  saveTask: (task) => {
    resource.create({
      id: task.id,
      group_folder: task.groupFolder,
      chat_jid: task.chatJid,
      prompt: task.prompt,
      script: task.script ?? null,
      schedule_type: task.scheduleType,
      schedule_value: task.scheduleValue,
      context_mode: task.contextMode || 'isolated',
      next_run: task.nextRun ?? null,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
  },

  getTaskById: (id) => {
    const row = resource.getById(id);
    return row ? toScheduledTask(row) : undefined;
  },

  getAllTasksForGroup: (groupFolder) => resource.getForGroup(groupFolder).map(toScheduledTask),

  getAllTasks: () => resource.getAll().map(toScheduledTask),

  updateTask: (task) => {
    resource.update(task.id, toTaskRow(task));
  },

  deleteTask: (id) => {
    resource.delete(id);
  },

  getAllDueScheduledTasks: () => resource.getDue().map(toScheduledTask),

  updateAfterRun: (id, lastResult, nextRun = undefined) => resource.updateAfterRun(id, nextRun ?? null, lastResult),

  saveTaskRunLog: (log) => resource.logRun(toTaskRunLogRow(log)),
});

// --- Mapping functions ---

const toScheduledTask = (row: TaskRow): ScheduledTask => ({
  id: row.id,
  groupFolder: row.group_folder,
  chatJid: row.chat_jid,
  prompt: row.prompt,
  script: row.script ?? undefined,
  scheduleType: row.schedule_type as ScheduledTask['scheduleType'],
  scheduleValue: row.schedule_value,
  contextMode: row.context_mode as ScheduledTask['contextMode'],
  nextRun: row.next_run ?? undefined,
  lastRun: row.last_run ?? undefined,
  lastResult: row.last_result ?? undefined,
  status: row.status as ScheduledTask['status'],
  createdAt: row.created_at,
});

const toTaskRow = (task: ScheduledTask): TaskRow => ({
  id: task.id,
  group_folder: task.groupFolder,
  chat_jid: task.chatJid,
  prompt: task.prompt,
  script: task.script ?? null,
  schedule_type: task.scheduleType,
  schedule_value: task.scheduleValue,
  context_mode: task.contextMode || 'isolated',
  next_run: task.nextRun ?? null,
  last_run: task.lastRun ?? null,
  last_result: task.lastResult ?? null,
  status: task.status,
  created_at: task.createdAt,
});

const toTaskRunLog = (row: TaskRunLogRow): TaskRunLog => ({
  taskId: row.task_id,
  runAt: row.run_at,
  durationMs: row.duration_ms,
  status: row.status as TaskRunLog['status'],
  result: row.result ?? undefined,
  error: row.error ?? undefined,
});

const toTaskRunLogRow = (log: TaskRunLog): TaskRunLogRow => ({
  task_id: log.taskId,
  run_at: log.runAt,
  duration_ms: log.durationMs,
  status: log.status,
  result: log.result ?? null,
  error: log.error ?? null,
});

// -- Utility functions --

export const computeNextRun = ({ scheduleType, scheduleValue }: { scheduleType: 'cron' | 'interval' | 'once'; scheduleValue: string }): string => {
  const computeCronNextRun = () => {
    let nextRun: string | null = null;

    try {
      const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
      nextRun = interval.next().toISOString();
    } catch (error) {
      logger.warn({ scheduleValue }, 'Invalid cron expression');
      throw new Error(`Invalid cron expression: ${scheduleValue}`, { cause: error });
    }

    if (!nextRun) {
      logger.warn({ scheduleValue }, 'Cron expression has no future runs');
      throw new Error(`Cron expression has no future runs: ${scheduleValue}`);
    }

    return nextRun;
  };
  const computeIntervalNextRun = () => {
    const ms = parseInt(scheduleValue, 10);

    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue }, 'Invalid interval');
      throw new Error(`Invalid interval (must be positive integer in milliseconds): ${scheduleValue}`);
    }

    return new Date(Date.now() + ms).toISOString();
  };
  const computeOnceNextRun = () => {
    const date = new Date(scheduleValue);

    if (isNaN(date.getTime())) {
      logger.warn({ scheduleValue }, 'Invalid timestamp');
      throw new Error(`Invalid timestamp for one-time task: ${scheduleValue}`);
    }

    return date.toISOString();
  };

  if (scheduleType === 'cron') {
    return computeCronNextRun();
  } else if (scheduleType === 'interval') {
    return computeIntervalNextRun();
  } else if (scheduleType === 'once') {
    return computeOnceNextRun();
  } else {
    throw new Error(`Unsupported schedule type: ${scheduleType}`);
  }
};
