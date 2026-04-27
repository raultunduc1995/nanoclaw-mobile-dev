import { logger } from './core/utils/logger.js';
import { GroupQueue } from './core/group-queue.js';

import channelsRegistry, { type TelegramChannelOpts } from './channels/index.js';
import { initLocalDatabase } from './core/db/index.js';
import { createGroupsRepository, type GroupsRepository } from './core/repositories/index.js';
import { formatMessages } from './core/utils/index.js';
import { runBee } from './bee/index.js';
import { startVoiceServer } from './voice/index.js';

let groupsRepo: GroupsRepository;
let groupQueue: GroupQueue;

const initRepos = () => {
  const localResource = initLocalDatabase();
  groupsRepo = createGroupsRepository(localResource.groups);
};

const initMain = () => {
  initRepos();
  groupQueue = new GroupQueue({
    runAgent: ({ jid, group, input }) => {
      const beeAgentInput =
        'imageBase64' in input && input.imageBase64 && input.imageMimeType
          ? { kind: 'image' as const, groupFolder: group.folder, chatJid: jid, isMain: group.isMain, sessionId: group.sessionId, ...input }
          : { kind: 'text' as const, groupFolder: group.folder, chatJid: jid, isMain: group.isMain, sessionId: group.sessionId, ...input };
      return runBee(
        beeAgentInput,
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
    },
  });
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
      if (message.kind === 'text') {
        groupQueue.deliver({ kind: 'text', jid: message.chatJid, group, prompt });
      } else if (message.kind === 'image') {
        groupQueue.deliver({
          kind: 'image',
          jid: message.chatJid,
          group,
          prompt,
          imageBase64: message.imageBase64,
          imageMimeType: message.imageMimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        });
      }
    },
    getRegisteredGroups: () => groupsRepo.getAllAsRecord(),
    registerNewGroup: (jid, group) => groupsRepo.register(jid, group),
  };

  channelsRegistry.registerTelegramChannel(telegramOps);
  await channelsRegistry.connectAll();
};

const startVoice = () => {
  const voiceJid = process.env.VOICE_JID;
  if (!voiceJid) {
    logger.debug('VOICE_JID not set — voice server disabled');
    return;
  }

  startVoiceServer((text) => {
    const group = groupsRepo.getByJid(voiceJid);
    if (!group) {
      logger.warn({ voiceJid }, 'Voice target group not found');
      return;
    }
    groupQueue.deliver({ kind: 'text', jid: voiceJid, group, prompt: text });
  });
};

export const main = async () => {
  initMain();
  registerCleanupHandlers();
  await registerChannels();
  startVoice();
};
