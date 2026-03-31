import type Database from 'better-sqlite3';

import { isValidGroupFolder } from '../../../group-folder.js';
import { logger } from '../../../logger.js';
import type { RegisteredGroup } from '../types.js';

interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
}

function toGroup(row: GroupRow): RegisteredGroup & { jid: string } {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    addedAt: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    isMain: row.is_main === 1,
  };
}

export interface GroupsLocalResource {
  get(jid: string): (RegisteredGroup & { jid: string }) | undefined;
  set(jid: string, group: RegisteredGroup): void;
  getAll(): Record<string, RegisteredGroup>;
}

export const createGroupsLocalResource = (
  db: Database.Database,
): GroupsLocalResource => ({
  get: (jid: string): (RegisteredGroup & { jid: string }) | undefined => {
    const row = db
      .prepare('SELECT * FROM registered_groups WHERE jid = ?')
      .get(jid) as GroupRow | undefined;
    if (!row) return undefined;
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      return undefined;
    }
    return toGroup(row);
  },

  set: (jid: string, group: RegisteredGroup) => {
    if (!isValidGroupFolder(group.folder)) {
      throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
    }
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jid,
      group.name,
      group.folder,
      'none', // TODO: delete trigger_pattern column + migrate DB
      group.addedAt,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      0, // TODO: delete requires_trigger column + migrate DB
      group.isMain ? 1 : 0,
    );
  },

  getAll: (): Record<string, RegisteredGroup> => {
    const rows = db
      .prepare('SELECT * FROM registered_groups')
      .all() as GroupRow[];
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      if (!isValidGroupFolder(row.folder)) {
        logger.warn(
          { jid: row.jid, folder: row.folder },
          'Skipping registered group with invalid folder',
        );
        continue;
      }
      result[row.jid] = {
        name: row.name,
        folder: row.folder,
        addedAt: row.added_at,
        containerConfig: row.container_config
          ? JSON.parse(row.container_config)
          : undefined,
        isMain: row.is_main === 1,
      };
    }
    return result;
  },
});
