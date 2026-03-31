export type { LocalResource as LocalDatabase } from './connection.js';
export { initLocalDatabase, initTestDatabase, getLocalDatabase } from './connection.js';

export type { ChatsLocalResource } from './resources/chats.js';
export type { MessagesLocalResource } from './resources/messages.js';
export type { TasksLocalResource } from './resources/tasks.js';
export type { RouterStateLocalResource } from './resources/router-state.js';
export type { GroupsLocalResource } from './resources/groups.js';

export type {
  ChatInfo,
  Message,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  ContainerConfig,
  AdditionalMount,
} from './types.js';
