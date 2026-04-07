import path from 'path';
import fs from 'fs';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { logger } from '../../logger.js';

import type { GroupRow, GroupsLocalResource } from '../db/index.js';

// --- Types and interfaces ---

export interface RegisteredGroup {
  name: string;
  folder: string;
  addedAt: string;
  containerConfig?: ContainerConfig;
  isMain: boolean;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
}

export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}

// --- Repository interface and implementation ---

export interface GroupsRepository {
  getRegisteredGroupsRecord: () => Record<string, RegisteredGroup>;
  getRegisteredGroupsJids: () => Set<string>;
  getBy: (jid: string) => RegisteredGroup | undefined;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export const createGroupsRepository = (resource: GroupsLocalResource): GroupsRepository => {
  const groupRows = resource.getAll();
  const registeredGroups: Record<string, RegisteredGroup> = Object.fromEntries(groupRows.map((row) => [row.jid, toRegisteredGroup(row)]));

  const saveGroup = (jid: string, registeredGroup: RegisteredGroup) => {
    assertValidGroupFolder(registeredGroup.folder);
    resource.set(jid, toGroupRow(jid, registeredGroup));
    registeredGroups[jid] = registeredGroup;
  };

  return {
    getRegisteredGroupsRecord: () => registeredGroups,

    getRegisteredGroupsJids: () => new Set(Object.keys(registeredGroups)),

    getBy: (jid) => registeredGroups[jid],

    registerGroup: (jid, group) => {
      const groupDir = resolveGroupFolderPath(group.folder);
      saveGroup(jid, group);

      createGroupDirectory(groupDir);
      if (!group.isMain) {
        copyGlobalMdToGroup(groupDir);
      }

      logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
    },
  };
};

// --- Conversion functions between GroupRow and RegisteredGroup ---

const toRegisteredGroup = (row: GroupRow): RegisteredGroup => ({
  name: row.name,
  folder: row.folder,
  addedAt: row.added_at,
  containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
  isMain: row.is_main === 1,
});

const toGroupRow = (jid: string, group: RegisteredGroup): GroupRow => ({
  jid,
  name: group.name,
  folder: group.folder,
  trigger_pattern: 'none',
  added_at: group.addedAt,
  container_config: group.containerConfig ? JSON.stringify(group.containerConfig) : null,
  requires_trigger: 0,
  is_main: group.isMain ? 1 : 0,
});

// --- Utility functions for group folder validation and path resolution ---

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    logger.warn({ folder }, 'Invalid group folder');
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, groupPath: string): void {
  const rel = path.relative(baseDir, groupPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    logger.warn({ baseDir, groupPath }, 'Group folder path escapes base directory');
    throw new Error(`Path escapes base directory: ${groupPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);

  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);

  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);

  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);

  return ipcPath;
}

// --- Utility functions for group directory management ---

function createGroupDirectory(groupDir: string): void {
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
}

function copyGlobalMdToGroup(groupDir: string): void {
  const globalLocalMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  if (!fs.existsSync(globalLocalMd)) {
    logger.warn({ folder: groupDir }, 'Global CLAUDE.md not found, skipping copy to group');
    return;
  }

  const groupLocalMd = path.join(groupDir, 'CLAUDE.md');
  fs.copyFileSync(globalLocalMd, groupLocalMd);
  logger.info({ folder: groupDir }, 'Copied global CLAUDE.md to group');
}
