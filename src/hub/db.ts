/** The hub's database: opening it, its schema, and one function for each thing the hub asks of it. */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { deliveredNoteSchema, deliveredSchema, isChannel, personSchema, teamRepoSchema } from "../core/wire.ts";
import type { Delivered, DeliveredNote, Event, Note, Person, Repo, RepoRef, TeamRepo } from "../core/wire.ts";

const SCHEMA_VERSION = 5; // 3 was the notes alone, from the Python hub to 0.4.
const PAGE = 100; // Most notes one request gets when it does not ask for the newest few.
const CONSTRAINT = 19; // SQLite's code for a broken constraint: the low byte of the fuller code a failed statement reports.
const BUSY_WAIT = 5; // Seconds to wait for another program that holds the file, such as a backup, before giving up.
const FIRST_CHAIN = "0".repeat(64); // The chain value before the first event.

// What a caller, :me, can see: events to them, by them, to everyone, and to the channels they are in now. Every read of events goes through this one rule.
const VISIBLE = "(recipient = :me OR author = :me OR recipient = '*' OR recipient IN (SELECT channel FROM members WHERE user = :me))";
const EVENT_COLUMNS = 'seq, id, author, recipient AS "to", kind, content, ts, refs, nonce, sig';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (channel TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY (channel, user));
CREATE TABLE IF NOT EXISTS pins (channel TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, branch TEXT);
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
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    author TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    refs TEXT NOT NULL, -- A JSON array of the ids it refers to; event_refs indexes them.
    nonce TEXT NOT NULL,
    sig TEXT NOT NULL,
    chain TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_recipient ON events (recipient, seq);
CREATE INDEX IF NOT EXISTS events_by_author ON events (author, seq);
CREATE TABLE IF NOT EXISTS event_refs (ref TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (ref, seq));
`;

// A row is whatever the file holds, so each is parsed like anything else that comes from outside.
const versionSchema = z.strictObject({ user_version: z.int() });
const tablesSchema = z.strictObject({ tables: z.int() });
const pubkeySchema = z.strictObject({ pubkey: z.string() }).optional();
const peopleSchema = z.array(personSchema);
const teamReposSchema = z.array(teamRepoSchema);
const membersSchema = z.array(z.strictObject({ user: z.string() }));
const channelsSchema = z.array(z.strictObject({ channel: z.string() }));
const pinSchema = z.strictObject({ name: z.string(), key: z.string(), url: z.string(), branch: z.string().nullable() }).optional();
const deliveredListSchema = z.array(deliveredNoteSchema);
const foundSchema = z.strictObject({ found: z.literal(1) }).optional();
const eventRowsSchema = z.array(
  z
    .strictObject({ seq: z.int(), id: z.string(), author: z.string(), to: z.string(), kind: z.string(), content: z.string(), ts: z.int(), refs: z.string(), nonce: z.string(), sig: z.string() })
    .transform(({ seq, refs, ...event }) => ({ seq, event: { ...event, refs: parseJson(refs) } }))
    .pipe(deliveredSchema)
);

function parseJson(text: string): unknown {
  return JSON.parse(text);
}
const headSchema = z.strictObject({ seq: z.int(), chain: z.string() }).optional();

/** The chain value of an event: the sha256 of the one before it and the event's id, written one after the other in hex. Each depends on every event before it, so none can be changed or taken out without changing every value after it. */
function chainAfter(previous: string, id: string): string {
  return createHash("sha256")
    .update(previous + id)
    .digest("hex");
}

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

  /** Do all of `work` or, when it throws, none of it. */
  public transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const done = work();
      this.db.exec("COMMIT");
      return done;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Replace the repos one person has checked out, all of them or none. */
  public replaceRepos(user: string, repos: readonly Repo[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM repos WHERE user = ?").run(user);
      const insert = this.db.prepare("INSERT INTO repos (user, name, key, url, branch) VALUES (?, ?, ?, ?, ?)");
      for (const repo of repos) {
        insert.run(user, repo.name, repo.key, repo.url, repo.branch);
      }
    });
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

  /** The repo a channel is about and the branch it names, or nulls when none is pinned. */
  public pinOf(channel: string): { readonly repo: RepoRef | null; readonly branch: string | null } {
    const pin = pinSchema.parse(this.db.prepare("SELECT name, key, url, branch FROM pins WHERE channel = ?").get(channel));
    return pin === undefined ? { repo: null, branch: null } : { repo: { name: pin.name, key: pin.key, url: pin.url }, branch: pin.branch };
  }

  public setPin(channel: string, repo: RepoRef, branch: string | null): void {
    this.db.prepare("INSERT OR REPLACE INTO pins (channel, name, key, url, branch) VALUES (?, ?, ?, ?, ?)").run(channel, repo.name, repo.key, repo.url, branch);
  }

  public removePin(channel: string): void {
    this.db.prepare("DELETE FROM pins WHERE channel = ?").run(channel);
  }

  /** Whether an event with this id is already kept. */
  public hasEvent(id: string): boolean {
    return foundSchema.parse(this.db.prepare("SELECT 1 AS found FROM events WHERE id = ?").get(id)) !== undefined;
  }

  /** The newest event's seq and chain value; 0 and FIRST_CHAIN before there is one. */
  public head(): { readonly seq: number; readonly chain: string } {
    return headSchema.parse(this.db.prepare("SELECT seq, chain FROM events ORDER BY seq DESC LIMIT 1").get()) ?? { seq: 0, chain: FIRST_CHAIN };
  }

  /** Keep an event, chained to the one before it, with what it refers to indexed, and return its seq. Run it inside `transaction`, with whatever else the event changes. */
  public addEvent(event: Event): number {
    const added = this.db
      .prepare("INSERT INTO events (id, author, recipient, kind, content, ts, refs, nonce, sig, chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, event.author, event.to, event.kind, event.content, event.ts, JSON.stringify(event.refs), event.nonce, event.sig, chainAfter(this.head().chain, event.id));
    const seq = Number(added.lastInsertRowid);
    const refer = this.db.prepare("INSERT OR IGNORE INTO event_refs (ref, seq) VALUES (?, ?)"); // Ignored: an event that names one id twice refers to it once.
    for (const ref of event.refs) {
      refer.run(ref, seq);
    }
    return seq;
  }

  /** Everything `me` can see after `after`, oldest first, at most `limit` of it. */
  public eventsAfter(me: string, after: number, limit: number): readonly Delivered[] {
    return eventRowsSchema.parse(this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq > :after AND ${VISIBLE} ORDER BY seq LIMIT :limit`).all({ me, after, limit }));
  }

  /** One chat's events before `before`, newest first, at most `limit` of them: a channel's, or those between `me` and one other person, either way. */
  public chatEvents(me: string, chat: string, before: number, limit: number): readonly Delivered[] {
    const inChat = isChannel(chat) ? "recipient = :chat" : "((author = :me AND recipient = :chat) OR (author = :chat AND recipient = :me))";
    return eventRowsSchema.parse(
      this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq < :before AND ${inChat} AND ${VISIBLE} ORDER BY seq DESC LIMIT :limit`).all({ me, chat, before, limit })
    );
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
  public notes(me: string, after: number, tail: number | null, mine: boolean, status: boolean): readonly DeliveredNote[] {
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
