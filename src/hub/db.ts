/** The hub's database: opening it, its schema, and one function for each thing the hub asks of it. The schema is the one src/deskmate/hub.py made, so either hub can open the other's file. */

import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

const SCHEMA_VERSION = 3;
const BUSY_WAIT = 5; // Seconds to wait for another program that holds the file, such as a backup, before giving up.

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (channel TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY (channel, user));
CREATE TABLE IF NOT EXISTS pins (channel TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (user TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, branch TEXT NOT NULL, PRIMARY KEY (user, name));
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    ts INTEGER NOT NULL,
    agent TEXT,
    re INTEGER,
    sig TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS notes_by_recipient ON notes (recipient, id);
CREATE INDEX IF NOT EXISTS notes_by_sender ON notes (sender, id);
`;

// A row is whatever the file holds, so each is parsed like anything else that comes from outside.
const versionSchema = z.strictObject({ user_version: z.int() });
const tablesSchema = z.strictObject({ tables: z.int() });

export class Database {
  private readonly db: DatabaseSync;

  /** Open the database at `path`, laying down the schema when the file is new. Throws when another version of deskmate made it. */
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: BUSY_WAIT * 1000 });
    const version = versionSchema.parse(this.db.prepare("PRAGMA user_version").get()).user_version;
    const { tables } = tablesSchema.parse(this.db.prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table'").get());
    if (tables > 0 && version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`${path} was made by another version of deskmate (schema ${String(version)}, this one uses ${String(SCHEMA_VERSION)}); start with an empty database`);
    }
    this.db.exec(`${SCHEMA}PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
  }

  public close(): void {
    this.db.close();
  }
}
