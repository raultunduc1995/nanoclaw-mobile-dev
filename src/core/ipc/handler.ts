import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from '../../config.js';
import { isValidGroupFolder } from '../../group-folder.js';
import { logger } from '../../logger.js';
import type { IpcTaskData } from './types.js';
import type { IpcDeps } from './service.js';
import type { LocalDatabase, RegisteredGroup } from '../db/index.js';

export interface IpcHandler {
  start: () => void;
  processTaskCommand: (data: IpcTaskData, sourceGroup: string, isMain: boolean) => Promise<void>;
}

export const createIpcHandler = (localDatabase: LocalDatabase, deps: IpcDeps): IpcHandler => {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  let running = false;

  const moveToErrors = (filePath: string, sourceGroup: string, file: string) => {
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
  };

  const computeNextRun = (scheduleType: 'cron' | 'interval' | 'once', scheduleValue: string): string | null | undefined => {
    if (scheduleType === 'cron') {
      try {
        const interval = CronExpressionParser.parse(scheduleValue, {
          tz: TIMEZONE,
        });
        return interval.next().toISOString();
      } catch {
        logger.warn({ scheduleValue }, 'Invalid cron expression');
        return undefined;
      }
    } else if (scheduleType === 'interval') {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms) || ms <= 0) {
        logger.warn({ scheduleValue }, 'Invalid interval');
        return undefined;
      }
      return new Date(Date.now() + ms).toISOString();
    } else if (scheduleType === 'once') {
      const date = new Date(scheduleValue);
      if (isNaN(date.getTime())) {
        logger.warn({ scheduleValue }, 'Invalid timestamp');
        return undefined;
      }
      return date.toISOString();
    }
    return null;
  };

  const handleScheduleTask = (data: IpcTaskData, sourceGroup: string, isMain: boolean, registeredGroups: Record<string, RegisteredGroup>) => {
    if (!data.prompt || !data.schedule_type || !data.schedule_value || !data.targetJid) return;

    const targetJid = data.targetJid;
    const targetGroupEntry = registeredGroups[targetJid];

    if (!targetGroupEntry) {
      logger.warn({ targetJid }, 'Cannot schedule task: target group not registered');
      return;
    }

    const targetFolder = targetGroupEntry.folder;

    if (!isMain && targetFolder !== sourceGroup) {
      logger.warn({ sourceGroup, targetFolder }, 'Unauthorized schedule_task attempt blocked');
      return;
    }

    const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
    const nextRun = computeNextRun(scheduleType, data.schedule_value);
    if (nextRun === undefined) return;

    const taskId = data.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const contextMode = data.context_mode === 'group' || data.context_mode === 'isolated' ? data.context_mode : 'isolated';

    localDatabase.tasks.create({
      id: taskId,
      groupFolder: targetFolder,
      chatJid: targetJid,
      prompt: data.prompt,
      script: data.script || null,
      scheduleType,
      scheduleValue: data.schedule_value,
      contextMode,
      nextRun,
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    logger.info({ taskId, sourceGroup, targetFolder, contextMode }, 'Task created via IPC');
    deps.onTasksChanged();
  };

  const handleTaskStatusChange = (data: IpcTaskData, sourceGroup: string, isMain: boolean, newStatus: 'active' | 'paused', action: string) => {
    if (!data.taskId) return;

    const task = localDatabase.tasks.getById(data.taskId);
    if (task && (isMain || task.groupFolder === sourceGroup)) {
      localDatabase.tasks.update(data.taskId, { status: newStatus });
      logger.info({ taskId: data.taskId, sourceGroup }, `Task ${action} via IPC`);
      deps.onTasksChanged();
    } else {
      logger.warn({ taskId: data.taskId, sourceGroup }, `Unauthorized task ${action} attempt`);
    }
  };

  const handleCancelTask = (data: IpcTaskData, sourceGroup: string, isMain: boolean) => {
    if (!data.taskId) return;

    const task = localDatabase.tasks.getById(data.taskId);
    if (task && (isMain || task.groupFolder === sourceGroup)) {
      localDatabase.tasks.delete(data.taskId);
      logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
      deps.onTasksChanged();
    } else {
      logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
    }
  };

  const handleUpdateTask = (data: IpcTaskData, sourceGroup: string, isMain: boolean) => {
    if (!data.taskId) return;

    const task = localDatabase.tasks.getById(data.taskId);
    if (!task) {
      logger.warn({ taskId: data.taskId, sourceGroup }, 'Task not found for update');
      return;
    }
    if (!isMain && task.groupFolder !== sourceGroup) {
      logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task update attempt');
      return;
    }

    const updates: Parameters<typeof localDatabase.tasks.update>[1] = {};
    if (data.prompt !== undefined) updates.prompt = data.prompt;
    if (data.script !== undefined) updates.script = data.script || null;
    if (data.schedule_type !== undefined) updates.scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
    if (data.schedule_value !== undefined) updates.scheduleValue = data.schedule_value;

    if (data.schedule_type || data.schedule_value) {
      const updatedTask = { ...task, ...updates };
      const nextRun = computeNextRun(updatedTask.scheduleType as 'cron' | 'interval' | 'once', updatedTask.scheduleValue);
      if (nextRun === undefined) return;
      updates.nextRun = nextRun;
    }

    localDatabase.tasks.update(data.taskId, updates);
    logger.info({ taskId: data.taskId, sourceGroup, updates }, 'Task updated via IPC');
    deps.onTasksChanged();
  };

  const handleRefreshGroups = async (sourceGroup: string, registeredGroups: Record<string, RegisteredGroup>) => {
    logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
    await deps.syncGroups(true);
    const availableGroups = deps.getAvailableGroups();
    deps.writeGroupsSnapshot(sourceGroup, true, availableGroups, new Set(Object.keys(registeredGroups)));
  };

  const handleRegisterGroup = (data: IpcTaskData, sourceGroup: string) => {
    if (!data.jid || !data.name || !data.folder) {
      logger.warn({ data }, 'Invalid register_group request - missing required fields');
      return;
    }

    if (!isValidGroupFolder(data.folder)) {
      logger.warn({ sourceGroup, folder: data.folder }, 'Invalid register_group request - unsafe folder name');
      return;
    }

    deps.registerGroup(data.jid, {
      name: data.name,
      folder: data.folder,
      addedAt: new Date().toISOString(),
      containerConfig: data.containerConfig,
      isMain: false,
    });
  };

  const processTaskCommand = async (data: IpcTaskData, sourceGroup: string, isMain: boolean): Promise<void> => {
    const registeredGroups = deps.getRegisteredGroups();

    switch (data.type) {
      case 'schedule_task':
        handleScheduleTask(data, sourceGroup, isMain, registeredGroups);
        break;

      case 'pause_task':
        handleTaskStatusChange(data, sourceGroup, isMain, 'paused', 'paused');
        break;

      case 'resume_task':
        handleTaskStatusChange(data, sourceGroup, isMain, 'active', 'resumed');
        break;

      case 'cancel_task':
        handleCancelTask(data, sourceGroup, isMain);
        break;

      case 'update_task':
        handleUpdateTask(data, sourceGroup, isMain);
        break;

      case 'refresh_groups':
        if (isMain) {
          await handleRefreshGroups(sourceGroup, registeredGroups);
        } else {
          logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
        }
        break;

      case 'register_group':
        if (isMain) {
          handleRegisterGroup(data, sourceGroup);
        } else {
          logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        }
        break;

      default:
        logger.warn({ type: data.type }, 'Unknown IPC task type');
    }
  };

  const processMessages = async (sourceGroup: string, isMain: boolean, registeredGroups: Record<string, RegisteredGroup>) => {
    const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
    try {
      if (!fs.existsSync(messagesDir)) return;

      const messageFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));

      for (const file of messageFiles) {
        const filePath = path.join(messagesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.type === 'message' && data.chatJid && data.text) {
            const targetGroup = registeredGroups[data.chatJid];
            if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
              await deps.sendMessage(data.chatJid, data.text);
              logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
            } else {
              logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
            }
          }
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
          moveToErrors(filePath, sourceGroup, file);
        }
      }
    } catch (err) {
      logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
    }
  };

  const processTasks = async (sourceGroup: string, isMain: boolean) => {
    const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
    try {
      if (!fs.existsSync(tasksDir)) return;

      const taskFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));

      for (const file of taskFiles) {
        const filePath = path.join(tasksDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          await processTaskCommand(data, sourceGroup, isMain);
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
          moveToErrors(filePath, sourceGroup, file);
        }
      }
    } catch (err) {
      logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
    }
  };

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return;
    }

    const registeredGroups = deps.getRegisteredGroups();

    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      await processMessages(sourceGroup, isMain, registeredGroups);
      await processTasks(sourceGroup, isMain);
    }
  };

  const poll = () => {
    processIpcFiles().then(() => {
      setTimeout(poll, IPC_POLL_INTERVAL);
    });
  };

  return {
    start: () => {
      if (running) {
        logger.debug('IPC watcher already running, skipping duplicate start');
        return;
      }
      running = true;
      fs.mkdirSync(ipcBaseDir, { recursive: true });
      poll();
      logger.info('IPC watcher started (per-group namespaces)');
    },

    processTaskCommand,
  };
};
