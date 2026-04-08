import type Database from 'better-sqlite3';
import { MAX_MESSAGES_PER_PROMPT } from '../../../config.js';

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  reply_to_message_id: string | null;
  reply_to_message_content: string | null;
  reply_to_sender_name: string | null;
}

export interface MessagesLocalResource {
  store(msg: MessageRow): void;
  getNewSince(jids: string[], lastTimestamp: string): MessageRow[];
  getSince(chatJid: string, sinceTimestamp: string): MessageRow[];
}

export const createMessagesLocalResource = (db: Database.Database): MessagesLocalResource => ({
  store: (msg) => {
    db.prepare(
      `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    ).run(msg.id, msg.chat_jid, msg.sender, msg.sender_name, msg.content, msg.timestamp, msg.reply_to_message_id, msg.reply_to_message_content, msg.reply_to_sender_name);
  },

  getNewSince: (jids, lastTimestamp) => {
    const limit = 200;
    const placeholders = jids.map(() => '?').join(',');
    const sql = `
        SELECT * FROM (
          SELECT *
          FROM messages
          WHERE timestamp > ? AND chat_jid IN (${placeholders})
            AND content != '' AND content IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        ) ORDER BY timestamp
      `;

    return db.prepare(sql).all(lastTimestamp, ...jids, limit) as MessageRow[];
  },

  getSince: (chatJid, sinceTimestamp) => {
    const sql = `
        SELECT * FROM (
          SELECT *
          FROM messages
          WHERE chat_jid = ? AND timestamp > ?
            AND content != '' AND content IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        ) ORDER BY timestamp
      `;

    return db.prepare(sql).all(chatJid, sinceTimestamp, MAX_MESSAGES_PER_PROMPT) as MessageRow[];
  },
});
