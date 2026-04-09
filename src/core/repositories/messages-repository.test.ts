import { describe, it, expect, beforeEach } from 'vitest';

import { initTestDatabase } from '../db/connection.js';
import type { LocalResource } from '../db/connection.js';
import { createMessagesRepository, MessagesRepository, Message } from './messages-repository.js';

let db: LocalResource;
let repo: MessagesRepository;

beforeEach(() => {
  db = initTestDatabase();
  repo = createMessagesRepository(db.messages);
});

const msg = (overrides?: Partial<Message>): Message => ({
  id: 'msg-1',
  chatJid: 'tg:grp',
  sender: 'tg:user',
  senderName: 'User',
  content: 'hello',
  timestamp: '2024-01-01T00:00:01.000Z',
  ...overrides,
});

describe('saveMessage', () => {
  it('saves and retrieves via getMessagesSince', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    repo.save(msg());

    const result = repo.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('msg-1');
    expect(result[0].chatJid).toBe('tg:grp');
    expect(result[0].senderName).toBe('User');
    expect(result[0].content).toBe('hello');
  });

  it('persists reply_to fields through round-trip', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    repo.save(
      msg({
        replyToMessageId: '42',
        replyToMessageContent: 'Are you coming?',
        replyToSenderName: 'Bob',
      }),
    );

    const result = repo.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result[0].replyToMessageId).toBe('42');
    expect(result[0].replyToMessageContent).toBe('Are you coming?');
    expect(result[0].replyToSenderName).toBe('Bob');
  });

  it('returns undefined for reply fields when not set', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    repo.save(msg());

    const result = repo.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result[0].replyToMessageId).toBeUndefined();
    expect(result[0].replyToMessageContent).toBeUndefined();
    expect(result[0].replyToSenderName).toBeUndefined();
  });

  it('upserts on duplicate id', () => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    repo.save(msg({ content: 'original' }));
    repo.save(msg({ content: 'updated' }));

    const result = repo.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('updated');
  });
});

describe('getMessagesSince', () => {
  beforeEach(() => {
    db.chats.upsert('tg:grp', { timestamp: '2024-01-01T00:00:00.000Z', name: 'Test', channel: 'telegram', isGroup: true });
    repo.save(msg({ id: 'm1', content: 'first', timestamp: '2024-01-01T00:00:01.000Z' }));
    repo.save(msg({ id: 'm2', content: 'second', timestamp: '2024-01-01T00:00:02.000Z' }));
    repo.save(msg({ id: 'm3', content: 'third', timestamp: '2024-01-01T00:00:03.000Z' }));
  });

  it('returns messages after timestamp', () => {
    const result = repo.getSince('tg:grp', '2024-01-01T00:00:02.000Z');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('third');
  });

  it('returns all messages after timestamp', () => {
    const result = repo.getSince('tg:grp', '2024-01-01T00:00:00.000Z');
    expect(result).toHaveLength(3);
  });
});

describe('getNewSince', () => {
  beforeEach(() => {
    db.chats.upsert('tg:g1', { timestamp: '2024-01-01T00:00:00.000Z', name: 'G1', channel: 'telegram', isGroup: true });
    db.chats.upsert('tg:g2', { timestamp: '2024-01-01T00:00:00.000Z', name: 'G2', channel: 'telegram', isGroup: true });
    repo.save(msg({ id: 'a1', chatJid: 'tg:g1', content: 'g1 first', timestamp: '2024-01-01T00:00:01.000Z' }));
    repo.save(msg({ id: 'a2', chatJid: 'tg:g2', content: 'g2 first', timestamp: '2024-01-01T00:00:02.000Z' }));
    repo.save(msg({ id: 'a3', chatJid: 'tg:g1', content: 'g1 second', timestamp: '2024-01-01T00:00:03.000Z' }));
  });

  it('returns messages across groups with updated timestamp', () => {
    const { messages, newTimestamp } = repo.getNewSince(new Set(['tg:g1', 'tg:g2']), '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:03.000Z');
  });

  it('returns empty for no groups', () => {
    const { messages, newTimestamp } = repo.getNewSince(new Set([]), '');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });

  it('returns domain types with camelCase fields', () => {
    const { messages } = repo.getNewSince(new Set(['tg:g1']), '2024-01-01T00:00:00.000Z');
    expect(messages[0].chatJid).toBe('tg:g1');
    expect(messages[0].senderName).toBe('User');
  });
});
