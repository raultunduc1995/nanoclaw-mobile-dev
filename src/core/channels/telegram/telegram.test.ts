import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('../registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../../../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock logger
vi.mock('../../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import { TelegramChannel, TelegramChannelOpts } from './telegram.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<TelegramChannelOpts>): TelegramChannelOpts {
  return {
    type: 'telegram',
    botToken: 'test-token',
    onInboundMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    getRegisteredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        addedAt: '2024-01-01T00:00:00.000Z',
        isMain: false,
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  reply_to_message?: any;
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      reply_to_message: overrides.reply_to_message,
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);

      await expect(channel.connect()).resolves.toBeUndefined();
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);

      await channel.connect();
      await expect(channel.disconnect()).resolves.toBeUndefined();
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith('tg:100200300', expect.any(String), 'Test Group', true);
      expect(opts.onInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '1',
          chatJid: 'tg:100200300',
          sender: '99001',
          senderName: 'Alice',
          content: 'Hello everyone',
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith('tg:999999', expect.any(String), 'Test Group', true);
      expect(opts.onInboundMessage).not.toHaveBeenCalled();
    });

    it('skips bot commands (/chatid) but passes other / messages through', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(ctx1);
      expect(opts.onInboundMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx2 = createTextCtx({ text: '/remote-control' });
      await triggerTextMessage(ctx2);
      expect(opts.onInboundMessage).toHaveBeenCalledTimes(1);
      expect(opts.onInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '/remote-control' }));
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ senderName: 'Bob' }));
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ senderName: 'alice_user' }));
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ senderName: '42' }));
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        getRegisteredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            addedAt: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
        })),
      });
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith('tg:100200300', expect.any(String), 'Project Team', true);
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('extracts reply_to fields when replying to a text message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Yes, on my way!',
        reply_to_message: {
          message_id: 42,
          text: 'Are you coming tonight?',
          from: { id: 777, first_name: 'Bob', username: 'bob_user' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Yes, on my way!',
          replyToMessageId: '42',
          replyToMessageContent: 'Are you coming tonight?',
          replyToSenderName: 'Bob',
        }),
      );
    });

    it('uses caption when reply has no text (media reply)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Nice photo!',
        reply_to_message: {
          message_id: 50,
          caption: 'Check this out',
          from: { id: 888, first_name: 'Carol' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          replyToMessageContent: 'Check this out',
        }),
      );
    });

    it('falls back to Unknown when reply sender has no from', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Interesting',
        reply_to_message: {
          message_id: 60,
          text: 'Channel post',
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          replyToMessageId: '60',
          replyToSenderName: 'Unknown',
        }),
      );
    });

    it('does not set reply fields when no reply_to_message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Just a normal message' });
      await triggerTextMessage(ctx);

      expect(opts.onInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          replyToMessageId: undefined,
          replyToMessageContent: undefined,
          replyToSenderName: undefined,
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith('100200300', 'Hello', { parse_mode: 'Markdown' });
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith('-1001234567890', 'Group message', { parse_mode: 'Markdown' });
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(1, '100200300', 'x'.repeat(4096), { parse_mode: 'Markdown' });
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(2, '100200300', 'x'.repeat(904), { parse_mode: 'Markdown' });
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(channel.sendMessage('tg:100200300', 'Will fail')).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel(createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own non-Telegram JIDs', () => {
      const channel = new TelegramChannel(createTestOpts());
      expect(channel.ownsJid('dc:12345')).toBe(false);
    });

    it('does not own non-Telegram DM JIDs', () => {
      const channel = new TelegramChannel(createTestOpts());
      expect(channel.ownsJid('dc:12345')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      await channel.setTyping('tg:100200300');

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith('100200300', 'typing');
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);

      // Don't connect
      await channel.setTyping('tg:100200300');

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(new Error('Rate limited'));

      await expect(channel.setTyping('tg:100200300')).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('tg:100200300'), expect.objectContaining({ parse_mode: 'Markdown' }));
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('private'), expect.any(Object));
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel(createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });
});
