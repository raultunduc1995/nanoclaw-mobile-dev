import { describe, it, expect, beforeEach, vi } from 'vitest';

import { initTestDatabase } from '../db/connection.js';
import type { LocalResource } from '../db/connection.js';
import { createGroupsRepository, GroupsRepository } from './groups-repository.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      copyFileSync: vi.fn(),
    },
  };
});

let db: LocalResource;
let repo: GroupsRepository;

beforeEach(() => {
  vi.clearAllMocks();
  db = initTestDatabase();
  repo = createGroupsRepository(db.groups);
});

// --- getRegisteredGroupsRecord ---

describe('getRegisteredGroupsRecord', () => {
  it('returns empty record when no groups exist', () => {
    expect(repo.getRegisteredGroupsRecord()).toEqual({});
  });

  it('loads existing groups from DB on creation', () => {
    db.groups.set('tg:main', {
      jid: 'tg:main',
      name: 'Main',
      folder: 'telegram_main',
      trigger_pattern: 'none',
      added_at: '2024-01-01T00:00:00.000Z',
      container_config: null,
      requires_trigger: 0,
      is_main: 1,
    });

    const freshRepo = createGroupsRepository(db.groups);
    const groups = freshRepo.getRegisteredGroupsRecord();

    expect(groups['tg:main']).toBeDefined();
    expect(groups['tg:main'].name).toBe('Main');
    expect(groups['tg:main'].isMain).toBe(true);
    expect(groups['tg:main'].folder).toBe('telegram_main');
  });

  it('maps snake_case DB rows to camelCase domain types', () => {
    db.groups.set('tg:dev', {
      jid: 'tg:dev',
      name: 'Dev Team',
      folder: 'telegram_dev-team',
      trigger_pattern: 'none',
      added_at: '2026-03-01T10:00:00.000Z',
      container_config: JSON.stringify({ additionalMounts: [{ hostPath: '/tmp/test' }], timeout: 60000 }),
      requires_trigger: 0,
      is_main: 0,
    });

    const freshRepo = createGroupsRepository(db.groups);
    const group = freshRepo.getRegisteredGroupsRecord()['tg:dev'];

    expect(group.addedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(group.isMain).toBe(false);
    expect(group.containerConfig).toEqual({
      additionalMounts: [{ hostPath: '/tmp/test' }],
      timeout: 60000,
    });
  });
});

// --- getRegisteredGroupsJids ---

describe('getRegisteredGroupsJids', () => {
  it('returns empty set when no groups exist', () => {
    expect(repo.getRegisteredGroupsJids().size).toBe(0);
  });

  it('returns jids after registration', () => {
    repo.registerGroup('tg:one', { name: 'One', folder: 'telegram_one', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });
    repo.registerGroup('tg:two', { name: 'Two', folder: 'telegram_two', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });

    const jids = repo.getRegisteredGroupsJids();
    expect(jids.has('tg:one')).toBe(true);
    expect(jids.has('tg:two')).toBe(true);
    expect(jids.size).toBe(2);
  });
});

// --- getBy ---

describe('getBy', () => {
  it('returns undefined for non-existent group', () => {
    expect(repo.getBy('tg:unknown')).toBeUndefined();
  });

  it('returns group after registerGroup', () => {
    repo.registerGroup('tg:chat', { name: 'Chat', folder: 'telegram_chat', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });

    const group = repo.getBy('tg:chat');
    expect(group).toBeDefined();
    expect(group!.name).toBe('Chat');
    expect(group!.folder).toBe('telegram_chat');
  });
});

// --- registerGroup ---

describe('registerGroup', () => {
  it('adds group to cache and persists to DB', () => {
    repo.registerGroup('tg:new', { name: 'New Group', folder: 'telegram_new-group', addedAt: '2024-06-01T00:00:00.000Z', isMain: false });

    expect(repo.getBy('tg:new')).toBeDefined();
    expect(repo.getRegisteredGroupsRecord()['tg:new'].name).toBe('New Group');

    const freshRepo = createGroupsRepository(db.groups);
    expect(freshRepo.getBy('tg:new')).toBeDefined();
    expect(freshRepo.getBy('tg:new')!.name).toBe('New Group');
  });

  it('overwrites existing group', () => {
    repo.registerGroup('tg:chat', { name: 'Original', folder: 'telegram_chat', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });
    repo.registerGroup('tg:chat', { name: 'Updated', folder: 'telegram_chat', addedAt: '2024-01-01T00:00:00.000Z', isMain: true });

    expect(repo.getBy('tg:chat')!.name).toBe('Updated');
    expect(repo.getBy('tg:chat')!.isMain).toBe(true);
  });

  it('persists containerConfig through round-trip', () => {
    repo.registerGroup('tg:mounts', {
      name: 'With Mounts',
      folder: 'telegram_mounts',
      addedAt: '2024-01-01T00:00:00.000Z',
      isMain: false,
      containerConfig: {
        additionalMounts: [{ hostPath: '/home/user/projects', containerPath: 'projects', readonly: true }],
        timeout: 120000,
      },
    });

    const freshRepo = createGroupsRepository(db.groups);
    const group = freshRepo.getBy('tg:mounts')!;
    expect(group.containerConfig).toEqual({
      additionalMounts: [{ hostPath: '/home/user/projects', containerPath: 'projects', readonly: true }],
      timeout: 120000,
    });
  });

  it('throws on invalid folder name', () => {
    expect(() => repo.registerGroup('tg:bad', { name: 'Bad', folder: '../../outside', addedAt: '2024-01-01T00:00:00.000Z', isMain: false })).toThrow();

    expect(repo.getBy('tg:bad')).toBeUndefined();
  });

  it('creates group directory with logs subdirectory', async () => {
    const fs = await import('fs');
    repo.registerGroup('tg:dir', { name: 'Dir Test', folder: 'telegram_dir-test', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });

    expect(fs.default.mkdirSync).toHaveBeenCalledWith('/tmp/test-groups/telegram_dir-test/logs', { recursive: true });
  });

  it('copies global CLAUDE.md for non-main groups', async () => {
    const fs = await import('fs');
    (fs.default.existsSync as any).mockReturnValue(true);

    repo.registerGroup('tg:secondary', { name: 'Secondary', folder: 'telegram_secondary', addedAt: '2024-01-01T00:00:00.000Z', isMain: false });

    expect(fs.default.copyFileSync).toHaveBeenCalledWith('/tmp/test-groups/global/CLAUDE.md', '/tmp/test-groups/telegram_secondary/CLAUDE.md');
  });

  it('does not copy global CLAUDE.md for main group', async () => {
    const fs = await import('fs');

    repo.registerGroup('tg:main', { name: 'Main', folder: 'telegram_main', addedAt: '2024-01-01T00:00:00.000Z', isMain: true });

    expect(fs.default.copyFileSync).not.toHaveBeenCalled();
  });
});
