import { describe, it, expect, beforeEach } from 'vitest';

import { initTestDatabase } from '../connection.js';
import type { LocalResource } from '../connection.js';
import type { MessagesLocalResource, MessageRow } from './messages.js';

let db: LocalResource;
let messages: MessagesLocalResource;

beforeEach(() => {
  db = initTestDatabase();
  messages = db.messages;
});

const row = (overrides: Partial<MessageRow> & { id: string; chat_jid: string; content: string; timestamp: string }): MessageRow => ({
  sender: 'tg:user',
  sender_name: 'User',
  reply_to_message_id: null,
  reply_to_message_content: null,
  reply_to_sender_name: null,
  ...overrides,
});

describe('store', () => {
  it('stores and retrieves via getSince', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    messages.store(row({ id: 'm1', chat_jid: 'tg:grp', content: 'hello', timestamp: '2024-01-01T00:00:01.000Z' }));

    const result = messages.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m1');
    expect(result[0].content).toBe('hello');
    expect(result[0].chat_jid).toBe('tg:grp');
    expect(result[0].sender_name).toBe('User');
  });

  it('upserts on duplicate id', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    messages.store(row({ id: 'm1', chat_jid: 'tg:grp', content: 'original', timestamp: '2024-01-01T00:00:01.000Z' }));
    messages.store(row({ id: 'm1', chat_jid: 'tg:grp', content: 'updated', timestamp: '2024-01-01T00:00:01.000Z' }));

    const result = messages.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('updated');
  });

  it('stores reply_to fields', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    messages.store(
      row({
        id: 'm1',
        chat_jid: 'tg:grp',
        content: 'replying',
        timestamp: '2024-01-01T00:00:01.000Z',
        reply_to_message_id: '42',
        reply_to_message_content: 'original message',
        reply_to_sender_name: 'Bob',
      }),
    );

    const result = messages.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result[0].reply_to_message_id).toBe('42');
    expect(result[0].reply_to_message_content).toBe('original message');
    expect(result[0].reply_to_sender_name).toBe('Bob');
  });

  it('stores null reply_to fields', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    messages.store(row({ id: 'm1', chat_jid: 'tg:grp', content: 'no reply', timestamp: '2024-01-01T00:00:01.000Z' }));

    const result = messages.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result[0].reply_to_message_id).toBeNull();
    expect(result[0].reply_to_message_content).toBeNull();
    expect(result[0].reply_to_sender_name).toBeNull();
  });
});

describe('getSince', () => {
  beforeEach(() => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    messages.store(row({ id: 'm1', chat_jid: 'tg:grp', content: 'first', timestamp: '2024-01-01T00:00:01.000Z' }));
    messages.store(row({ id: 'm2', chat_jid: 'tg:grp', content: 'second', timestamp: '2024-01-01T00:00:02.000Z' }));
    messages.store(row({ id: 'm3', chat_jid: 'tg:grp', content: 'third', timestamp: '2024-01-01T00:00:03.000Z' }));
  });

  it('returns messages after given timestamp', () => {
    const result = messages.getSince('tg:grp', '2024-01-01T00:00:02.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('third');
  });

  it('returns all when timestamp is empty', () => {
    const result = messages.getSince('tg:grp', '');
    expect(result).toHaveLength(3);
  });

  it('excludes empty content', () => {
    messages.store(row({ id: 'empty', chat_jid: 'tg:grp', content: '', timestamp: '2024-01-01T00:00:04.000Z' }));
    const result = messages.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(3);
  });

  it('returns all messages in chronological order', () => {
    const result = messages.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('first');
    expect(result[2].content).toBe('third');
  });
});

describe('getNewSince', () => {
  beforeEach(() => {
    db.chats.upsert('tg:g1', { timestamp: '2024-01-01T00:00:00.000Z', name: 'G1', channel: 'telegram', isGroup: true });
    db.chats.upsert('tg:g2', { timestamp: '2024-01-01T00:00:00.000Z', name: 'G2', channel: 'telegram', isGroup: true });
    messages.store(row({ id: 'a1', chat_jid: 'tg:g1', content: 'g1 first', timestamp: '2024-01-01T00:00:01.000Z' }));
    messages.store(row({ id: 'a2', chat_jid: 'tg:g2', content: 'g2 first', timestamp: '2024-01-01T00:00:02.000Z' }));
    messages.store(row({ id: 'a3', chat_jid: 'tg:g1', content: 'g1 second', timestamp: '2024-01-01T00:00:03.000Z' }));
  });

  it('returns messages across multiple groups', () => {
    const result = messages.getNewSince(['tg:g1', 'tg:g2'], '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(3);
  });

  it('filters by timestamp', () => {
    const result = messages.getNewSince(['tg:g1', 'tg:g2'], '2024-01-01T00:00:02.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('g1 second');
  });

  it('returns empty for no groups', () => {
    const result = messages.getNewSince([], '');
    expect(result).toHaveLength(0);
  });

  it('returns all messages across groups', () => {
    const result = messages.getNewSince(['tg:g1', 'tg:g2'], '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(3);
  });
});
