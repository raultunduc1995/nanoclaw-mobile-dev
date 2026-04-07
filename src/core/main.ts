import fs from 'fs';
import path from 'path';

import { cleanupOrphans, ensureContainerRuntimeRunning } from '../container-runtime.js';
import { Message, resolveGroupFolderPath, resolveGroupIpcPath } from './repositories/index.js';
import channelsRegistry, { createTelegramChannelOpts, type TelegramChannelOpts } from './channels/index.js';
import { initLocalDatabase } from './db/index.js';
import { createIpcHandler, type IpcHandler } from './ipc/index.js';
import {
  createChatsRepository,
  createGroupsRepository,
  createMessagesRepository,
  createRouterStateRepository,
  createTasksRepository,
  type GroupsRepository,
  type ChatsRepository,
  type MessagesRepository,
  type RouterStateRepository,
  type TasksRepository,
  type AvailableGroup,
  type NewScheduledTask,
  type RegisteredGroup,
  type ScheduledTask,
} from './repositories/index.js';
import { logger } from '../logger.js';

let groupsRepo: GroupsRepository;
let chatsRepo: ChatsRepository;
let messagesRepo: MessagesRepository;
let routerStateRepo: RouterStateRepository;
let tasksRepo: TasksRepository;
let ipcHandler: IpcHandler;

const initRepos = () => {
  const localResource = initLocalDatabase();
  groupsRepo = createGroupsRepository(localResource.groups);
  chatsRepo = createChatsRepository(localResource.chats);
  messagesRepo = createMessagesRepository(localResource.messages);
  routerStateRepo = createRouterStateRepository(localResource.routerState);
  tasksRepo = createTasksRepository(localResource.tasks);
};

const initIpcHandler = () => {
  // TODO: MOVE THESE FUNCTIONS INTO A SEPARATE COMPONENT (CONTAINER-RUNNER)
  const writeTasksSnapshot = ({
    folder,
    isMain,
    taskRows,
  }: {
    folder: string;
    isMain: boolean;
    taskRows: {
      id: string;
      groupFolder: string;
      prompt: string;
      script?: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      status: 'active' | 'paused' | 'completed';
      next_run?: string;
    }[];
  }) => {
    // Write filtered tasks to the group's IPC directory
    const groupIpcDir = resolveGroupIpcPath(folder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    // Main sees all tasks, others only see their own
    const filteredTasks = isMain ? taskRows : taskRows.filter((t) => t.groupFolder === folder);

    const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
  };
  const onTasksChanged = () => {
    const tasks = tasksRepo.getAllTasks();
    const taskRows = tasks.map((t) => ({
      id: t.id,
      groupFolder: t.groupFolder,
      prompt: t.prompt,
      script: t.script ?? undefined,
      schedule_type: t.scheduleType,
      schedule_value: t.scheduleValue,
      status: t.status,
      next_run: t.nextRun,
    }));
    const registeredGroups = groupsRepo.getRegisteredGroupsRecord();
    for (const group of Object.values(registeredGroups)) {
      writeTasksSnapshot({
        folder: group.folder,
        isMain: group.isMain === true,
        taskRows,
      });
    }
  };
  const writeAvailableGroupsIn = ({ groupFolder, groups, isMain }: { groupFolder: string; groups: AvailableGroup[]; isMain: boolean }): void => {
    const groupIpcDir = resolveGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    // Main sees all groups; others see nothing (they can't activate groups)
    const visibleGroups = isMain ? groups : [];

    const groupsFile = path.join(groupIpcDir, 'available_groups.json');
    fs.writeFileSync(
      groupsFile,
      JSON.stringify(
        {
          groups: visibleGroups,
          lastSync: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  };
  // --------------------------------------

  const getAvailableChatGroups = () => {
    const chats = chatsRepo.getAvailableGroupChats();
    const registeredJids = groupsRepo.getRegisteredGroupsJids();

    return chats.map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.lastMessageTime,
      isRegistered: registeredJids.has(c.jid),
    }));
  };

  const sendMessageToChannel = async (jid: string, message: string) => {
    const channel = channelsRegistry.findChannel(jid);
    if (!channel) throw Error(`No channel found for jid: ${jid}`);
    await channel.sendMessage(jid, message);
  };

  ipcHandler = createIpcHandler({
    groupsDeps: {
      getById: (jid) => groupsRepo.getBy(jid),
      register: (jid, group) => groupsRepo.registerGroup(jid, group),
      getRegisteredGroups: () => groupsRepo.getRegisteredGroupsRecord(),
    },
    tasksDeps: {
      save: (task) => {
        tasksRepo.saveTask(task);
        onTasksChanged();
      },
      getById: (id) => tasksRepo.getTaskById(id),
      update: (task) => {
        tasksRepo.updateTask(task);
        onTasksChanged();
      },
      delete: (id) => {
        tasksRepo.deleteTask(id);
        onTasksChanged();
      },
    },
    chatsDeps: {
      getAvailableChatGroups: () => getAvailableChatGroups(),
    },
    channelRegistryDeps: {
      sendMessageTo: (jid, message) => sendMessageToChannel(jid, message),
    },
    containerRunnerDeps: {
      writeAvailableGroupsIn: ({ groupFolder, groups, isMain }) => writeAvailableGroupsIn({ groupFolder, groups, isMain }),
    },
  });
};

const initMain = () => {
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  initRepos();
  initIpcHandler();
};

const registerCleanupHandlers = () => {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // await queue.shutdown(10000);
    await channelsRegistry.disconnectAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

const registerChannels = async () => {
  const telegramOps: TelegramChannelOpts = createTelegramChannelOpts({
    type: 'telegram',
    onInboundMessage: (message) => messagesRepo.saveMessage(message),
    onChatMetadata: (chatJid, timestamp, name?, channel?, isGroup?) => {
      chatsRepo.storeMetadata(chatJid, {
        timestamp,
        name,
        channel,
        isGroup,
      });
    },
    getRegisteredGroups: () => groupsRepo.getRegisteredGroupsRecord(),
    resolveGroupFolderPath: (folder) => resolveGroupFolderPath(folder),
  });

  channelsRegistry.registerTelegramChannel(telegramOps);
  await channelsRegistry.connectAll();
};
export const main = async () => {
  initMain();

  registerCleanupHandlers();
  await registerChannels();
  ipcHandler.start();
};
