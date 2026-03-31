import type Database from 'better-sqlite3';

import type { Message } from '../types.js';

interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    sender: row.sender,
    senderName: row.sender_name,
    content: row.content,
    timestamp: row.timestamp,
    isFromMe: row.is_from_me === 1,
    isBotMessage: row.is_bot_message === 1,
  };
}

export interface MessagesLocalResource {
  store(msg: Message): void;
  getNew(
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
    limit?: number,
  ): { messages: Message[]; newTimestamp: string };
  getSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    limit?: number,
  ): Message[];
  getLastBotTimestamp(chatJid: string, botPrefix: string): string | undefined;
}

export const createMessagesLocalResource = (
  db: Database.Database,
): MessagesLocalResource => ({
  store: (msg: Message) => {
    db.prepare(
      `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      msg.id,
      msg.chatJid,
      msg.sender,
      msg.senderName,
      msg.content,
      msg.timestamp,
      msg.isFromMe ? 1 : 0,
      msg.isBotMessage ? 1 : 0,
    );
  },

  getNew: (
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
    limit: number = 200,
  ): { messages: Message[]; newTimestamp: string } => {
    if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

    const placeholders = jids.map(() => '?').join(',');
    const sql = `
        SELECT * FROM (
          SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
          FROM messages
          WHERE timestamp > ? AND chat_jid IN (${placeholders})
            AND is_bot_message = 0 AND content NOT LIKE ?
            AND content != '' AND content IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        ) ORDER BY timestamp
      `;

    const rows = db
      .prepare(sql)
      .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as MessageRow[];

    let newTimestamp = lastTimestamp;
    for (const row of rows) {
      if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    }

    return { messages: rows.map(toMessage), newTimestamp };
  },

  getSince: (
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    limit: number = 200,
  ): Message[] => {
    const sql = `
        SELECT * FROM (
          SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
          FROM messages
          WHERE chat_jid = ? AND timestamp > ?
            AND is_bot_message = 0 AND content NOT LIKE ?
            AND content != '' AND content IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        ) ORDER BY timestamp
      `;
    const rows = db
      .prepare(sql)
      .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as MessageRow[];
    return rows.map(toMessage);
  },

  getLastBotTimestamp: (
    chatJid: string,
    botPrefix: string,
  ): string | undefined => {
    const row = db
      .prepare(
        `SELECT MAX(timestamp) as ts FROM messages
           WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
      )
      .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
    return row?.ts ?? undefined;
  },
});
