import type { ChatsLocalResource, ChatRow } from '../db/index.js';

// --- Types and interfaces ---

export interface ChatInfo {
  jid: string;
  name: string;
  lastMessageTime: string;
  channel: string;
  isGroup: boolean;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

// --- Repository interface and implementation ---

export interface ChatsRepository {
  storeMetadata: (chatJid: string, metadata: { timestamp: string; name?: string; channel?: string; isGroup?: boolean }) => void;
  update: (chatInfo: ChatInfo) => void;
  getAll: () => ChatInfo[];
  getAvailableGroupChats: () => ChatInfo[];
}

export const createChatsRepository = (resource: ChatsLocalResource): ChatsRepository => {
  return {
    storeMetadata: (chatJid, metadata) => {
      if (metadata.name) {
        resource.storeNamedMetadata(chatJid, { timestamp: metadata.timestamp, name: metadata.name, channel: metadata.channel, isGroup: metadata.isGroup });
      } else {
        resource.storeMetadata(chatJid, { timestamp: metadata.timestamp, channel: metadata.channel, isGroup: metadata.isGroup });
      }
    },

    update: (chatInfo) => {
      resource.updateName(chatInfo.jid, chatInfo.name);
    },

    getAll: () => {
      return resource.getAll().map(toChatInfo);
    },

    getAvailableGroupChats: () =>
      resource
        .getAll()
        .filter((chat) => chat.is_group === 1)
        .map(toChatInfo),
  };
};

// --- Conversion function from ChatRow to ChatInfo ---

const toChatInfo = (row: ChatRow): ChatInfo => ({
  jid: row.jid,
  name: row.name,
  lastMessageTime: row.last_message_time,
  channel: row.channel,
  isGroup: row.is_group === 1,
});
