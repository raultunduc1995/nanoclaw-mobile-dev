import { logger } from '../../logger.js';
import { Message, RegisteredGroup } from '../repositories/index.js';
import { RouterState } from '../repositories/router-state-repository.js';
import { delay } from '../utils/index.js';

export interface MessageFlow {
  enqueuePreviousSessionLostMessages: () => void;
  startMessagesWatcher: () => Promise<void>;
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

  return {
    enqueuePreviousSessionLostMessages: () => {
      const registeredGroups = deps.getRegisteredGroups();
      for (const [jid, group] of Object.entries(registeredGroups)) {
        const agentTimestamp = state?.lastAgentTimestamp?.[jid] ?? '';
        const pendingMessages = deps.getMessagesSince(jid, agentTimestamp);
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

      while (true) {
        try {
          watchForIncomingMessages();
        } catch (error) {
          logger.error({ error }, `Could not process incoming message...`);
        }
        await delay(WATCHER_POLL_INTERVAL);
      }
    },
  };
};

const WATCHER_POLL_INTERVAL = 2000; // 2 sec.
