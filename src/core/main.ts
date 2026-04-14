import { logger } from '../logger.js';
import { GroupQueue } from '../group-queue.js';
import { runAgent } from './agentRunner/index.js';

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
} from './repositories/index.js';
import { createAgentFlow, createMessageFlow, createTaskFlow, type AgentFlow, type MessageFlow, type TaskFlow } from './flows/index.js';
import { formatMessages } from './utils/index.js';

let groupsRepo: GroupsRepository;
let chatsRepo: ChatsRepository;
let messagesRepo: MessagesRepository;
let routerStateRepo: RouterStateRepository;
let tasksRepo: TasksRepository;
let messageFlow: MessageFlow;
let taskFlow: TaskFlow;
let agentFlow: AgentFlow;
let ipcHandler: IpcHandler;
let groupQueue: GroupQueue;

const initRepos = () => {
  const localResource = initLocalDatabase();
  groupsRepo = createGroupsRepository(localResource.groups);
  chatsRepo = createChatsRepository(localResource.chats);
  messagesRepo = createMessagesRepository(localResource.messages);
  routerStateRepo = createRouterStateRepository(localResource.routerState);
  tasksRepo = createTasksRepository(localResource.tasks);
};

const initAgentFlow = () => {
  agentFlow = createAgentFlow();
};

const initTaskFlow = () => {
  taskFlow = createTaskFlow({
    getAllScheduledTasks: () => tasksRepo.getAll(),
    getAllRegisteredGroupsAsRecord: () => groupsRepo.getAllAsRecord(),
    getDueTasks: () => tasksRepo.getDue(),
    getTaskById: (id) => tasksRepo.getById(id),
    updateTask: (task) => tasksRepo.update(task),
    updateTaskAfterRun: (id, lastResult, nextRun) => tasksRepo.updateAfterRun(id, lastResult, nextRun),
    enqueueTask: (jid, taskId, fn) => groupQueue.enqueueTask(jid, taskId, fn),
    runTaskAgent: async (group, task) => {
      
      let result: string | null = null;
      let error: string | null = null;

      try {
        const output = await runAgent(
          { prompt: task.prompt, groupFolder: task.groupFolder, chatJid: task.chatJid, isMain: group.isMain, isScheduledTask: true, script: task.script },
          (proc, containerName) => groupQueue.registerProcess(task.chatJid, proc, containerName, task.groupFolder),
          async (text) => {
            result = text;
            await (channelsRegistry.findChannel(task.chatJid)?.sendMessage(task.chatJid, text) ?? Promise.resolve());
          },
        );
        if (output.status === 'error') error = output.error || 'Unknown error';
        else if (output.result) result = output.result;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      return { result, error };
    },
  });
};

// cross-repo query. It doesn't belong anywhere...
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

const initMessageFlow = () => {
  messageFlow = createMessageFlow({
    getLastAgentTimestamps: () => routerStateRepo.get()?.lastAgentTimestamp ?? {},
    getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
    getMessagesSince: (jid, since) => messagesRepo.getSince(jid, since),
    deliver: (jid, groupFolder, prompt) => groupQueue.deliver(jid, groupFolder, prompt),
  });
};

const initIpcHandler = () => {
  ipcHandler = createIpcHandler({
    groupsDeps: {
      getById: (jid) => groupsRepo.getByJid(jid),
      register: (jid, group) => groupsRepo.register(jid, group),
      getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
    },
    tasksDeps: {
      save: (task) => {
        tasksRepo.save(task);
        taskFlow.onTasksChanged();
      },
      getById: (id) => tasksRepo.getById(id),
      update: (task) => {
        tasksRepo.update(task);
        taskFlow.onTasksChanged();
      },
      delete: (id) => {
        tasksRepo.delete(id);
        taskFlow.onTasksChanged();
      },
    },
    chatsDeps: {
      getAvailableChatGroups: () => getAvailableChatGroups(),
    },
    channelRegistryDeps: {
      sendMessageTo: (jid, message) => channelsRegistry.findChannel(jid)?.sendMessage(jid, message),
    },
    containerRunnerDeps: {
      writeAvailableGroupsIn: ({ groupFolder, groups, isMain }) => agentFlow.writeAvailableGroupsIn(groupFolder, groups, isMain),
    },
  });
};

const initMain = () => {
  initRepos();
  groupQueue = new GroupQueue({
    runAgent: async (jid, groupFolder, prompt) => {
      const group = Object.values(groupsRepo.getAllAsRecord()).find((g) => g.folder === groupFolder);
      if (!group) {
        logger.error({ jid, groupFolder }, 'runAgent: group not found');
        return;
      }

      taskFlow.onTasksChangedFor(group);
      agentFlow.writeAvailableGroupsIn(group.folder, getAvailableChatGroups(), group.isMain);

      await runAgent(
        { prompt, groupFolder, chatJid: jid, isMain: group.isMain },
        (proc, containerName) => groupQueue.registerProcess(jid, proc, containerName, group.folder),
        async (text) => {
          await (channelsRegistry.findChannel(jid)?.sendMessage(jid, text) ?? Promise.resolve());
        },
      );
    },
  });
  initAgentFlow();
  initTaskFlow();
  initMessageFlow();
  initIpcHandler();
};

const registerCleanupHandlers = () => {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await groupQueue.shutdown(10000);
    await channelsRegistry.disconnectAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

const registerChannels = async () => {
  const telegramOps: TelegramChannelOpts = createTelegramChannelOpts({
    type: 'telegram',
    onInboundMessage: (message, group) => {
      messagesRepo.save(message);
      const prompt = formatMessages([message]);
      groupQueue.deliver(message.chatJid, group.folder, prompt);
      channelsRegistry.findChannel(message.chatJid)?.setTyping(message.chatJid);
    },
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
  messageFlow.enqueuePreviousSessionLostMessages();
  taskFlow.startSchedulerLoop();
};
