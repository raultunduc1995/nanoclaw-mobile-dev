import { describe, it, expect, beforeEach } from 'vitest';

import { initTestDatabase } from './connection.js';
import type { LocalResource } from './connection.js';
import type { Message } from './types.js';

let db: LocalResource;

beforeEach(() => {
  db = initTestDatabase();
});

function storeMsg(overrides: Partial<Message> & { id: string; chatJid: string; content: string; timestamp: string }): void {
  db.messages.store({
    sender: 'tg:user',
    senderName: 'User',
    isFromMe: false,
    isBotMessage: false,
    ...overrides,
  });
}

// --- Messages ---

describe('messages', () => {
  it('stores and retrieves a message', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');

    storeMsg({
      id: 'msg-1',
      chatJid: 'tg:group_test',
      sender: 'tg:123',
      senderName: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = db.messages.getSince('tg:group_test', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('tg:123');
    expect(messages[0].senderName).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');

    storeMsg({
      id: 'msg-2',
      chatJid: 'tg:group_test',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = db.messages.getSince('tg:group_test', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(messages).toHaveLength(0);
  });

  it('stores isFromMe flag', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');

    storeMsg({
      id: 'msg-3',
      chatJid: 'tg:group_test',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      isFromMe: true,
    });

    const messages = db.messages.getSince('tg:group_test', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chatJid', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');

    storeMsg({
      id: 'msg-dup',
      chatJid: 'tg:group_test',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    storeMsg({
      id: 'msg-dup',
      chatJid: 'tg:group_test',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = db.messages.getSince('tg:group_test', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getSince ---

describe('getSince', () => {
  beforeEach(() => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');

    storeMsg({
      id: 'm1',
      chatJid: 'tg:group_test',
      sender: 'tg:alice',
      senderName: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeMsg({
      id: 'm2',
      chatJid: 'tg:group_test',
      sender: 'tg:bob',
      senderName: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    db.messages.store({
      id: 'm3',
      chatJid: 'tg:group_test',
      sender: 'tg:bot',
      senderName: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      isFromMe: false,
      isBotMessage: true,
    });
    storeMsg({
      id: 'm4',
      chatJid: 'tg:group_test',
      sender: 'tg:carol',
      senderName: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = db.messages.getSince('tg:group_test', '2024-01-01T00:00:02.000Z', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages', () => {
    const msgs = db.messages.getSince('tg:group_test', '2024-01-01T00:00:00.000Z', 'Andy');
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = db.messages.getSince('tg:group_test', '', 'Andy');
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply', () => {
    for (let i = 1; i <= 50; i++) {
      storeMsg({
        id: `history-${i}`,
        chatJid: 'tg:group_test',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    storeMsg({
      id: 'new-1',
      chatJid: 'tg:group_test',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    const recovered = db.messages.getLastBotTimestamp('tg:group_test', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    const msgs = db.messages.getSince('tg:group_test', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit', () => {
    for (let i = 1; i <= 30; i++) {
      storeMsg({
        id: `pending-${i}`,
        chatJid: 'tg:group_test',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = db.messages.getLastBotTimestamp('tg:group_test', 'Andy');
    const msgs = db.messages.getSince('tg:group_test', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('filters pre-migration bot messages via content prefix', () => {
    storeMsg({
      id: 'm5',
      chatJid: 'tg:group_test',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = db.messages.getSince('tg:group_test', '2024-01-01T00:00:04.000Z', 'Andy');
    expect(msgs).toHaveLength(0);
  });
});

// --- getNew ---

describe('getNew', () => {
  beforeEach(() => {
    db.chats.storeMetadata('tg:group_one', '2024-01-01T00:00:00.000Z');
    db.chats.storeMetadata('tg:group_two', '2024-01-01T00:00:00.000Z');

    storeMsg({
      id: 'a1',
      chatJid: 'tg:group_one',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeMsg({
      id: 'a2',
      chatJid: 'tg:group_two',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    db.messages.store({
      id: 'a3',
      chatJid: 'tg:group_one',
      sender: 'tg:user',
      senderName: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      isFromMe: false,
      isBotMessage: true,
    });
    storeMsg({
      id: 'a4',
      chatJid: 'tg:group_one',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = db.messages.getNew(['tg:group_one', 'tg:group_two'], '2024-01-01T00:00:00.000Z', 'Andy');
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = db.messages.getNew(['tg:group_one', 'tg:group_two'], '2024-01-01T00:00:02.000Z', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no groups', () => {
    const { messages, newTimestamp } = db.messages.getNew([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- Chats ---

describe('chats', () => {
  it('stores chat with JID as default name', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');
    const chats = db.chats.getAll();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('tg:group_test');
    expect(chats[0].name).toBe('tg:group_test');
  });

  it('stores chat with explicit name', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = db.chats.getAll();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = db.chats.getAll();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:05.000Z');
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:01.000Z');
    const chats = db.chats.getAll();
    expect(chats[0].lastMessageTime).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Tasks ---

describe('tasks', () => {
  it('creates and retrieves a task', () => {
    db.tasks.create({
      id: 'task-1',
      groupFolder: 'main',
      chatJid: 'tg:group_test',
      prompt: 'do something',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2024-06-01T00:00:00.000Z',
      contextMode: 'isolated',
      nextRun: '2024-06-01T00:00:00.000Z',
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    const task = db.tasks.getById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    db.tasks.create({
      id: 'task-2',
      groupFolder: 'main',
      chatJid: 'tg:group_test',
      prompt: 'test',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2024-06-01T00:00:00.000Z',
      contextMode: 'isolated',
      nextRun: null,
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    db.tasks.update('task-2', { status: 'paused' });
    expect(db.tasks.getById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    db.tasks.create({
      id: 'task-3',
      groupFolder: 'main',
      chatJid: 'tg:group_test',
      prompt: 'delete me',
      script: null,
      scheduleType: 'once',
      scheduleValue: '2024-06-01T00:00:00.000Z',
      contextMode: 'isolated',
      nextRun: null,
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    db.tasks.delete('task-3');
    expect(db.tasks.getById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    db.chats.storeMetadata('tg:group_test', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      storeMsg({
        id: `lim-${i}`,
        chatJid: 'tg:group_test',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNew caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = db.messages.getNew(['tg:group_test'], '2024-01-01T00:00:00.000Z', 'Andy', 3);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getSince caps to limit and returns most recent in chronological order', () => {
    const messages = db.messages.getSince('tg:group_test', '2024-01-01T00:00:00.000Z', 'Andy', 3);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = db.messages.getNew(['tg:group_test'], '2024-01-01T00:00:00.000Z', 'Andy', 50);
    expect(messages).toHaveLength(10);
  });
});

// --- Registered groups ---

describe('registered groups', () => {
  it('persists isMain=true through set/get round-trip', () => {
    db.groups.set('tg:main', {
      name: 'Main Chat',
      folder: 'telegram_main',
      addedAt: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = db.groups.getAll();
    const group = groups['tg:main'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('telegram_main');
  });

  it('defaults isMain to false for non-main groups', () => {
    db.groups.set('tg:group_test', {
      name: 'Family Chat',
      folder: 'telegram_family-chat',
      addedAt: '2024-01-01T00:00:00.000Z',
      isMain: false,
    });

    const groups = db.groups.getAll();
    const group = groups['tg:group_test'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(false);
  });
});

// --- Router state ---

describe('router state', () => {
  it('sets and gets a value', () => {
    db.routerState.set('test_key', 'test_value');
    expect(db.routerState.get('test_key')).toBe('test_value');
  });

  it('returns undefined for missing key', () => {
    expect(db.routerState.get('nonexistent')).toBeUndefined();
  });

  it('overwrites on duplicate key', () => {
    db.routerState.set('key', 'first');
    db.routerState.set('key', 'second');
    expect(db.routerState.get('key')).toBe('second');
  });
});
