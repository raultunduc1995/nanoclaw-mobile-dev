import { TelegramChannel, type TelegramChannelOpts } from './telegram/index.js';
import type { Channel } from './types.js';

export interface ChannelsRegistry {
  registerTelegramChannel: (opts: TelegramChannelOpts) => TelegramChannel;
  findChannel: (jid: string) => Channel | undefined;
  connectAll: () => Promise<void>;
  disconnectAll: () => Promise<void>;
}

const channelsRegistry = ((): ChannelsRegistry => {
  const channels = new Map<'telegram', Channel>();

  return {
    registerTelegramChannel: (opts) => {
      const channel = new TelegramChannel(opts);

      channels.set('telegram', channel);
      return channel;
    },

    findChannel: (jid) => {
      const telegramChannel = channels.get('telegram');
      if (!(telegramChannel && telegramChannel.ownsJid(jid))) {
        return undefined;
      }
      return telegramChannel;
    },

    connectAll: async () => {
      for (const [_, channel] of channels) {
        await channel.connect();
      }
    },

    disconnectAll: async () => {
      for (const [_, channel] of channels) {
        await channel.disconnect();
      }
    },
  };
})();

export default channelsRegistry;
