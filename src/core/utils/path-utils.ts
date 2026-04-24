import path from 'path';
import { logger } from '../../logger.js';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    logger.warn({ folder }, 'Invalid group folder');
    throw new Error(`Invalid group folder "${folder}"`);
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

function ensureWithinBase(baseDir: string, groupPath: string): void {
  const rel = path.relative(baseDir, groupPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    logger.warn({ baseDir, groupPath }, 'Group folder path escapes base directory');
    throw new Error(`Path escapes base directory: ${groupPath}`);
  }
}
