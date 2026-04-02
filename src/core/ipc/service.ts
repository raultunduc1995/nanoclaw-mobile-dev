import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { logger } from '../../logger.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from '../../container-runner.js';
import type { RegisteredGroup, LocalDatabase } from '../db/index.js';
import type { AvailableGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (groupFolder: string, isMain: boolean, availableGroups: AvailableGroup[], registeredJids: Set<string>) => void;
  onTasksChanged: () => void;
}

export const createIpcService = (localDatabase: LocalDatabase, sendMessage: (jid: string, text: string) => Promise<void>, syncGroupsFn: (force: boolean) => Promise<void>): IpcDeps => {
  const groups: Record<string, RegisteredGroup> = localDatabase.groups.getAll();

  return {
    sendMessage,

    syncGroups: syncGroupsFn,

    getRegisteredGroups: () => groups,

    registerGroup: (jid: string, group: RegisteredGroup) => {
      let groupDir: string;
      try {
        groupDir = resolveGroupFolderPath(group.folder);
      } catch (err) {
        logger.warn({ jid, folder: group.folder, err }, 'Rejecting group registration with invalid folder');
        return;
      }

      groups[jid] = group;
      localDatabase.groups.set(jid, group);

      fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

      if (!group.isMain) {
        const globalLocalMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.local.md');
        const groupLocalMd = path.join(groupDir, 'CLAUDE.local.md');
        if (fs.existsSync(globalLocalMd)) {
          fs.copyFileSync(globalLocalMd, groupLocalMd);
          logger.info({ folder: group.folder }, 'Copied global CLAUDE.local.md to group');
        }
      }

      logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
    },

    getAvailableGroups: () => {
      const chats = localDatabase.chats.getAll();
      const registeredJids = new Set(Object.keys(groups));

      return chats
        .filter((c) => c.jid !== '__group_sync__' && c.isGroup)
        .map((c) => ({
          jid: c.jid,
          name: c.name,
          lastActivity: c.lastMessageTime,
          isRegistered: registeredJids.has(c.jid),
        }));
    },

    writeGroupsSnapshot: (groupFolder: string, isMain: boolean, availableGroups: AvailableGroup[], registeredJids: Set<string>) => {
      writeGroupsSnapshot(groupFolder, isMain, availableGroups, registeredJids);
    },

    onTasksChanged: () => {
      const tasks = localDatabase.tasks.getAll();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.groupFolder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.scheduleType,
        schedule_value: t.scheduleValue,
        status: t.status,
        next_run: t.nextRun,
      }));
      for (const group of Object.values(groups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  };
};
