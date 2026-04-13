import { logger } from '../logger.js';
import { IDLE_TIMEOUT } from '../config.js';
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
      
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      let result: string | null = null;
      let error: string | null = null;

      const TASK_CLOSE_DELAY_MS = 10_000;
      const scheduleClose = () => {
        if (closeTimer) return;
        closeTimer = setTimeout(() => {
          groupQueue.closeStdin(task.chatJid);
        }, TASK_CLOSE_DELAY_MS);
      };

      try {
        const output = await runAgent(
          { prompt: task.prompt, groupFolder: task.groupFolder, chatJid: task.chatJid, isMain: group.isMain, isScheduledTask: true, script: task.script },
          (proc, containerName) => groupQueue.registerProcess(task.chatJid, proc, containerName, task.groupFolder),
          async (streamedOutput) => {
            if (streamedOutput.result) {
              result = streamedOutput.result;
              await (channelsRegistry.findChannel(task.chatJid)?.sendMessage(task.chatJid, streamedOutput.result) ?? Promise.resolve());
              scheduleClose();
            }
            if (streamedOutput.status === 'success') {
              groupQueue.notifyIdle(task.chatJid);
              scheduleClose();
            }
            if (streamedOutput.status === 'error') {
              error = streamedOutput.error || 'Unknown error';
            }
          },
        );
        if (closeTimer) clearTimeout(closeTimer);
        if (output.status === 'error') error = output.error || 'Unknown error';
        else if (output.result) result = output.result;
      } catch (err) {
        if (closeTimer) clearTimeout(closeTimer);
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
    getRouterState: () => routerStateRepo.get(),
    getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
    getRegisteredGroupsJids: () => groupsRepo.getAllJids(),
    getMessagesSince: (jid, since) => messagesRepo.getSince(jid, since),
    getNewMessagesSince: (jids, since) => messagesRepo.getNewSince(jids, since),
    getFormattedMessagesFor: (messages) => formatMessages(messages),
    saveRouterState: (state) => routerStateRepo.set(state),
    deliver: (jid, groupFolder, prompt) => groupQueue.deliver(jid, groupFolder, prompt),
    setTypingForChannel: (jid) => channelsRegistry.findChannel(jid)?.setTyping(jid),
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

      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          logger.debug({ groupFolder }, 'Idle timeout, closing container stdin');
          groupQueue.closeStdin(jid);
        }, IDLE_TIMEOUT);
      };

      taskFlow.onTasksChangedFor(group);
      agentFlow.writeAvailableGroupsIn(group.folder, getAvailableChatGroups(), group.isMain);

      await runAgent(
        { prompt, groupFolder, chatJid: jid, isMain: group.isMain },
        (proc, containerName) => groupQueue.registerProcess(jid, proc, containerName, group.folder),
        async (containerOutput) => {
          if (containerOutput.result) {
            const raw = typeof containerOutput.result === 'string' ? containerOutput.result : JSON.stringify(containerOutput.result);
            const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
            if (text) {
              await (channelsRegistry.findChannel(jid)?.sendMessage(jid, text) ?? Promise.resolve());
            }
            resetIdleTimer();
          }
          if (containerOutput.status === 'success') {
            groupQueue.notifyIdle(jid);
          }
        },
      );

      if (idleTimer) clearTimeout(idleTimer);
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
  messageFlow.enqueuePreviousSessionLostMessages();
  messageFlow.startMessagesWatcher();
  taskFlow.startSchedulerLoop();
};
