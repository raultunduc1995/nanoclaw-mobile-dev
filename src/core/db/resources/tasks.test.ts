import { describe, it, expect, beforeEach } from 'vitest';

import { initTestDatabase } from '../connection.js';
import type { LocalResource } from '../connection.js';
import type { TasksLocalResource, TaskRow } from './tasks.js';

let db: LocalResource;
let tasks: TasksLocalResource;

beforeEach(() => {
  db = initTestDatabase();
  tasks = db.tasks;
});

const row = (overrides?: Partial<TaskRow>): TaskRow => ({
  id: 'task-1',
  group_folder: 'telegram_main',
  chat_jid: 'tg:100',
  prompt: 'do something',
  script: null,
  schedule_type: 'once',
  schedule_value: '2024-06-01T00:00:00.000Z',
  context_mode: 'isolated',
  next_run: '2024-06-01T00:00:00.000Z',
  last_run: null,
  last_result: null,
  status: 'active',
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const updateRow = (overrides?: Partial<Omit<TaskRow, 'id'>>): Omit<TaskRow, 'id'> => ({
  group_folder: 'telegram_main',
  chat_jid: 'tg:100',
  prompt: 'do something',
  script: null,
  schedule_type: 'once',
  schedule_value: '2024-06-01T00:00:00.000Z',
  context_mode: 'isolated',
  next_run: '2024-06-01T00:00:00.000Z',
  last_run: null,
  last_result: null,
  status: 'active',
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('create and getById', () => {
  it('creates and retrieves a task', () => {
    tasks.create(row());

    const task = tasks.getById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
    expect(task!.group_folder).toBe('telegram_main');
    expect(task!.chat_jid).toBe('tg:100');
    expect(task!.schedule_type).toBe('once');
    expect(task!.context_mode).toBe('isolated');
  });

  it('returns undefined for non-existent task', () => {
    expect(tasks.getById('nonexistent')).toBeUndefined();
  });

  it('stores script field', () => {
    tasks.create(row({ id: 'task-script', script: 'echo hello' }));
    expect(tasks.getById('task-script')!.script).toBe('echo hello');
  });

  it('stores null script', () => {
    tasks.create(row({ id: 'task-null', script: null }));
    expect(tasks.getById('task-null')!.script).toBeNull();
  });
});

describe('getForGroup', () => {
  it('returns tasks for specific group', () => {
    tasks.create(row({ id: 't1', group_folder: 'telegram_main' }));
    tasks.create(row({ id: 't2', group_folder: 'telegram_dev' }));
    tasks.create(row({ id: 't3', group_folder: 'telegram_main' }));

    const result = tasks.getForGroup('telegram_main');
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.group_folder === 'telegram_main')).toBe(true);
  });

  it('returns empty for unknown group', () => {
    expect(tasks.getForGroup('nonexistent')).toEqual([]);
  });
});

describe('getAll', () => {
  it('returns empty when no tasks', () => {
    expect(tasks.getAll()).toEqual([]);
  });

  it('returns all tasks', () => {
    tasks.create(row({ id: 't1' }));
    tasks.create(row({ id: 't2' }));
    expect(tasks.getAll()).toHaveLength(2);
  });
});

describe('update', () => {
  it('updates status', () => {
    tasks.create(row());
    tasks.update('task-1', updateRow({ status: 'paused' }));
    expect(tasks.getById('task-1')!.status).toBe('paused');
  });

  it('updates prompt', () => {
    tasks.create(row());
    tasks.update('task-1', updateRow({ prompt: 'updated prompt' }));
    expect(tasks.getById('task-1')!.prompt).toBe('updated prompt');
  });

  it('updates schedule fields and next_run', () => {
    tasks.create(row());
    tasks.update('task-1', updateRow({ schedule_type: 'cron', schedule_value: '0 9 * * *', next_run: '2024-06-02T09:00:00.000Z' }));

    const task = tasks.getById('task-1')!;
    expect(task.schedule_type).toBe('cron');
    expect(task.schedule_value).toBe('0 9 * * *');
    expect(task.next_run).toBe('2024-06-02T09:00:00.000Z');
  });

  it('updates script to null', () => {
    tasks.create(row({ script: 'echo old' }));
    tasks.update('task-1', updateRow({ script: null }));
    expect(tasks.getById('task-1')!.script).toBeNull();
  });
});

describe('delete', () => {
  it('deletes task', () => {
    tasks.create(row());
    tasks.delete('task-1');
    expect(tasks.getById('task-1')).toBeUndefined();
  });

  it('deletes task', () => {
    tasks.create(row());
    tasks.delete('task-1');
    expect(tasks.getById('task-1')).toBeUndefined();
  });
});

describe('getDue', () => {
  it('returns tasks with next_run in the past', () => {
    tasks.create(row({ id: 'due', next_run: '2020-01-01T00:00:00.000Z' }));
    tasks.create(row({ id: 'future', next_run: '2099-01-01T00:00:00.000Z' }));
    tasks.create(row({ id: 'no-next', next_run: null }));

    const due = tasks.getDue();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('due');
  });

  it('excludes paused tasks', () => {
    tasks.create(row({ id: 'paused', next_run: '2020-01-01T00:00:00.000Z', status: 'paused' }));
    expect(tasks.getDue()).toHaveLength(0);
  });

  it('excludes completed tasks', () => {
    tasks.create(row({ id: 'done', next_run: '2020-01-01T00:00:00.000Z', status: 'completed' }));
    expect(tasks.getDue()).toHaveLength(0);
  });
});

describe('updateAfterRun', () => {
  it('sets last_run, last_result, and new next_run', () => {
    tasks.create(row());
    tasks.updateAfterRun('task-1', '2024-07-01T00:00:00.000Z', 'success');

    const task = tasks.getById('task-1')!;
    expect(task.next_run).toBe('2024-07-01T00:00:00.000Z');
    expect(task.last_result).toBe('success');
    expect(task.last_run).toBeDefined();
    expect(task.status).toBe('active');
  });

  it('marks task as completed when nextRun is null', () => {
    tasks.create(row());
    tasks.updateAfterRun('task-1', null, 'done');

    const task = tasks.getById('task-1')!;
    expect(task.next_run).toBeNull();
    expect(task.status).toBe('completed');
  });
});

