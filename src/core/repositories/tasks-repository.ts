import type { TasksLocalResource, TaskRow, TaskRunLogRow } from '../db/index.js';

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

export interface TasksRepository {
  save: (task: NewScheduledTask) => void;
  getById: (id: string) => ScheduledTask | undefined;
  getByGroup: (groupFolder: string) => ScheduledTask[];
  getAll: () => ScheduledTask[];
  update: (task: ScheduledTask) => void;
  delete: (id: string) => void;
  getDue: () => ScheduledTask[];
  updateAfterRun: (id: string, lastResult: string, nextRun?: string) => void;
  saveRunLog: (log: TaskRunLog) => void;
}

export const createTasksRepository = (resource: TasksLocalResource): TasksRepository => ({
  save: (task) => {
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

  getById: (id) => {
    const row = resource.getById(id);
    return row ? toScheduledTask(row) : undefined;
  },

  getByGroup: (groupFolder) => resource.getForGroup(groupFolder).map(toScheduledTask),

  getAll: () => resource.getAll().map(toScheduledTask),

  update: (task) => {
    resource.update(task.id, toTaskRow(task));
  },

  delete: (id) => {
    resource.delete(id);
  },

  getDue: () => resource.getDue().map(toScheduledTask),

  updateAfterRun: (id, lastResult, nextRun = undefined) => resource.updateAfterRun(id, nextRun ?? null, lastResult),

  saveRunLog: (log) => resource.logRun(toTaskRunLogRow(log)),
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

const toTaskRunLogRow = (log: TaskRunLog): TaskRunLogRow => ({
  task_id: log.taskId,
  run_at: log.runAt,
  duration_ms: log.durationMs,
  status: log.status,
  result: log.result ?? null,
  error: log.error ?? null,
});
