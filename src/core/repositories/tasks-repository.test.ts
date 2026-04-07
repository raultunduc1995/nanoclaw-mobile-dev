import { describe, it, expect, beforeEach, vi } from 'vitest';

import { initTestDatabase } from '../db/connection.js';
import type { LocalResource } from '../db/connection.js';
import { createTasksRepository, TasksRepository, NewScheduledTask } from './tasks-repository.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-groups',
}));

let db: LocalResource;
let repo: TasksRepository;

beforeEach(() => {
  vi.clearAllMocks();
  db = initTestDatabase();
  repo = createTasksRepository(db.tasks);
});

const task = (overrides?: Partial<NewScheduledTask>): NewScheduledTask => ({
  id: 'task-1',
  groupFolder: 'telegram_main',
  chatJid: 'tg:100',
  prompt: 'do something',
  scheduleType: 'once',
  scheduleValue: '2024-06-01T00:00:00.000Z',
  contextMode: 'isolated',
  nextRun: '2024-06-01T00:00:00.000Z',
  ...overrides,
});

// --- saveTask + getTaskById ---

describe('saveTask and getTaskById', () => {
  it('saves and retrieves a task with camelCase fields', () => {
    repo.saveTask(task());

    const result = repo.getTaskById('task-1');
    expect(result).toBeDefined();
    expect(result!.id).toBe('task-1');
    expect(result!.groupFolder).toBe('telegram_main');
    expect(result!.chatJid).toBe('tg:100');
    expect(result!.prompt).toBe('do something');
    expect(result!.scheduleType).toBe('once');
    expect(result!.contextMode).toBe('isolated');
    expect(result!.status).toBe('active');
  });

  it('returns undefined for non-existent task', () => {
    expect(repo.getTaskById('nonexistent')).toBeUndefined();
  });

  it('stores script field', () => {
    repo.saveTask(task({ id: 'with-script', script: 'echo hello' }));
    expect(repo.getTaskById('with-script')!.script).toBe('echo hello');
  });

  it('maps undefined script to null in DB and back to undefined', () => {
    repo.saveTask(task({ id: 'no-script' }));
    expect(repo.getTaskById('no-script')!.script).toBeUndefined();
  });

  it('clears nextRun after completion via updateAfterRun', () => {
    repo.saveTask(task({ id: 'will-complete' }));
    repo.updateAfterRun('will-complete', 'done');
    expect(repo.getTaskById('will-complete')!.nextRun).toBeUndefined();
  });
});

// --- getAllTasksForGroup ---

describe('getAllTasksForGroup', () => {
  it('returns tasks for specific group', () => {
    repo.saveTask(task({ id: 't1', groupFolder: 'telegram_main' }));
    repo.saveTask(task({ id: 't2', groupFolder: 'telegram_dev' }));
    repo.saveTask(task({ id: 't3', groupFolder: 'telegram_main' }));

    const result = repo.getAllTasksForGroup('telegram_main');
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.groupFolder === 'telegram_main')).toBe(true);
  });

  it('returns empty for unknown group', () => {
    expect(repo.getAllTasksForGroup('nonexistent')).toEqual([]);
  });
});

// --- getAllTasks ---

describe('getAllTasks', () => {
  it('returns empty when no tasks', () => {
    expect(repo.getAllTasks()).toEqual([]);
  });

  it('returns all tasks', () => {
    repo.saveTask(task({ id: 't1' }));
    repo.saveTask(task({ id: 't2' }));
    expect(repo.getAllTasks()).toHaveLength(2);
  });
});

// --- Specific update methods ---

describe('updateTask', () => {
  it('updates status', () => {
    repo.saveTask(task());
    const existing = repo.getTaskById('task-1')!;
    repo.updateTask({ ...existing, status: 'paused' });
    expect(repo.getTaskById('task-1')!.status).toBe('paused');
  });

  it('updates prompt and script', () => {
    repo.saveTask(task());
    const existing = repo.getTaskById('task-1')!;
    repo.updateTask({ ...existing, prompt: 'new prompt', script: 'new script' });

    const result = repo.getTaskById('task-1')!;
    expect(result.prompt).toBe('new prompt');
    expect(result.script).toBe('new script');
  });

  it('updates schedule type and value', () => {
    repo.saveTask(task());
    const existing = repo.getTaskById('task-1')!;
    repo.updateTask({ ...existing, scheduleType: 'cron', scheduleValue: '0 9 * * *' });

    const result = repo.getTaskById('task-1')!;
    expect(result.scheduleType).toBe('cron');
    expect(result.scheduleValue).toBe('0 9 * * *');
  });

  it('updates next run', () => {
    repo.saveTask(task());
    const existing = repo.getTaskById('task-1')!;
    repo.updateTask({ ...existing, nextRun: '2024-07-01T00:00:00.000Z' });
    expect(repo.getTaskById('task-1')!.nextRun).toBe('2024-07-01T00:00:00.000Z');
  });
});

// --- deleteTask ---

describe('deleteTask', () => {
  it('deletes task', () => {
    repo.saveTask(task());
    repo.deleteTask('task-1');
    expect(repo.getTaskById('task-1')).toBeUndefined();
  });
});

// --- getAllDueScheduledTasks ---

describe('getAllDueScheduledTasks', () => {
  it('returns tasks with nextRun in the past', () => {
    repo.saveTask(task({ id: 'due', nextRun: '2020-01-01T00:00:00.000Z' }));
    repo.saveTask(task({ id: 'future', nextRun: '2099-01-01T00:00:00.000Z' }));
    repo.saveTask(task({ id: 'no-next' }));
    repo.updateAfterRun('no-next', 'done'); // clears nextRun

    const due = repo.getAllDueScheduledTasks();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('due');
  });

  it('returns domain types with camelCase', () => {
    repo.saveTask(task({ id: 'due', nextRun: '2020-01-01T00:00:00.000Z' }));
    const due = repo.getAllDueScheduledTasks();
    expect(due[0].groupFolder).toBe('telegram_main');
    expect(due[0].scheduleType).toBe('once');
  });
});

// --- updateAfterRun ---

describe('updateAfterRun', () => {
  it('updates with next run', () => {
    repo.saveTask(task());
    repo.updateAfterRun('task-1', 'success', '2024-07-01T00:00:00.000Z');

    const result = repo.getTaskById('task-1')!;
    expect(result.nextRun).toBe('2024-07-01T00:00:00.000Z');
    expect(result.lastResult).toBe('success');
    expect(result.lastRun).toBeDefined();
    expect(result.status).toBe('active');
  });

  it('marks completed when no next run', () => {
    repo.saveTask(task());
    repo.updateAfterRun('task-1', 'done');

    const result = repo.getTaskById('task-1')!;
    expect(result.nextRun).toBeUndefined();
    expect(result.status).toBe('completed');
  });
});

// --- saveTaskRunLog ---

describe('saveTaskRunLog', () => {
  it('saves success log', () => {
    repo.saveTask(task());
    expect(() => repo.saveTaskRunLog({ taskId: 'task-1', runAt: '2024-01-01T00:00:00.000Z', durationMs: 500, status: 'success', result: 'ok' })).not.toThrow();
  });

  it('saves error log', () => {
    repo.saveTask(task());
    expect(() => repo.saveTaskRunLog({ taskId: 'task-1', runAt: '2024-01-01T00:00:00.000Z', durationMs: 100, status: 'error', error: 'timeout' })).not.toThrow();
  });
});
