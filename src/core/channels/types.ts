import { RegisteredGroup } from '../repositories/index.js';

export interface Message {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  replyToMessageId?: string;
  replyToMessageContent?: string;
  replyToSenderName?: string;
}

export interface ChannelOpts {
  type: 'telegram';
  /**
   * Callback type that channels use to deliver inbound messages
   *
   * @param message
   */
  onInboundMessage: (message: Message, group: RegisteredGroup) => void;

  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  registerNewGroup: (jid: string, group: RegisteredGroup) => void;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping(jid: string): Promise<void>;
}
