import { Message, RegisteredGroup } from '../repositories/index.js';

export interface ChannelOpts {
  type: 'telegram';
  /**
   * Callback type that channels use to deliver inbound messages
   *
   * @param message
   */
  onInboundMessage: (message: Message) => void;

  /**
   * Callback for delivering discovered chat metadata (e.g. JID, name) to the core. Called during initial sync and when new chats are detected.
   *
   * @param chatJid
   * @param timestamp
   * @param name is optional — channels that deliver names inline (Telegram) pass it here; channels that sync names separately (via syncGroups) omit it.
   * @param channel
   * @param isGroup
   */
  onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) => void;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  resolveGroupFolderPath: (folder: string) => string;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping(jid: string, isTyping: boolean): Promise<void>;
}
