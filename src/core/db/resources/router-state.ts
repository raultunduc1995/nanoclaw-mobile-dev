import type Database from 'better-sqlite3';

export interface RouterStateLocalResource {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export const createRouterStateLocalResource = (db: Database.Database): RouterStateLocalResource => ({
  get: (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM router_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  },

  set: (key: string, value: string) => {
    db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(key, value);
  },
});
