import { TIMEZONE } from '../../config.js';
import { Message } from '../repositories/index.js';

export const formatMessages = (messages: Message[], timezone: string = TIMEZONE): string => {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.replyToMessageId ? ` reply_to="${escapeXml(m.replyToMessageId)}"` : '';
    const replySnippet =
      m.replyToMessageContent && m.replyToSenderName ? `\n  <quoted_message from="${escapeXml(m.replyToSenderName)}">${escapeXml(m.replyToMessageContent)}</quoted_message>` : '';
    return `<message sender="${escapeXml(m.senderName)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
};

const formatLocalTime = (utcIso: string, timezone: string): string => {
  const isValidTimezone = (tz: string): boolean => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone:  isValidTimezone(timezone) ? timezone : 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

const escapeXml = (s: string): string => {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};
