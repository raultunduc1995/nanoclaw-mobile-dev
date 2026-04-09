import { logger } from '../logger.js';
import { IDLE_TIMEOUT } from '../config.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from '../container-runtime.js';
import { GroupQueue } from '../group-queue.js';
import { runContainerAgent } from '../container-runner.js';

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
let groupQueue: GroupQueue; // TODO: Check the groupqueue implementation

const initRepos = () => {
  const localResource = initLocalDatabase();
  groupsRepo = createGroupsRepository(localResource.groups);
  chatsRepo = createChatsRepository(localResource.chats);
  messagesRepo = createMessagesRepository(localResource.messages);
  routerStateRepo = createRouterStateRepository(localResource.routerState);
  tasksRepo = createTasksRepository(localResource.tasks);
};

const initTaskFlow = () => {
  taskFlow = createTaskFlow({
    getAllScheduledTasks: () => tasksRepo.getAll(),
    getAllRegisteredGroupsAsRecord: () => groupsRepo.getAllAsRecord(),
  });
};

const initAgentFlow = () => {
  agentFlow = createAgentFlow();
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
    enqueueMessageCheck: (jid) => groupQueue.enqueueMessageCheck(jid), // TODO: Check the groupqueue implementation
    sendMessageToQueue: (jid, message) => groupQueue.sendMessage(jid, message), // TODO: Check the groupqueue implementation
    setTypingForChannel: (jid) => channelsRegistry.findChannel(jid)?.setTyping(jid),
    // TODO: REFACTOR IMMEDIATELY
    runAgent: async (group, prompt, jid) => {
      channelsRegistry.findChannel(jid)?.setTyping(jid);

      // Track idle timer for closing stdin when agent is idle
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
          groupQueue.closeStdin(jid);
        }, IDLE_TIMEOUT);
      };

      taskFlow.onTasksChangedFor(group);
      agentFlow.writeAvailableGroupsIn(group.folder, getAvailableChatGroups(), group.isMain);
      let hadError = false;
      let outputSentToUser = false;
      // Run container agent...
      const runContainerAgentOutput = await runContainerAgent(
        {
          name: group.name,
          folder: group.folder,
          trigger: '',
          added_at: group.addedAt,
        },
        {
          prompt: prompt,
          groupFolder: group.folder,
          chatJid: jid,
          isMain: group.isMain,
        },
        (childProcess, containerName) => groupQueue.registerProcess(jid, childProcess, containerName, group.folder),
        async (containerOutput) => {
          // Streaming output callback — called for each agent result
          if (containerOutput.result) {
            const raw = typeof containerOutput.result === 'string' ? containerOutput.result : JSON.stringify(containerOutput.result);
            // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
            const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
            if (text) {
              await (channelsRegistry.findChannel(jid)?.sendMessage(jid, text) ?? Promise.resolve());
              outputSentToUser = true;
            }
            // Only reset idle timer on actual results, not session-update markers (result: null)
            resetIdleTimer();
          }

          if (containerOutput.status === 'success') {
            groupQueue.notifyIdle(jid);
          }

          if (containerOutput.status === 'error') {
            hadError = true;
          }
        },
      );

      if (idleTimer) clearTimeout(idleTimer);

      return [runContainerAgentOutput, hadError, outputSentToUser];
    },
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
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  initRepos();
  groupQueue = new GroupQueue();
  initTaskFlow();
  initAgentFlow();
  initMessageFlow();
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
  groupQueue.setProcessMessagesFn(messageFlow.processGroupMessages);
  messageFlow.enqueuePreviousSessionLostMessages();
  messageFlow.startMessagesWatcher();
};
