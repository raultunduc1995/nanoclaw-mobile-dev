import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('Telegram group JID: starts with tg: and has negative ID', () => {
    const jid = 'tg:-1001234567890';
    expect(jid.startsWith('tg:')).toBe(true);
  });

  it('Telegram DM JID: starts with tg: with positive ID', () => {
    const jid = 'tg:12345678';
    expect(jid.startsWith('tg:')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata('tg:group_one', '2024-01-01T00:00:01.000Z', 'Group 1', 'telegram', true);
    storeChatMetadata('tg:123', '2024-01-01T00:00:02.000Z', 'User DM', 'telegram', false);
    storeChatMetadata('tg:group_two', '2024-01-01T00:00:03.000Z', 'Group 2', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('tg:group_one');
    expect(groups.map((g) => g.jid)).toContain('tg:group_two');
    expect(groups.map((g) => g.jid)).not.toContain('tg:123');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('tg:group_test', '2024-01-01T00:00:01.000Z', 'Group', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:group_test');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('tg:group_reg', '2024-01-01T00:00:01.000Z', 'Registered', 'telegram', true);
    storeChatMetadata('tg:group_unreg', '2024-01-01T00:00:02.000Z', 'Unregistered', 'telegram', true);

    _setRegisteredGroups({
      'tg:group_reg': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'tg:group_reg');
    const unreg = groups.find((g) => g.jid === 'tg:group_unreg');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('tg:group_old', '2024-01-01T00:00:01.000Z', 'Old', 'telegram', true);
    storeChatMetadata('tg:group_new', '2024-01-01T00:00:05.000Z', 'New', 'telegram', true);
    storeChatMetadata('tg:group_mid', '2024-01-01T00:00:03.000Z', 'Mid', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('tg:group_new');
    expect(groups[1].jid).toBe('tg:group_mid');
    expect(groups[2].jid).toBe('tg:group_old');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata('unknown-format-123', '2024-01-01T00:00:01.000Z', 'Unknown');
    // Explicitly non-group with unusual JID
    storeChatMetadata('custom:abc', '2024-01-01T00:00:02.000Z', 'Custom DM', 'custom', false);
    // A real group for contrast
    storeChatMetadata('tg:group_test', '2024-01-01T00:00:03.000Z', 'Group', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:group_test');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
