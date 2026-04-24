import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from '../../config.js';
import { logger } from '../../logger.js';

import { ipcTaskSchema, ipcMessageSchema, type IpcTaskData, type IpcMessageData } from './types.js';
import type { NewScheduledTask, RegisteredGroup, ScheduledTask } from '../repositories/index.js';

type AvailableGroup = { jid: string; name: string; lastActivity: string; isRegistered: boolean };
import { ZodSafeParseResult } from 'zod';

export interface IpcHandlerDeps {
  groupsDeps: {
    getById: (jid: string) => RegisteredGroup | undefined;
    register: (jid: string, group: RegisteredGroup) => void;
    getRegisteredGroups: () => Record<string, RegisteredGroup>;
  };
  tasksDeps: {
    save: (task: NewScheduledTask) => void;
    getById: (id: string) => ScheduledTask | undefined;
    update: (task: ScheduledTask) => void;
    delete: (id: string) => void;
  };
  chatsDeps: {
    getAvailableChatGroups: () => AvailableGroup[];
  };
  channelRegistryDeps: {
    sendMessageTo: (jid: string, message: string) => void;
  };
  containerRunnerDeps: {
    writeAvailableGroupsIn: ({ groupFolder, groups, isMain }: { groupFolder: string; groups: AvailableGroup[]; isMain: boolean }) => void;
  };
}

