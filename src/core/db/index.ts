export type { LocalResource } from './connection.js';
export { initLocalDatabase, initTestDatabase } from './connection.js';

export type { ChatsLocalResource, ChatRow } from './resources/chats.js';
export type { MessagesLocalResource, MessageRow } from './resources/messages.js';
export type { TasksLocalResource, TaskRow, TaskRunLogRow } from './resources/tasks.js';
export type { RouterStateLocalResource, RouterStateRow } from './resources/router-state.js';
export type { GroupsLocalResource, GroupRow } from './resources/groups.js';
