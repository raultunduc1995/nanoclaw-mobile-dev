import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createIpcHandler } from './ipc-handler.js';
import type { IpcHandler, IpcHandlerDeps } from './ipc-handler.js';
import { ipcTaskSchema } from './types.js';
import type { RegisteredGroup, ScheduledTask } from '../repositories/index.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-groups',
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, mkdirSync: vi.fn(), existsSync: vi.fn(() => false), copyFileSync: vi.fn() } };
});

let groups: Map<string, RegisteredGroup>;
let tasks: Map<string, ScheduledTask>;
let sentMessages: { send: IpcHandlerDeps['channelRegistryDeps']['sendMessageTo'] };
let handlerDeps: IpcHandlerDeps;

let handler: IpcHandler;

const MAIN = { groupFolder: 'telegram_main', isMain: true };
const OTHER = { groupFolder: 'other-group', isMain: false };
const THIRD = { groupFolder: 'third-group', isMain: false };

beforeEach(() => {
  vi.clearAllMocks();
  groups = new Map();
  tasks = new Map();
  sentMessages = { send: vi.fn<IpcHandlerDeps['channelRegistryDeps']['sendMessageTo']>().mockResolvedValue(undefined) };
  handlerDeps = {
    groupsDeps: {
      getById: (jid) => groups.get(jid),
      register: (jid, g) => groups.set(jid, g),
      getRegisteredGroups: () => Object.fromEntries(groups),
    },
    tasksDeps: {
      save: (t) => tasks.set(t.id, { ...t, status: 'active', createdAt: new Date().toISOString() } as ScheduledTask),
      getById: (id) => tasks.get(id),
      update: (t) => tasks.set(t.id, t),
      delete: (id) => {
        tasks.delete(id);
      },
    },
    chatsDeps: {
      getAvailableChatGroups: () => [],
    },
    channelRegistryDeps: {
      sendMessageTo: sentMessages.send,
    },
    containerRunnerDeps: {
      writeAvailableGroupsIn: vi.fn(),
    },
  };
  handler = createIpcHandler(handlerDeps);

  handlerDeps.groupsDeps.register('tg:main', { name: 'Main', folder: 'telegram_main', addedAt: '2024-01-01T00:00:00.000Z', isMain: true });
  handlerDeps.groupsDeps.register('tg:other', { name: 'Other', folder: 'other-group', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });
  handlerDeps.groupsDeps.register('tg:third', { name: 'Third', folder: 'third-group', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });
});

