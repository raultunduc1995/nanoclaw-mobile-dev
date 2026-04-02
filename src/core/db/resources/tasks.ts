import type Database from 'better-sqlite3';

import type { ScheduledTask, TaskRunLog } from '../types.js';

interface TaskRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script: string | null;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

function toTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    groupFolder: row.group_folder,
    chatJid: row.chat_jid,
    prompt: row.prompt,
    script: row.script,
    scheduleType: row.schedule_type as ScheduledTask['scheduleType'],
    scheduleValue: row.schedule_value,
    contextMode: row.context_mode as ScheduledTask['contextMode'],
    nextRun: row.next_run,
    lastRun: row.last_run,
    lastResult: row.last_result,
    status: row.status as ScheduledTask['status'],
    createdAt: row.created_at,
  };
}

export interface TasksLocalResource {
  create(task: Omit<ScheduledTask, 'lastRun' | 'lastResult'>): void;
  getById(id: string): ScheduledTask | undefined;
  getForGroup(groupFolder: string): ScheduledTask[];
  getAll(): ScheduledTask[];
  update(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'script' | 'scheduleType' | 'scheduleValue' | 'nextRun' | 'status'>>): void;
  delete(id: string): void;
  getDue(): ScheduledTask[];
  updateAfterRun(id: string, nextRun: string | null, lastResult: string): void;
  logRun(log: TaskRunLog): void;
}

export const createTasksLocalResource = (db: Database.Database): TasksLocalResource => ({
  create: (task: Omit<ScheduledTask, 'lastRun' | 'lastResult'>) => {
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(task.id, task.groupFolder, task.chatJid, task.prompt, task.script || null, task.scheduleType, task.scheduleValue, task.contextMode || 'isolated', task.nextRun, task.status, task.createdAt);
  },

  getById: (id: string): ScheduledTask | undefined => {
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  },

  getForGroup: (groupFolder: string): ScheduledTask[] => {
    const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC').all(groupFolder) as TaskRow[];
    return rows.map(toTask);
  },

  getAll: (): ScheduledTask[] => {
    const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as TaskRow[];
    return rows.map(toTask);
  },

  update: (id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'script' | 'scheduleType' | 'scheduleValue' | 'nextRun' | 'status'>>) => {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.prompt !== undefined) {
      fields.push('prompt = ?');
      values.push(updates.prompt);
    }
    if (updates.script !== undefined) {
      fields.push('script = ?');
      values.push(updates.script || null);
    }
    if (updates.scheduleType !== undefined) {
      fields.push('schedule_type = ?');
      values.push(updates.scheduleType);
    }
    if (updates.scheduleValue !== undefined) {
      fields.push('schedule_value = ?');
      values.push(updates.scheduleValue);
    }
    if (updates.nextRun !== undefined) {
      fields.push('next_run = ?');
      values.push(updates.nextRun);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }

    if (fields.length === 0) return;

    values.push(id);
    db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  delete: (id: string) => {
    db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  },

  getDue: (): ScheduledTask[] => {
    const now = new Date().toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM scheduled_tasks
           WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
           ORDER BY next_run`,
      )
      .all(now) as TaskRow[];
    return rows.map(toTask);
  },

  updateAfterRun: (id: string, nextRun: string | null, lastResult: string) => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE scheduled_tasks
         SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
         WHERE id = ?`,
    ).run(nextRun, now, lastResult, nextRun, id);
  },

  logRun: (log: TaskRunLog) => {
    db.prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(log.taskId, log.runAt, log.durationMs, log.status, log.result, log.error);
  },
});