export interface IpcHandler {
  start: () => void;
  // Exposed for testing only — in production, start() polls directories and calls these internally
  processTaskCommand: (taskData: IpcTaskData, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => Promise<void>;
  processMessage: (data: IpcMessageData, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => Promise<void>;
}

export const createIpcHandler = ({ groupsDeps, tasksDeps, chatsDeps, channelRegistryDeps, containerRunnerDeps }: IpcHandlerDeps): IpcHandler => {
  const messagesIpcHandler = createMessagesIpcHandler(groupsDeps, channelRegistryDeps);
  const tasksIpcHandler = createTasksIpcHandler(groupsDeps, tasksDeps, chatsDeps, containerRunnerDeps);
  let running = false;

  const processIpcFiles = async () => {
    const groupsFolders = getIpcGroupsFolders();
    const registeredGroups = groupsDeps.getRegisteredGroups();
    const mainGroupFolder = Object.values(registeredGroups).find((group) => group.isMain)?.folder;

    for (const groupFolder of groupsFolders) {
      const isMain = groupFolder === mainGroupFolder;
      await messagesIpcHandler.processMessages(groupFolder, isMain);
      await tasksIpcHandler.processTasks(groupFolder, isMain);
    }
  };

  const poll = async () => {
    await processIpcFiles();
    setTimeout(poll, IPC_POLL_INTERVAL);
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

    processTaskCommand: tasksIpcHandler.processTaskCommand,
    processMessage: messagesIpcHandler.processMessage,
  };
};

const createMessagesIpcHandler = (
  groupsDeps: {
    getRegisteredGroups: () => Record<string, RegisteredGroup>;
  },
  channelRegistryDeps: {
    sendMessageTo: (jid: string, message: string) => void;
  },
): {
  processMessages: (groupFolder: string, isMain: boolean) => Promise<void>;
  processMessage: (data: IpcMessageData, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => Promise<void>;
} => {
  const processMessage = async (data: IpcMessageData, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => {
    const registeredGroups = groupsDeps.getRegisteredGroups();
    const { chatJid, text } = data;
    const targetGroup = registeredGroups[chatJid];

    if (isMain || (targetGroup && targetGroup.folder === groupFolder)) {
      channelRegistryDeps.sendMessageTo(chatJid, text);
      logger.info({ chatJid, groupFolder }, 'IPC message sent');
    } else {
      logger.warn({ chatJid, groupFolder }, 'Unauthorized IPC message attempt blocked');
    }
  };

  return {
    processMessages: async (groupFolder, isMain) => {
      const { messagesDir, messagesFiles } = getGroupsMessagesFolder(groupFolder);

      for (const file of messagesFiles) {
        const filePath = path.join(messagesDir, file);
        try {
          const parsed = extractMessageDataFromFile({ filePath, groupFolder, file });
          await processMessage(parsed.data, { groupFolder, isMain });
        } catch (err) {
          logger.error({ file, groupFolder, err }, 'Error processing IPC message');
          moveToErrors(filePath, groupFolder, file);
        }
      }
    },

    processMessage,
  };
};

const createTasksIpcHandler = (
  groupsDeps: {
    getById: (jid: string) => RegisteredGroup | undefined;
    register: (jid: string, group: RegisteredGroup) => void;
  },
  tasksDeps: {
    save: (task: NewScheduledTask) => void;
    getById: (id: string) => ScheduledTask | undefined;
    update: (task: ScheduledTask) => void;
    delete: (id: string) => void;
  },
  chatsDeps: {
    getAvailableChatGroups: () => AvailableGroup[];
  },
  containerRunnerDeps: {
    writeAvailableGroupsIn: ({ groupFolder, groups, isMain }: { groupFolder: string; groups: AvailableGroup[]; isMain: boolean }) => void;
  },
): {
  processTasks: (groupFolder: string, isMain: boolean) => Promise<void>;
  processTaskCommand: (taskData: IpcTaskData, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => Promise<void>;
} => {
  // --- Task command handlers ---

  const handleScheduleTask = (taskData: Extract<IpcTaskData, { type: 'schedule_task' }>, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => {
    const targetGroup = groupsDeps.getById(taskData.targetJid);
    if (!targetGroup) {
      logger.warn({ targetJid: taskData.targetJid }, 'Cannot schedule task: target group not registered');
      return;
    }
    if (!isMain && targetGroup.folder !== groupFolder) {
      logger.warn({ groupFolder, targetFolder: targetGroup.folder }, 'Unauthorized schedule_task attempt blocked');
      return;
    }

    const task = fromIpcScheduleTaskToNewScheduledTask(taskData, targetGroup.folder);
    tasksDeps.save(task);
    logger.info({ taskId: task.id, groupFolder, targetFolder: targetGroup.folder, contextMode: task.contextMode }, 'Task created via IPC');
  };

  const handleTaskStatusChange = (
    taskData: Extract<IpcTaskData, { type: 'pause_task' }> | Extract<IpcTaskData, { type: 'resume_task' }>,
    { groupFolder, isMain, newStatus, action }: { groupFolder: string; isMain: boolean; newStatus: 'active' | 'paused'; action: string },
  ) => {
    let task = tasksDeps.getById(taskData.taskId);
    if (!task) {
      logger.warn({ taskId: taskData.taskId }, `Cannot ${action} task: not found`);
      return;
    }
    if (!isMain && task.groupFolder !== groupFolder) {
      logger.warn({ taskId: taskData.taskId, groupFolder }, `Unauthorized task ${action} attempt blocked`);
      return;
    }

    task = {
      ...task,
      status: newStatus,
    };
    tasksDeps.update(task);
    logger.info({ taskId: taskData.taskId, groupFolder }, `Task ${action} via IPC`);
  };

  const handleCancelTask = (taskData: Extract<IpcTaskData, { type: 'cancel_task' }>, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => {
    const task = tasksDeps.getById(taskData.taskId);
    if (!task) {
      logger.warn({ taskId: taskData.taskId }, 'Cannot cancel task: not found');
      return;
    }
    if (!isMain && task.groupFolder !== groupFolder) {
      logger.warn({ taskId: taskData.taskId, groupFolder }, 'Unauthorized task cancel attempt blocked');
      return;
    }

    tasksDeps.delete(taskData.taskId);
    logger.info({ taskId: taskData.taskId, groupFolder }, 'Task cancelled via IPC');
  };

  const handleUpdateTask = (taskData: Extract<IpcTaskData, { type: 'update_task' }>, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }) => {
    const existingTask = tasksDeps.getById(taskData.taskId);
    if (!existingTask) {
      logger.warn({ taskId: taskData.taskId, groupFolder }, 'Task not found for update');
      return;
    }
    if (!isMain && existingTask.groupFolder !== groupFolder) {
      logger.warn({ taskId: taskData.taskId, groupFolder }, 'Unauthorized task update attempt');
      return;
    }

    const updatedTask = fromIpcUpdateTaskToScheduledTask(taskData, existingTask);
    tasksDeps.update(updatedTask);
    logger.info({ taskId: taskData.taskId, groupFolder }, 'Task updated via IPC');
  };

  const handleRefreshGroups = async (groupFolder: string, isMain: boolean) => {
    if (!isMain) {
      logger.warn({ groupFolder }, 'Unauthorized refresh_groups attempt blocked');
      return;
    }
    logger.info({ groupFolder }, 'Group metadata refresh requested via IPC');
    containerRunnerDeps.writeAvailableGroupsIn({ groupFolder, groups: chatsDeps.getAvailableChatGroups(), isMain });
  };

  const handleRegisterGroup = (taskData: Extract<IpcTaskData, { type: 'register_group' }>, isMain: boolean) => {
    if (!isMain) {
      logger.warn({ taskData }, 'Unauthorized register_group attempt blocked');
      return;
    }
    groupsDeps.register(taskData.jid, fromIpcRegisterGroupToRegisteredGroup(taskData));
  };

  // --- Command router ---

  const processTaskCommand = async (taskData: IpcTaskData, { groupFolder, isMain }: { groupFolder: string; isMain: boolean }): Promise<void> => {
    switch (taskData.type) {
      case 'schedule_task':
        handleScheduleTask(taskData, { groupFolder, isMain });
        break;
      case 'pause_task':
        handleTaskStatusChange(taskData, { groupFolder, isMain, newStatus: 'paused', action: 'paused' });
        break;
      case 'resume_task':
        handleTaskStatusChange(taskData, { groupFolder, isMain, newStatus: 'active', action: 'resumed' });
        break;
      case 'cancel_task':
        handleCancelTask(taskData, { groupFolder, isMain });
        break;
      case 'update_task':
        handleUpdateTask(taskData, { groupFolder, isMain });
        break;
      case 'refresh_groups':
        await handleRefreshGroups(groupFolder, isMain);
        break;
      case 'register_group':
        handleRegisterGroup(taskData, isMain);
        break;
    }
  };

  return {
    processTasks: async (groupFolder, isMain) => {
      const { tasksDir, tasksFiles } = getGroupTasksFiles(groupFolder);

      for (const file of tasksFiles) {
        const filePath = path.join(tasksDir, file);
        try {
          const parsed = extractTaskDataFromFile({ filePath, groupFolder, file });
          await processTaskCommand(parsed.data, { groupFolder, isMain });
        } catch (err) {
          logger.error({ file, groupFolder, err }, 'Error processing IPC task');
          moveToErrors(filePath, groupFolder, file);
        }
      }
    },

    processTaskCommand,
  };
};

// --- IPC file handling utilities ---

const ipcBaseDir = path.join(DATA_DIR, 'ipc');

type PathGoupFile = { filePath: string; groupFolder: string; file: string };
const extractMessageDataFromFile = ({ filePath, groupFolder, file }: PathGoupFile) => extractDataFromFile(filePath, groupFolder, file, ipcMessageSchema.safeParse);
const extractTaskDataFromFile = ({ filePath, groupFolder, file }: PathGoupFile) => extractDataFromFile(filePath, groupFolder, file, ipcTaskSchema.safeParse);
const extractDataFromFile = <T>(filePath: string, groupFolder: string, file: string, safeParse: (raw: any) => ZodSafeParseResult<T>) => {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const parsed = safeParse(raw);
  if (!parsed.success) {
    logger.warn({ file, groupFolder, errors: parsed.error.issues }, 'Invalid IPC task file');
    throw Error(`Invalid IPC task file`);
  }
  fs.unlinkSync(filePath);

  return parsed;
};

const moveToErrors = (filePath: string, groupFolder: string, file: string) => {
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });
  fs.renameSync(filePath, path.join(errorDir, `${groupFolder}-${file}`));
};

const getIpcGroupsFolders = () => {
  let groupsFolders: string[] = [];
  try {
    groupsFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
      const stat = fs.statSync(path.join(ipcBaseDir, f));
      return stat.isDirectory() && f !== 'errors';
    });
  } catch (err) {
    logger.error({ err }, 'Error reading IPC base directory');
  }

  return groupsFolders;
};

const getGroupsMessagesFolder = (groupFolder: string): { messagesDir: string; messagesFiles: string[] } => {
  const messagesDir = path.join(ipcBaseDir, groupFolder, 'messages');
  let messagesFiles: string[] = [];
  try {
    if (fs.existsSync(messagesDir)) {
      messagesFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
    }
  } catch (err) {
    logger.error({ err, groupFolder }, 'Error reading IPC messages directory');
  }

  return { messagesDir, messagesFiles };
};

const getGroupTasksFiles = (groupFolder: string): { tasksDir: string; tasksFiles: string[] } => {
  const tasksDir = path.join(ipcBaseDir, groupFolder, 'tasks');
  let tasksFiles: string[] = [];
  try {
    if (fs.existsSync(tasksDir)) {
      tasksFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    }
  } catch (err) {
    logger.error({ err, groupFolder }, 'Error reading IPC tasks directory');
  }

  return { tasksDir, tasksFiles };
};

// --- Data transformation helpers ---

const fromIpcScheduleTaskToNewScheduledTask = (taskData: Extract<IpcTaskData, { type: 'schedule_task' }>, targetGroupFolder: string): NewScheduledTask => ({
  id: taskData.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  groupFolder: targetGroupFolder,
  chatJid: taskData.targetJid,
  prompt: taskData.prompt,
  script: taskData.script,
  scheduleType: taskData.schedule_type,
  scheduleValue: taskData.schedule_value,
  contextMode: taskData.context_mode || 'isolated',
  nextRun: computeNextRun({ scheduleType: taskData.schedule_type, scheduleValue: taskData.schedule_value }),
});

const fromIpcUpdateTaskToScheduledTask = (taskData: Extract<IpcTaskData, { type: 'update_task' }>, existingTask: ScheduledTask): ScheduledTask => ({
  ...existingTask,
  prompt: taskData.prompt ?? existingTask.prompt,
  script: taskData.script ?? existingTask.script,
  scheduleType: taskData.schedule_type ?? existingTask.scheduleType,
  scheduleValue: taskData.schedule_value ?? existingTask.scheduleValue,
  nextRun:
    taskData.schedule_type || taskData.schedule_value
      ? computeNextRun({ scheduleType: taskData.schedule_type ?? existingTask.scheduleType, scheduleValue: taskData.schedule_value ?? existingTask.scheduleValue })
      : existingTask.nextRun,
});

const fromIpcRegisterGroupToRegisteredGroup = (data: Extract<IpcTaskData, { type: 'register_group' }>): RegisteredGroup => ({
  name: data.name,
  folder: data.folder,
  addedAt: new Date().toISOString(),
  containerConfig: data.containerConfig,
  isMain: false,
  sessionId: '', // TODO: Send the sessionId as well
});

export const computeNextRun = ({ scheduleType, scheduleValue }: { scheduleType: 'cron' | 'interval' | 'once'; scheduleValue: string }): string => {
  const computeCronNextRun = () => {
    let nextRun: string | null = null;

    try {
      const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
      nextRun = interval.next().toISOString();
    } catch (error) {
      logger.warn({ scheduleValue }, 'Invalid cron expression');
      throw new Error(`Invalid cron expression: ${scheduleValue}`, { cause: error });
    }

    if (!nextRun) {
      logger.warn({ scheduleValue }, 'Cron expression has no future runs');
      throw new Error(`Cron expression has no future runs: ${scheduleValue}`);
    }

    return nextRun;
  };
  const computeIntervalNextRun = () => {
    const ms = parseInt(scheduleValue, 10);

    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue }, 'Invalid interval');
      throw new Error(`Invalid interval (must be positive integer in milliseconds): ${scheduleValue}`);
    }

    return new Date(Date.now() + ms).toISOString();
  };
  const computeOnceNextRun = () => {
    const date = new Date(scheduleValue);

    if (isNaN(date.getTime())) {
      logger.warn({ scheduleValue }, 'Invalid timestamp');
      throw new Error(`Invalid timestamp for one-time task: ${scheduleValue}`);
    }

    return date.toISOString();
  };

  if (scheduleType === 'cron') {
    return computeCronNextRun();
  } else if (scheduleType === 'interval') {
    return computeIntervalNextRun();
  } else if (scheduleType === 'once') {
    return computeOnceNextRun();
  } else {
    throw new Error(`Unsupported schedule type: ${scheduleType}`);
  }
};
