import { Message, RegisteredGroup } from '../repositories/index.js';
import { formatMessages } from '../utils/index.js';
import { logger } from '../../logger.js';

export interface MessageFlow {
  enqueuePreviousSessionLostMessages: () => void;
}

export interface MessageFlowDeps {
  getLastAgentTimestamps: () => Record<string, string>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getMessagesSince: (jid: string, since: string) => Message[];
  deliver: (jid: string, groupFolder: string, prompt: string) => boolean;
}

export const createMessageFlow = (deps: MessageFlowDeps): MessageFlow => {
  return {
    enqueuePreviousSessionLostMessages: () => {
      const lastAgentTimestamp = deps.getLastAgentTimestamps();
      const registeredGroups = deps.getRegisteredGroups();
      for (const [jid, group] of Object.entries(registeredGroups)) {
        const pendingMessages = deps.getMessagesSince(jid, lastAgentTimestamp[jid] ?? '');
        if (pendingMessages.length <= 0) continue;

        logger.info({ group: group.name, pendingCount: pendingMessages.length }, 'Recovery: found unprocessed messages');
        deps.deliver(jid, group.folder, formatMessages(pendingMessages));
      }
    },
  };
};
