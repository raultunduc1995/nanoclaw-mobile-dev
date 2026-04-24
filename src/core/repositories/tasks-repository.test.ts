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
    repo.save(task());

    const result = repo.getById('task-1');
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
    expect(repo.getById('nonexistent')).toBeUndefined();
  });

  it('stores script field', () => {
    repo.save(task({ id: 'with-script', script: 'echo hello' }));
    expect(repo.getById('with-script')!.script).toBe('echo hello');
  });

  it('maps undefined script to null in DB and back to undefined', () => {
    repo.save(task({ id: 'no-script' }));
    expect(repo.getById('no-script')!.script).toBeUndefined();
  });

  it('clears nextRun after completion via updateAfterRun', () => {
    repo.save(task({ id: 'will-complete' }));
    repo.updateAfterRun('will-complete', 'done');
    expect(repo.getById('will-complete')!.nextRun).toBeUndefined();
  });
});

// --- getAllTasksForGroup ---

describe('getByGroup', () => {
  it('returns tasks for specific group', () => {
    repo.save(task({ id: 't1', groupFolder: 'telegram_main' }));
    repo.save(task({ id: 't2', groupFolder: 'telegram_dev' }));
    repo.save(task({ id: 't3', groupFolder: 'telegram_main' }));

    const result = repo.getByGroup('telegram_main');
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.groupFolder === 'telegram_main')).toBe(true);
  });

  it('returns empty for unknown group', () => {
    expect(repo.getByGroup('nonexistent')).toEqual([]);
  });
});

// --- getAllTasks ---

describe('getAllTasks', () => {
  it('returns empty when no tasks', () => {
    expect(repo.getAll()).toEqual([]);
  });

  it('returns all tasks', () => {
    repo.save(task({ id: 't1' }));
    repo.save(task({ id: 't2' }));
    expect(repo.getAll()).toHaveLength(2);
  });
});

// --- Specific update methods ---

describe('updateTask', () => {
  it('updates status', () => {
    repo.save(task());
    const existing = repo.getById('task-1')!;
    repo.update({ ...existing, status: 'paused' });
    expect(repo.getById('task-1')!.status).toBe('paused');
  });

  it('updates prompt and script', () => {
    repo.save(task());
    const existing = repo.getById('task-1')!;
    repo.update({ ...existing, prompt: 'new prompt', script: 'new script' });

    const result = repo.getById('task-1')!;
    expect(result.prompt).toBe('new prompt');
    expect(result.script).toBe('new script');
  });

  it('updates schedule type and value', () => {
    repo.save(task());
    const existing = repo.getById('task-1')!;
    repo.update({ ...existing, scheduleType: 'cron', scheduleValue: '0 9 * * *' });

    const result = repo.getById('task-1')!;
    expect(result.scheduleType).toBe('cron');
    expect(result.scheduleValue).toBe('0 9 * * *');
  });

  it('updates next run', () => {
    repo.save(task());
    const existing = repo.getById('task-1')!;
    repo.update({ ...existing, nextRun: '2024-07-01T00:00:00.000Z' });
    expect(repo.getById('task-1')!.nextRun).toBe('2024-07-01T00:00:00.000Z');
  });
});

// --- deleteTask ---

describe('deleteTask', () => {
  it('deletes task', () => {
    repo.save(task());
    repo.delete('task-1');
    expect(repo.getById('task-1')).toBeUndefined();
  });
});

// --- getAllDueScheduledTasks ---

describe('getAllDueScheduledTasks', () => {
  it('returns tasks with nextRun in the past', () => {
    repo.save(task({ id: 'due', nextRun: '2020-01-01T00:00:00.000Z' }));
    repo.save(task({ id: 'future', nextRun: '2099-01-01T00:00:00.000Z' }));
    repo.save(task({ id: 'no-next' }));
    repo.updateAfterRun('no-next', 'done'); // clears nextRun

    const due = repo.getDue();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('due');
  });

  it('returns domain types with camelCase', () => {
    repo.save(task({ id: 'due', nextRun: '2020-01-01T00:00:00.000Z' }));
    const due = repo.getDue();
    expect(due[0].groupFolder).toBe('telegram_main');
    expect(due[0].scheduleType).toBe('once');
  });
});

// --- updateAfterRun ---

describe('updateAfterRun', () => {
  it('updates with next run', () => {
    repo.save(task());
    repo.updateAfterRun('task-1', 'success', '2024-07-01T00:00:00.000Z');

    const result = repo.getById('task-1')!;
    expect(result.nextRun).toBe('2024-07-01T00:00:00.000Z');
    expect(result.lastResult).toBe('success');
    expect(result.lastRun).toBeDefined();
    expect(result.status).toBe('active');
  });

  it('marks completed when no next run', () => {
    repo.save(task());
    repo.updateAfterRun('task-1', 'done');

    const result = repo.getById('task-1')!;
    expect(result.nextRun).toBeUndefined();
    expect(result.status).toBe('completed');
  });
});
