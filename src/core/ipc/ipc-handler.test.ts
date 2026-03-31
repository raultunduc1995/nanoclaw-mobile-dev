import { describe, it, expect, beforeEach } from 'vitest';

import { initTestDatabase } from '../db/index.js';
import type { LocalDatabase, RegisteredGroup } from '../db/index.js';
import { createIpcHandler } from './handler.js';
import type { IpcHandler } from './handler.js';
import type { IpcDeps } from './service.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  addedAt: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  addedAt: '2024-01-01T00:00:00.000Z',
  isMain: false,
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  addedAt: '2024-01-01T00:00:00.000Z',
  isMain: false,
};

let db: LocalDatabase;
let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let handler: IpcHandler;

beforeEach(() => {
  db = initTestDatabase();

  groups = {
    'tg:main': MAIN_GROUP,
    'tg:other': OTHER_GROUP,
    'tg:third': THIRD_GROUP,
  };

  db.groups.set('tg:main', MAIN_GROUP);
  db.groups.set('tg:other', OTHER_GROUP);
  db.groups.set('tg:third', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    getRegisteredGroups: () => groups,
    registerGroup: (jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
      db.groups.set(jid, group);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };

  handler = createIpcHandler(db, deps);
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'tg:other',
      },
      'telegram_main',
      true,
    );

    const allTasks = db.tasks.getAll();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].groupFolder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'tg:other',
      },
      'other-group',
      false,
    );

    const allTasks = db.tasks.getAll();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].groupFolder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'tg:main',
      },
      'other-group',
      false,
    );

    const allTasks = db.tasks.getAll();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'tg:unknown',
      },
      'telegram_main',
      true,
    );

    const allTasks = db.tasks.getAll();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    db.tasks.create({
      id: 'task-main',
      groupFolder: 'telegram_main',
      chatJid: 'tg:main',
      prompt: 'main task',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2025-06-01T00:00:00',
      contextMode: 'isolated',
      nextRun: '2025-06-01T00:00:00.000Z',
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    db.tasks.create({
      id: 'task-other',
      groupFolder: 'other-group',
      chatJid: 'tg:other',
      prompt: 'other task',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2025-06-01T00:00:00',
      contextMode: 'isolated',
      nextRun: '2025-06-01T00:00:00.000Z',
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await handler.processTaskCommand(
      { type: 'pause_task', taskId: 'task-other' },
      'telegram_main',
      true,
    );
    expect(db.tasks.getById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await handler.processTaskCommand(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
    );
    expect(db.tasks.getById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await handler.processTaskCommand(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
    );
    expect(db.tasks.getById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    db.tasks.create({
      id: 'task-paused',
      groupFolder: 'other-group',
      chatJid: 'tg:other',
      prompt: 'paused task',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2025-06-01T00:00:00',
      contextMode: 'isolated',
      nextRun: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await handler.processTaskCommand(
      { type: 'resume_task', taskId: 'task-paused' },
      'telegram_main',
      true,
    );
    expect(db.tasks.getById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await handler.processTaskCommand(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
    );
    expect(db.tasks.getById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await handler.processTaskCommand(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
    );
    expect(db.tasks.getById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    db.tasks.create({
      id: 'task-to-cancel',
      groupFolder: 'other-group',
      chatJid: 'tg:other',
      prompt: 'cancel me',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2025-06-01T00:00:00',
      contextMode: 'isolated',
      nextRun: null,
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    await handler.processTaskCommand(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'telegram_main',
      true,
    );
    expect(db.tasks.getById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    db.tasks.create({
      id: 'task-own',
      groupFolder: 'other-group',
      chatJid: 'tg:other',
      prompt: 'my task',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2025-06-01T00:00:00',
      contextMode: 'isolated',
      nextRun: null,
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    await handler.processTaskCommand(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
    );
    expect(db.tasks.getById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    db.tasks.create({
      id: 'task-foreign',
      groupFolder: 'telegram_main',
      chatJid: 'tg:main',
      prompt: 'not yours',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2025-06-01T00:00:00',
      contextMode: 'isolated',
      nextRun: null,
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    await handler.processTaskCommand(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
    );
    expect(db.tasks.getById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await handler.processTaskCommand(
      {
        type: 'register_group',
        jid: 'tg:new',
        name: 'New Group',
        folder: 'new-group',
      },
      'other-group',
      false,
    );
    expect(groups['tg:new']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await handler.processTaskCommand(
      {
        type: 'register_group',
        jid: 'tg:new',
        name: 'New Group',
        folder: '../../outside',
      },
      'telegram_main',
      true,
    );
    expect(groups['tg:new']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    await handler.processTaskCommand(
      { type: 'refresh_groups' },
      'other-group',
      false,
    );
  });
});

// --- schedule_task schedule types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes nextRun', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'tg:other',
      },
      'telegram_main',
      true,
    );

    const tasks = db.tasks.getAll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].scheduleType).toBe('cron');
    expect(tasks[0].nextRun).toBeTruthy();
    expect(new Date(tasks[0].nextRun!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'tg:other',
      },
      'telegram_main',
      true,
    );
    expect(db.tasks.getAll()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '60000',
        targetJid: 'tg:other',
      },
      'telegram_main',
      true,
    );

    const tasks = db.tasks.getAll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].scheduleType).toBe('interval');
    expect(tasks[0].nextRun).toBeTruthy();
  });

  it('rejects invalid interval', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: '-100',
        targetJid: 'tg:other',
      },
      'telegram_main',
      true,
    );
    expect(db.tasks.getAll()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await handler.processTaskCommand(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'tg:other',
      },
      'telegram_main',
      true,
    );
    expect(db.tasks.getAll()).toHaveLength(0);
  });
});
