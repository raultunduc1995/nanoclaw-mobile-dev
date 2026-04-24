import { logger } from '../logger.js';
import { GroupQueue } from './group-queue.js';

import channelsRegistry, { type TelegramChannelOpts } from './channels/index.js';
import { initLocalDatabase } from './db/index.js';
import { createGroupsRepository, createTasksRepository, type GroupsRepository, type TasksRepository } from './repositories/index.js';
import { formatMessages } from './utils/index.js';
import { runBee } from '../bee/index.js';

let groupsRepo: GroupsRepository;
let tasksRepo: TasksRepository;
let groupQueue: GroupQueue;

const initRepos = () => {
  const localResource = initLocalDatabase();
  groupsRepo = createGroupsRepository(localResource.groups);
  tasksRepo = createTasksRepository(localResource.tasks);
};

// const initTaskFlow = () => {
//   taskFlow = createTaskFlow({
//     getAllScheduledTasks: () => tasksRepo.getAll(),
//     getAllRegisteredGroupsAsRecord: () => groupsRepo.getAllAsRecord(),
//     getDueTasks: () => tasksRepo.getDue(),
//     getTaskById: (id) => tasksRepo.getById(id),
//     updateTask: (task) => tasksRepo.update(task),
//     updateTaskAfterRun: (id, lastResult, nextRun) => tasksRepo.updateAfterRun(id, lastResult, nextRun),
//     enqueueTask: (jid, taskId, fn) => groupQueue.enqueueTask(jid, taskId, fn),
//     runTaskAgent: async (group, task) => {

//       let result: string | null = null;
//       let error: string | null = null;

//       try {
//         const output = await runAgent(
//           { prompt: task.prompt, groupFolder: task.groupFolder, chatJid: task.chatJid, isMain: group.isMain, isScheduledTask: true, script: task.script },
//           (proc, containerName) => groupQueue.registerProcess(task.chatJid, proc, containerName, task.groupFolder),
//           async (text) => {
//             result = text;
//             await (channelsRegistry.findChannel(task.chatJid)?.sendMessage(task.chatJid, text) ?? Promise.resolve());
//           },
//         );
//         if (output.status === 'error') error = output.error || 'Unknown error';
//         else if (output.result) result = output.result;
//       } catch (err) {
//         error = err instanceof Error ? err.message : String(err);
//       }

//       return { result, error };
//     },
//   });
// };

// const initIpcHandler = () => {
//   ipcHandler = createIpcHandler({
//     groupsDeps: {
//       getById: (jid) => groupsRepo.getByJid(jid),
//       register: (jid, group) => groupsRepo.register(jid, group),
//       getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
//     },
//     tasksDeps: {
//       save: (task) => {
//         tasksRepo.save(task);
//         taskFlow.onTasksChanged();
//       },
//       getById: (id) => tasksRepo.getById(id),
//       update: (task) => {
//         tasksRepo.update(task);
//         taskFlow.onTasksChanged();
//       },
//       delete: (id) => {
//         tasksRepo.delete(id);
//         taskFlow.onTasksChanged();
//       },
//     },
//     chatsDeps: {
//       getAvailableChatGroups: () => getAvailableChatGroups(),
//     },
//     channelRegistryDeps: {
//       sendMessageTo: (jid, message) => channelsRegistry.findChannel(jid)?.sendMessage(jid, message),
//     },
//     containerRunnerDeps: {
//       writeAvailableGroupsIn: ({ groupFolder, groups, isMain }) => agentFlow.writeAvailableGroupsIn(groupFolder, groups, isMain),
//     },
//   });
// };

const initMain = () => {
  initRepos();
  groupQueue = new GroupQueue({
    runAgent: (jid, group, prompt) => {
      // taskFlow.onTasksChangedFor(group);
      return runBee(
        { prompt, groupFolder: group.folder, chatJid: jid, isMain: group.isMain, sessionId: group.sessionId },
        async (output) => {
          if (output.sessionId.length > 0) {
            logger.debug({ jid, group, sessionId: output.sessionId }, 'Updating session ID for group');
            groupsRepo.updateSessionId(jid, output.sessionId);
          }
          const channel = channelsRegistry.findChannel(jid);
          if (channel) {
            await channel.sendMessage(jid, output.message);
          }
        },
        async (error) => {
          logger.error({ jid, group, error }, 'Error in agent execution');
          const channel = channelsRegistry.findChannel(jid);
          if (channel) {
            await channel.sendMessage(jid, error.message);
          }
        },
        () => {
          logger.warn({ jid, group }, 'Agent reported invalid session — clearing session ID');
          groupsRepo.updateSessionId(jid, '');
        },
      );

      // await runAgent(
      //   { prompt, groupFolder: group.folder, chatJid: jid, isMain: group.isMain, sessionId: group.sessionId },
      //   (proc, containerName) => {
      //     // groupQueue.registerProcess(jid, proc, containerName, group.folder);
      //   },
      //   async (agentOutput) => {
      //     if (agentOutput.sessionId.length > 0) {
      //       logger.debug({ jid, group, sessionId: agentOutput.sessionId }, 'Updating session ID for group');
      //       groupsRepo.updateSessionId(jid, agentOutput.sessionId);
      //     }
      //     const channel = channelsRegistry.findChannel(jid);
      //     if (channel) {
      //       await channel.sendMessage(jid, agentOutput.message);
      //       return;
      //     }
      //   },
      //   async (error) => {
      //       logger.error({ jid, group, error }, 'Error in agent execution');
      //       const channel = channelsRegistry.findChannel(jid);
      //       if (channel) {
      //         await channel.sendMessage(jid, error.message);
      //       }
      //   },
      //   () => {
      //     logger.warn({ jid, group }, 'Agent reported invalid session — clearing session ID');
      //     groupsRepo.updateSessionId(jid, '');
      //   },
      // );
    },
  });
  // initTaskFlow();
  // initIpcHandler();
};

const registerCleanupHandlers = () => {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    groupQueue.shutdown();
    await channelsRegistry.disconnectAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

const registerChannels = async () => {
  const telegramOps: TelegramChannelOpts = {
    type: 'telegram',
    onInboundMessage: (message, group) => {
      const prompt = formatMessages([message]);
      channelsRegistry.findChannel(message.chatJid)?.setTyping(message.chatJid);
      groupQueue.deliver(message.chatJid, group, prompt);
    },
    getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
    registerNewGroup: (jid, group) => groupsRepo.register(jid, group),
  };

  channelsRegistry.registerTelegramChannel(telegramOps);
  await channelsRegistry.connectAll();
};

export const main = async () => {
  initMain();

  registerCleanupHandlers();
  await registerChannels();

  // ipcHandler.start();
  // taskFlow.startSchedulerLoop();
};
