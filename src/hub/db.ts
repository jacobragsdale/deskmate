/** The hub's database: opening it, its schema, and one function for each thing the hub asks of it. */

import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { deliveredSchema, personSchema, repoRefSchema, teamRepoSchema } from "../core/wire.ts";
import type { Delivered, Note, Person, Repo, RepoRef, TeamRepo } from "../core/wire.ts";

const SCHEMA_VERSION = 3;
const PAGE = 100; // Most notes one request gets when it does not ask for the newest few.
const CONSTRAINT = 19; // SQLite's code for a broken constraint: the low byte of the fuller code a failed statement reports.
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
const pubkeySchema = z.strictObject({ pubkey: z.string() }).optional();
const peopleSchema = z.array(personSchema);
const teamReposSchema = z.array(teamRepoSchema);
const membersSchema = z.array(z.strictObject({ user: z.string() }));
const channelsSchema = z.array(z.strictObject({ channel: z.string() }));
const pinSchema = repoRefSchema.optional();
const deliveredListSchema = z.array(deliveredSchema);

export class Database {
  private readonly db: DatabaseSync;

  /** Open the database at `path`, laying down the schema when the file is new. Throws when another version of Player Two made it. */
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: BUSY_WAIT * 1000 });
    const version = versionSchema.parse(this.db.prepare("PRAGMA user_version").get()).user_version;
    const { tables } = tablesSchema.parse(this.db.prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table'").get());
    if (tables > 0 && version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`${path} was made by another version of Player Two (schema ${String(version)}, this one uses ${String(SCHEMA_VERSION)}); start with an empty database`);
    }
    this.db.exec(`${SCHEMA}PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
  }

  public close(): void {
    this.db.close();
  }

  /** The key a name was registered with, or null when nobody has joined under it. */
  public pubkeyOf(name: string): string | null {
    return pubkeySchema.parse(this.db.prepare("SELECT pubkey FROM users WHERE name = ?").get(name))?.pubkey ?? null;
  }

  /** Register a name with its key. A name already taken keeps the key it has. */
  public addUser(name: string, pubkey: string): void {
    this.db.prepare("INSERT OR IGNORE INTO users (name, pubkey) VALUES (?, ?)").run(name, pubkey);
  }

  /** Record that someone was here at `ts`, Unix seconds. */
  public sawUser(name: string, ts: number): void {
    this.db.prepare("UPDATE users SET seen = ? WHERE name = ?").run(ts, name);
  }

  public users(): readonly Person[] {
    return peopleSchema.parse(this.db.prepare("SELECT name, pubkey, seen FROM users ORDER BY name").all());
  }

  /** Replace the repos one person has checked out, all of them or none. */
  public replaceRepos(user: string, repos: readonly Repo[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM repos WHERE user = ?").run(user);
      const insert = this.db.prepare("INSERT INTO repos (user, name, key, url, branch) VALUES (?, ?, ?, ?, ?)");
      for (const repo of repos) {
        insert.run(user, repo.name, repo.key, repo.url, repo.branch);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every repo anyone has checked out, with whose copy it is. */
  public repos(): readonly TeamRepo[] {
    return teamReposSchema.parse(this.db.prepare("SELECT name, key, url, branch, user FROM repos ORDER BY name, user").all());
  }

  /** Every channel with somebody in it. */
  public channels(): readonly string[] {
    return channelsSchema.parse(this.db.prepare("SELECT DISTINCT channel FROM members ORDER BY channel").all()).map((row) => row.channel);
  }

  /** Who is in a channel, by name. */
  public members(channel: string): readonly string[] {
    return membersSchema.parse(this.db.prepare("SELECT user FROM members WHERE channel = ? ORDER BY user").all(channel)).map((row) => row.user);
  }

  public addMember(channel: string, user: string): void {
    this.db.prepare("INSERT OR IGNORE INTO members (channel, user) VALUES (?, ?)").run(channel, user);
  }

  public removeMember(channel: string, user: string): void {
    this.db.prepare("DELETE FROM members WHERE channel = ? AND user = ?").run(channel, user);
  }

  /** The repo a channel is about, or null when none is pinned. */
  public pinOf(channel: string): RepoRef | null {
    return pinSchema.parse(this.db.prepare("SELECT name, key, url FROM pins WHERE channel = ?").get(channel)) ?? null;
  }

  public setPin(channel: string, repo: RepoRef): void {
    this.db.prepare("INSERT OR REPLACE INTO pins (channel, name, key, url) VALUES (?, ?, ?, ?)").run(channel, repo.name, repo.key, repo.url);
  }

  public removePin(channel: string): void {
    this.db.prepare("DELETE FROM pins WHERE channel = ?").run(channel);
  }

  /** Keep a note and return the id it was given. Null when this exact note is already kept: a signature is stored once, which is what stops a replay. */
  public addNote(note: Note): number | null {
    try {
      const added = this.db
        .prepare("INSERT INTO notes (sender, recipient, kind, body, ts, agent, re, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(note.sender, note.to, note.kind, note.body, note.ts, note.agent, note.re, note.sig);
      return Number(added.lastInsertRowid);
    } catch (error) {
      // Refused by the UNIQUE signature. Letting the insert fail, rather than asking it to ignore a duplicate, keeps the ids without gaps.
      if (error instanceof Error && "errcode" in error && typeof error.errcode === "number" && (error.errcode & 0xff) === CONSTRAINT) {
        return null;
      }
      throw error;
    }
  }

  /**
   * The notes `me` can see with an id above `after`, oldest first: sent to them, to a channel they are in, or (unless `mine` is false) by them.
   * With `tail` they are the newest that many; without, the first page. `status` false leaves out agent status reports.
   */
  public notes(me: string, after: number, tail: number | null, mine: boolean, status: boolean): readonly Delivered[] {
    const visible = "(recipient = :me OR recipient IN (SELECT channel FROM members WHERE user = :me) OR sender = :me) AND (:mine OR sender != :me) AND (:status OR kind = 'note')";
    const columns = 'id, sender, recipient AS "to", kind, body, ts, agent, re, sig';
    const query =
      tail === null
        ? `SELECT ${columns} FROM notes WHERE id > :after AND ${visible} ORDER BY id LIMIT :limit`
        : `SELECT * FROM (SELECT ${columns} FROM notes WHERE id > :after AND ${visible} ORDER BY id DESC LIMIT :limit) ORDER BY id`;
    const rows = this.db.prepare(query).all({ me, after, mine: mine ? 1 : 0, status: status ? 1 : 0, limit: tail ?? PAGE });
    return deliveredListSchema.parse(rows.map(({ id, ...note }) => ({ id, note })));
  }
}
