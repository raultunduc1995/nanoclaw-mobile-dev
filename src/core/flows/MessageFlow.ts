import { ContainerOutput } from '../../container-runner.js';
import { logger } from '../../logger.js';

import { RouterState, Message, RegisteredGroup } from '../repositories/index.js';
import { formatMessages } from '../utils/index.js';

export interface MessageFlow {
  enqueuePreviousSessionLostMessages: () => void;
  startMessagesWatcher: () => Promise<void>;
  processGroupMessages: (jid: string) => Promise<boolean>;
}

export interface MessageFlowDeps {
  saveRouterState: (state: RouterState) => void;
  getRouterState: () => RouterState | undefined;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getRegisteredGroupsJids: () => Set<string>;
  getMessagesSince: (jid: string, since: string) => Message[];
  getNewMessagesSince: (jid: Set<string>, since: string) => { messages: Message[]; newTimestamp: string };
  getFormattedMessagesFor: (messages: Message[]) => string;
  enqueueMessageCheck: (jid: string) => void;
  sendMessageToQueue: (jid: string, message: string) => boolean;
  setTypingForChannel: (jid: string) => void;
  runAgent: (group: RegisteredGroup, prompt: string, jid: string) => Promise<[ContainerOutput, boolean, boolean]>;
}

export const createMessageFlow = (deps: MessageFlowDeps): MessageFlow => {
  let isRunning = false;
  const previousState = deps.getRouterState();
  const state = {
    lastMessageTimestamp: previousState?.lastMessageTimestamp ?? '',
    lastAgentTimestamp: previousState?.lastAgentTimestamp ?? {},
  };

  const watchForIncomingMessages = () => {
    const registeredJids = deps.getRegisteredGroupsJids();
    if (registeredJids.size <= 0) {
      return;
    }

    const { messages, newTimestamp } = deps.getNewMessagesSince(registeredJids, state.lastMessageTimestamp);
    if (messages.length <= 0) {
      return;
    }

    state.lastMessageTimestamp = newTimestamp;

    const foundGroupsMessages = Map.groupBy(messages, (m) => m.chatJid);
    for (const [jid, groupMessages] of foundGroupsMessages) {
      const formattedMessages = deps.getFormattedMessagesFor(groupMessages);
      if (!deps.sendMessageToQueue(jid, formattedMessages)) {
        deps.enqueueMessageCheck(jid);
        continue;
      }
      state.lastAgentTimestamp[jid] = groupMessages.at(-1)!.timestamp;
      deps.setTypingForChannel(jid);
    }

    deps.saveRouterState(state);
  };

  const loop = async () => {
    try {
      watchForIncomingMessages();
    } catch (error) {
      logger.error({ error }, `Could not process incoming message...`);
    }
    setTimeout(loop, WATCHER_POLL_INTERVAL);
  };

  return {
    enqueuePreviousSessionLostMessages: () => {
      const registeredGroups = deps.getRegisteredGroups();
      for (const [jid, group] of Object.entries(registeredGroups)) {
        const pendingMessages = deps.getMessagesSince(jid, state.lastAgentTimestamp[jid] ?? '');
        if (pendingMessages.length <= 0) continue;

        logger.info({ group: group.name, pendingCount: pendingMessages.length }, 'Recovery: found unprocessed messages');
        deps.enqueueMessageCheck(jid);
      }
    },

    startMessagesWatcher: async () => {
      if (isRunning) {
        logger.warn(`Message watcher already running...`);
        return;
      }
      isRunning = true;
      logger.info(`Starting watching for incoming messages...`);

      loop();
    },

    processGroupMessages: async (jid) => {
      const group = deps.getRegisteredGroups()[jid];
      if (!group) return true;

      const missedMessages = deps.getMessagesSince(jid, state.lastAgentTimestamp[jid] ?? '');
      if (missedMessages.length <= 0) return true;

      const previousAgentTimestamp = state.lastAgentTimestamp[jid] ?? '';
      state.lastAgentTimestamp[jid] = missedMessages.at(-1)!.timestamp;
      deps.saveRouterState(state);

      const prompt = formatMessages(missedMessages);
      const [runContainerAgentOutput, hadError, outputSentToUser] = await deps.runAgent(group, prompt, jid);

      if (runContainerAgentOutput.status !== 'error' && !hadError) return true;
      if (outputSentToUser) {
        logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
        return true;
      }

      state.lastAgentTimestamp[jid] = previousAgentTimestamp;
      deps.saveRouterState(state);
      logger.warn({ group: group.name }, `Agent could not process the incoming messages...`);

      return false;
    },
  };
};

const WATCHER_POLL_INTERVAL = 2000; // 2 sec.
