import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { TIMEZONE } from '../config.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from '../container-runtime.js';
import { GroupQueue } from '../group-queue.js';

import { type Message, resolveGroupIpcPath } from './repositories/index.js';
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
import { createMessageFlow, type MessageFlow, type MessageFlowDeps } from './flows/index.js';
import { formatMessages } from './utils/index.js';

let groupsRepo: GroupsRepository;
let chatsRepo: ChatsRepository;
let messagesRepo: MessagesRepository;
let routerStateRepo: RouterStateRepository;
let tasksRepo: TasksRepository;
let ipcHandler: IpcHandler;
let messageFlow: MessageFlow;
let groupQueue: GroupQueue; // TODO: Check the groupqueue implementation

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
    const tasks = tasksRepo.getAll();
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
    const registeredGroups = groupsRepo.getAllAsRecord();
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
    const chats = chatsRepo.getGroupChats();
    const registeredJids = groupsRepo.getAllJids();

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
      getById: (jid) => groupsRepo.getByJid(jid),
      register: (jid, group) => groupsRepo.register(jid, group),
      getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
    },
    tasksDeps: {
      save: (task) => {
        tasksRepo.save(task);
        onTasksChanged();
      },
      getById: (id) => tasksRepo.getById(id),
      update: (task) => {
        tasksRepo.update(task);
        onTasksChanged();
      },
      delete: (id) => {
        tasksRepo.delete(id);
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

const initMessageFlow = () => {
  messageFlow = createMessageFlow({
    getRouterState: () => routerStateRepo.get(),
    getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
    getRegisteredGroupsJids: () => groupsRepo.getAllJids(),
    getMessagesSince: (jid, since) => messagesRepo.getSince(jid, since),
    getNewMessagesSince: (jids, since) => messagesRepo.getNewSince(jids, since),
    getFormattedMessagesFor: (messages) => formatMessages(messages, TIMEZONE),
    saveRouterState: (state) => routerStateRepo.set(state),
    enqueueMessageCheck: (jid) => groupQueue.enqueueMessageCheck(jid), // TODO: Check the groupqueue implementation
    sendMessageToQueue: (jid, message) => groupQueue.sendMessage(jid, message), // TODO: Check the groupqueue implementation
    setTypingForChannel: (jid) => channelsRegistry.findChannel(jid)?.setTyping(jid)
  });
};

const initMain = () => {
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  initRepos();
  initIpcHandler();
  groupQueue = new GroupQueue();
  initMessageFlow();
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
    onInboundMessage: (message) => messagesRepo.save(message),
    onChatMetadata: (chatJid, timestamp, name, isGroup) => {
      chatsRepo.saveChat(chatJid, {
        timestamp,
        name,
        channel: 'telegram',
        isGroup,
      });
    },
    getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
  });

  channelsRegistry.registerTelegramChannel(telegramOps);
  await channelsRegistry.connectAll();
};
export const main = async () => {
  initMain();

  registerCleanupHandlers();
  await registerChannels();

  ipcHandler.start();
  groupQueue.setProcessMessagesFn(); // TODO: Check the groupqueue implementation
  messageFlow.enqueuePreviousSessionLostMessages();
  messageFlow.startMessagesWatcher();
};
