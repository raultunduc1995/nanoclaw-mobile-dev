import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ENABLE_TELEGRAM', 'ENABLE_MAC_CONTROL', 'MAX_MESSAGES_PER_PROMPT', 'TZ']);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
// Feature flags - defaults to false if not set
export const ENABLE_TELEGRAM = (process.env.ENABLE_TELEGRAM || envConfig.ENABLE_TELEGRAM) === 'true';
export const ENABLE_MAC_CONTROL = (process.env.ENABLE_MAC_CONTROL || envConfig.ENABLE_MAC_CONTROL) === 'true';

export const SCHEDULER_POLL_INTERVAL = 60000;

const PROJECT_ROOT = process.cwd();

export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || envConfig.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '10800000', 10); // 3h default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

// Utility function to validate timezone strings. This is used to ensure that the TZ environment variable is set to a valid timezone, which is important for correct time handling in scheduled tasks and message formatting.
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
// Timezone for scheduled tasks, message formatting, etc.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
