import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../../config.js';
import { logger } from '../../logger.js';

import { createSchema } from './schema.js';
import { createTasksLocalResource } from './resources/tasks.js';
import { createGroupsLocalResource } from './resources/groups.js';

import type { TasksLocalResource } from './resources/tasks.js';
import type { GroupsLocalResource } from './resources/groups.js';

export interface LocalResource {
  tasks: TasksLocalResource;
  groups: GroupsLocalResource;
  close(): void;
}

function createLocalResource(db: Database.Database): LocalResource {
  createSchema(db);

  return {
    tasks: createTasksLocalResource(db),
    groups: createGroupsLocalResource(db),
    close: () => db.close(),
  };
}

let instance: LocalResource | null = null;

export function initLocalDatabase(): LocalResource {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  instance = createLocalResource(new Database(dbPath));
  logger.info(`Database was initialized successfuly`);
  return instance;
}

export function initTestDatabase(): LocalResource {
  instance = createLocalResource(new Database(':memory:'));
  return instance;
}
