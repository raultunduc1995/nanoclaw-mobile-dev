import type Database from 'better-sqlite3';

export interface TaskRow {
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

export interface TasksLocalResource {
  create(task: TaskRow): void;
  getById(id: string): TaskRow | undefined;
  getForGroup(groupFolder: string): TaskRow[];
  getAll(): TaskRow[];
  update(id: string, taskRow: Omit<TaskRow, `id`>): void;
  delete(id: string): void;
  getDue(): TaskRow[];
  updateAfterRun(id: string, nextRun: string | null, lastResult: string): void;
}

export const createTasksLocalResource = (db: Database.Database): TasksLocalResource => ({
  create: (task) => {
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, last_run, last_result, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.group_folder,
      task.chat_jid,
      task.prompt,
      task.script,
      task.schedule_type,
      task.schedule_value,
      task.context_mode,
      task.next_run,
      task.last_run,
      task.last_result,
      task.status,
      task.created_at,
    );
  },

  getById: (id) => db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as TaskRow | undefined,

  getForGroup: (groupFolder) => db.prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC').all(groupFolder) as TaskRow[],

  getAll: () => db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as TaskRow[],

  update: (id, task) => {
    const entries = Object.entries(task).filter(([_, v]) => v !== undefined);

    const fields = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([k, v]) => (k === 'script' ? v || null : v));

    db.prepare(`UPDATE scheduled_tasks SET ${fields} WHERE id = ?`).run(...values, id);
  },

  delete: (id) => {
    db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  },

  getDue: () => {
    const now = new Date().toISOString();
    return db
      .prepare(
        `SELECT * FROM scheduled_tasks
           WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
           ORDER BY next_run`,
      )
      .all(now) as TaskRow[];
  },

  updateAfterRun: (id, nextRun, lastResult) => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE scheduled_tasks
         SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
         WHERE id = ?`,
    ).run(nextRun, now, lastResult, nextRun, id);
  },
});