const seedTask = (id: string, groupFolder: string, chatJid: string, opts?: { status?: string }) => {
  handlerDeps.tasksDeps.save({
    id,
    groupFolder,
    chatJid,
    prompt: 'test task',
    scheduleType: 'once',
    scheduleValue: '2025-06-01T00:00:00',
    contextMode: 'isolated',
    nextRun: '2025-06-01T00:00:00.000Z',
  });
  if (opts?.status === 'paused') {
    const task = handlerDeps.tasksDeps.getById(id)!;
    handlerDeps.tasksDeps.update({ ...task, status: 'paused' });
  }
};

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await handler.processTaskCommand({ taskId: 'task_id_1', type: 'schedule_task', prompt: 'do something', schedule_type: 'once', schedule_value: '2025-06-01T00:00:00', targetJid: 'tg:other' }, MAIN);
    const task = handlerDeps.tasksDeps.getById(`task_id_1`);
    expect(task!.groupFolder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await handler.processTaskCommand({ type: 'schedule_task', prompt: 'self task', schedule_type: 'once', schedule_value: '2025-06-01T00:00:00', targetJid: 'tg:other' }, OTHER);
    const saved = Array.from(tasks.values());
    expect(saved).toHaveLength(1);
    expect(saved[0].groupFolder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await handler.processTaskCommand({ type: 'schedule_task', prompt: 'unauthorized', schedule_type: 'once', schedule_value: '2025-06-01T00:00:00', targetJid: 'tg:main' }, OTHER);
    expect(Array.from(tasks.values())).toHaveLength(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await handler.processTaskCommand({ type: 'schedule_task', prompt: 'no target', schedule_type: 'once', schedule_value: '2025-06-01T00:00:00', targetJid: 'tg:unknown' }, MAIN);
    expect(Array.from(tasks.values())).toHaveLength(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    seedTask('task-main', 'telegram_main', 'tg:main');
    seedTask('task-other', 'other-group', 'tg:other');
  });

  it('main group can pause any task', async () => {
    await handler.processTaskCommand({ type: 'pause_task', taskId: 'task-other' }, MAIN);
    expect(tasks.get('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await handler.processTaskCommand({ type: 'pause_task', taskId: 'task-other' }, OTHER);
    expect(tasks.get('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await handler.processTaskCommand({ type: 'pause_task', taskId: 'task-main' }, OTHER);
    expect(tasks.get('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    seedTask('task-paused', 'other-group', 'tg:other', { status: 'paused' });
  });

  it('main group can resume any task', async () => {
    await handler.processTaskCommand({ type: 'resume_task', taskId: 'task-paused' }, MAIN);
    expect(tasks.get('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await handler.processTaskCommand({ type: 'resume_task', taskId: 'task-paused' }, OTHER);
    expect(tasks.get('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await handler.processTaskCommand({ type: 'resume_task', taskId: 'task-paused' }, THIRD);
    expect(tasks.get('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    seedTask('task-to-cancel', 'other-group', 'tg:other');
    await handler.processTaskCommand({ type: 'cancel_task', taskId: 'task-to-cancel' }, MAIN);
    expect(tasks.get('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    seedTask('task-own', 'other-group', 'tg:other');
    await handler.processTaskCommand({ type: 'cancel_task', taskId: 'task-own' }, OTHER);
    expect(tasks.get('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    seedTask('task-foreign', 'telegram_main', 'tg:main');
    await handler.processTaskCommand({ type: 'cancel_task', taskId: 'task-foreign' }, OTHER);
    expect(tasks.get('task-foreign')).toBeDefined();
  });
});

// --- update_task authorization ---

describe('update_task authorization', () => {
  it('main group can update any task', async () => {
    seedTask('task-to-update', 'other-group', 'tg:other');
    await handler.processTaskCommand({ type: 'update_task', taskId: 'task-to-update', prompt: 'updated' }, MAIN);
    expect(tasks.get('task-to-update')!.prompt).toBe('updated');
  });

  it('non-main group can update its own task', async () => {
    seedTask('task-own', 'other-group', 'tg:other');
    await handler.processTaskCommand({ type: 'update_task', taskId: 'task-own', prompt: 'my update' }, OTHER);
    expect(tasks.get('task-own')!.prompt).toBe('my update');
  });

  it('non-main group cannot update another groups task', async () => {
    seedTask('task-foreign', 'telegram_main', 'tg:main');
    await handler.processTaskCommand({ type: 'update_task', taskId: 'task-foreign', prompt: 'nope' }, OTHER);
    expect(tasks.get('task-foreign')!.prompt).toBe('test task');
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await handler.processTaskCommand({ type: 'register_group', jid: 'tg:new', name: 'New Group', folder: 'telegram_new-group' }, OTHER);
    expect(groups.get('tg:new')).toBeUndefined();
  });

  it('main group can register a new group', async () => {
    await handler.processTaskCommand({ type: 'register_group', jid: 'tg:new', name: 'New Group', folder: 'telegram_new-group' }, MAIN);
    expect(groups.get('tg:new')).toBeDefined();
    expect(groups.get('tg:new')!.name).toBe('New Group');
    expect(groups.get('tg:new')!.isMain).toBe(false);
  });

  // Folder validation is tested in groups-repository.test.ts — the handler just delegates
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    await handler.processTaskCommand({ type: 'refresh_groups' }, OTHER);
    expect(handlerDeps.containerRunnerDeps.writeAvailableGroupsIn).not.toHaveBeenCalled();
  });

  it('main group can trigger refresh', async () => {
    await handler.processTaskCommand({ type: 'refresh_groups' }, MAIN);
    expect(handlerDeps.containerRunnerDeps.writeAvailableGroupsIn).toHaveBeenCalled();
  });
});

// --- schedule_task schedule types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes nextRun', async () => {
    await handler.processTaskCommand({ type: 'schedule_task', prompt: 'cron task', schedule_type: 'cron', schedule_value: '0 9 * * *', targetJid: 'tg:other' }, MAIN);
    const saved = Array.from(tasks.values());
    expect(saved).toHaveLength(1);
    expect(saved[0].scheduleType).toBe('cron');
    expect(saved[0].nextRun).toBeTruthy();
  });

  it('rejects invalid cron expression', async () => {
    await expect(handler.processTaskCommand({ type: 'schedule_task', prompt: 'bad cron', schedule_type: 'cron', schedule_value: 'not a cron', targetJid: 'tg:other' }, MAIN)).rejects.toThrow();
    expect(Array.from(tasks.values())).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    await handler.processTaskCommand({ type: 'schedule_task', prompt: 'interval task', schedule_type: 'interval', schedule_value: '60000', targetJid: 'tg:other' }, MAIN);
    const saved = Array.from(tasks.values());
    expect(saved).toHaveLength(1);
    expect(saved[0].scheduleType).toBe('interval');
    expect(saved[0].nextRun).toBeTruthy();
  });

  it('rejects invalid interval', async () => {
    await expect(handler.processTaskCommand({ type: 'schedule_task', prompt: 'bad interval', schedule_type: 'interval', schedule_value: '-100', targetJid: 'tg:other' }, MAIN)).rejects.toThrow();
    expect(Array.from(tasks.values())).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await expect(handler.processTaskCommand({ type: 'schedule_task', prompt: 'bad once', schedule_type: 'once', schedule_value: 'not-a-date', targetJid: 'tg:other' }, MAIN)).rejects.toThrow();
    expect(Array.from(tasks.values())).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode defaulting', () => {
  it('accepts context_mode=group', async () => {
    await handler.processTaskCommand({ type: 'schedule_task', prompt: 'grouped', schedule_type: 'once', schedule_value: '2025-06-01T00:00:00', targetJid: 'tg:other', context_mode: 'group' }, MAIN);
    expect(Array.from(tasks.values())[0].contextMode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await handler.processTaskCommand(
      { type: 'schedule_task', prompt: 'isolated', schedule_type: 'once', schedule_value: '2025-06-01T00:00:00', targetJid: 'tg:other', context_mode: 'isolated' },
      MAIN,
    );
    expect(Array.from(tasks.values())[0].contextMode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await handler.processTaskCommand({ type: 'schedule_task', prompt: 'no mode', schedule_type: 'once', schedule_value: '2025-06-01T00:00:00', targetJid: 'tg:other' }, MAIN);
    expect(Array.from(tasks.values())[0].contextMode).toBe('isolated');
  });

  it('rejects invalid context_mode at schema level', () => {
    const parsed = ipcTaskSchema.safeParse({
      type: 'schedule_task',
      prompt: 'bad mode',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      targetJid: 'tg:other',
      context_mode: 'weird',
    });
    expect(parsed.success).toBe(false);
  });
});

// --- register_group completeness ---

describe('register_group completeness', () => {
  it('main group registers group with all fields populated', async () => {
    await handler.processTaskCommand({ type: 'register_group', jid: 'tg:fresh', name: 'Fresh', folder: 'fresh_group' }, MAIN);
    const saved = groups.get('tg:fresh')!;
    expect(saved.name).toBe('Fresh');
    expect(saved.folder).toBe('fresh_group');
    expect(saved.isMain).toBe(false);
    expect(saved.addedAt).toBeTruthy();
  });

  it('rejects register_group with missing folder at schema level', () => {
    const parsed = ipcTaskSchema.safeParse({ type: 'register_group', jid: 'tg:x', name: 'X' });
    expect(parsed.success).toBe(false);
  });
});

// --- processMessage authorization ---

describe('processMessage authorization', () => {
  it('main group can send to any registered chat', async () => {
    await handler.processMessage({ type: 'message', chatJid: 'tg:other', text: 'hello' }, MAIN);
    expect(sentMessages.send).toHaveBeenCalledWith('tg:other', 'hello');
  });

  it('non-main group can send to its own chat', async () => {
    await handler.processMessage({ type: 'message', chatJid: 'tg:other', text: 'hello' }, OTHER);
    expect(sentMessages.send).toHaveBeenCalledWith('tg:other', 'hello');
  });

  it('non-main group cannot send to another groups chat', async () => {
    await handler.processMessage({ type: 'message', chatJid: 'tg:main', text: 'sneaky' }, OTHER);
    expect(sentMessages.send).not.toHaveBeenCalled();
  });

  it('non-main group cannot send to unregistered JID', async () => {
    await handler.processMessage({ type: 'message', chatJid: 'tg:unknown', text: 'hello' }, OTHER);
    expect(sentMessages.send).not.toHaveBeenCalled();
  });

  it('main group can send to unregistered JID', async () => {
    await handler.processMessage({ type: 'message', chatJid: 'tg:unknown', text: 'broadcast' }, MAIN);
    expect(sentMessages.send).toHaveBeenCalledWith('tg:unknown', 'broadcast');
  });
});
