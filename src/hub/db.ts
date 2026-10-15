/** The hub's database: opening it, its schema, and one function for each thing the hub asks of it. */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { readContent } from "../core/kinds.ts";
import { eventId, eventIsAuthentic } from "../core/sign.ts";
import { problemOf } from "../core/text.ts";
import { deliveredSchema, HIT_CLOSE, HIT_OPEN, isAgent, isChannel, ownerOf, personSchema, teamRepoSchema } from "../core/wire.ts";
import type { Delivered, Event, Person, Repo, RepoRef, TeamRepo } from "../core/wire.ts";

const SCHEMA_VERSION = 7; // 3 was the notes alone, from the Python hub to 0.4.
// The versions a hub brings forward: 5, 0.5's events, lacks the search index, which is added and filled from the events; 6 lacks the agents table, which is added empty,
// since a hub of schema 6 refused every event to "*", the only agent.register it learns a key from.
const UPGRADABLE: ReadonlySet<number> = new Set([5, 6]);
const INDEXED_FROM = 6; // The first version with the search index.
const BUSY_WAIT = 5; // Seconds to wait for another program that holds the file, such as a backup, before giving up.
const FIRST_CHAIN = "0".repeat(64); // The chain value before the first event.

/** Whether the author is `person` or one of their agents, "person/repo". A name holds none of the characters GLOB reads as a pattern. */
function byPerson(person: string): string {
  return `(author = ${person} OR author GLOB ${person} || '/*')`;
}

// What a caller, :me, can see: events to them, by them or their agents, to everyone, and to the channels they are in now. Every read of events goes through this one rule.
const VISIBLE = `(recipient = :me OR ${byPerson(":me")} OR recipient = '*' OR recipient IN (SELECT channel FROM members WHERE user = :me))`;
const EVENT_COLUMNS = 'seq, id, author, recipient AS "to", kind, content, ts, refs, nonce, sig';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (channel TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY (channel, user));
CREATE TABLE IF NOT EXISTS pins (channel TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, branch TEXT);
CREATE TABLE IF NOT EXISTS repos (user TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, branch TEXT NOT NULL, PRIMARY KEY (user, name));
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
-- The words of each message and answer as last edited, under the event's seq as its rowid. It keeps its own copy of the text: snippet() reads nothing from a contentless table.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text);
-- The key each person's agent in each repo signs with, from their newest agent.register, at seq.
CREATE TABLE IF NOT EXISTS agents (owner TEXT NOT NULL, repo TEXT NOT NULL, pubkey TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (owner, repo));
`;
const INDEXED = "('message', 'job.result', 'message.edit', 'message.delete')"; // The kinds that change what the search index holds.

// A row is whatever the file holds, so each is parsed like anything else that comes from outside.
const versionSchema = z.strictObject({ user_version: z.int() });
const tablesSchema = z.strictObject({ tables: z.int() });
const pubkeySchema = z.strictObject({ pubkey: z.string() }).optional();
const peopleSchema = z.array(personSchema);
const teamReposSchema = z.array(teamRepoSchema);
const membersSchema = z.array(z.strictObject({ user: z.string() }));
const channelsSchema = z.array(z.strictObject({ channel: z.string() }));
const pinSchema = z.strictObject({ name: z.string(), key: z.string(), url: z.string(), branch: z.string().nullable() }).optional();
const foundSchema = z.strictObject({ found: z.literal(1) }).optional();
const seqSchema = z.strictObject({ seq: z.int() }).optional();
const eventRowSchema = z
  .strictObject({ seq: z.int(), id: z.string(), author: z.string(), to: z.string(), kind: z.string(), content: z.string(), ts: z.int(), refs: z.string(), nonce: z.string(), sig: z.string() })
  .transform(({ seq, refs, ...event }) => ({ seq, event: { ...event, refs: parseJson(refs) } }))
  .pipe(deliveredSchema);
const eventRowsSchema = z.array(eventRowSchema);
const linkSchema = z.object({ seq: z.int(), chain: z.string() });
const keysSchema = z.array(z.strictObject({ name: z.string(), pubkey: z.string() }));

/** JSON text as a value; undefined for text that is not JSON, which the schema it goes on to then refuses, as it refuses any other row it cannot read. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const hitRowSchema = z.object({ snippet: z.string() }); // Read beside the event's own columns, which eventRowSchema reads strictly.
const headSchema = z.strictObject({ seq: z.int(), chain: z.string() }).optional();

/** Which events are in one chat: a channel's, those to everyone when it is "*", or those between `:me` and one other person, either way, each of them or their agents. */
function inChat(chat: string): string {
  return isChannel(chat) || chat === "*" ? "recipient = :chat" : `((${byPerson(":me")} AND recipient = :chat) OR (${byPerson(":chat")} AND recipient = :me))`;
}

/** The text of a message or an answer as the index keeps it: without the characters that mark what a search found, so that every one in a snippet is a mark. */
function searchable(text: string): string {
  return text.replaceAll(HIT_OPEN, " ").replaceAll(HIT_CLOSE, " ");
}

/** The chain value of an event: the sha256 of the one before it and the event's id, written one after the other in hex. Each depends on every event before it, so none can be changed or taken out without changing every value after it. */
function chainAfter(previous: string, id: string): string {
  return createHash("sha256")
    .update(previous + id)
    .digest("hex");
}

/** One row of the log as the event it holds, given the chain value before it and the key each author signs with by then; or what is wrong with it. */
function eventIn(row: Record<string, unknown>, chain: string, previous: string, before: number, keys: ReadonlyMap<string, string>): Event | string {
  const stored = eventRowSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([column]) => column !== "chain")));
  if (!stored.success) {
    return `that row cannot be read as an event (${problemOf(stored.error)})`;
  }
  const { event } = stored.data;
  const id = eventId(event);
  if (id !== event.id || chain !== chainAfter(previous, id)) {
    return `that event, or its chain value, is not what was stored after the ${String(before)} before it`;
  }
  const pubkey = keys.get(event.author);
  if (pubkey === undefined) {
    return `its author, ${event.author}, has no key on this hub to check its signature against`; // The hub stores nobody's event before they have joined, or their agent's before they registered it, and never forgets a key.
  }
  if (!eventIsAuthentic(event, pubkey)) {
    return `its signature does not hold under the key ${isAgent(event.author) ? `${ownerOf(event.author)} last registered for it before then` : `${event.author} joined with`}`;
  }
  return event;
}

/**
 * Walk the event log in the database at `path`, without changing it, and say how far it holds: how many events there are and the newest chain value,
 * or the first seq that breaks it, and how. Each event's id is worked out again from its fields, its chain value from the one before, and its signature checked against the key its author joined with,
 * or for an agent, the key its owner's newest registration of it before then holds, read from the log as the hub read it then;
 * so a row changed by hand, its signature included, breaks the log at that row; a row taken out breaks it at the one after; and a row that cannot be read is named, not passed over.
 */
export function verifyChain(path: string): { readonly events: number; readonly head: string; readonly broken: { readonly seq: number; readonly why: string } | null } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const keys = new Map(keysSchema.parse(db.prepare("SELECT name, pubkey FROM users").all()).map((user) => [user.name, user.pubkey]));
    let previous = FIRST_CHAIN;
    let events = 0;
    for (const row of db.prepare(`SELECT ${EVENT_COLUMNS}, chain FROM events ORDER BY seq`).iterate()) {
      const { seq, chain } = linkSchema.parse(row);
      const event = eventIn(row, chain, previous, events, keys);
      if (typeof event === "string") {
        return { events, head: previous, broken: { seq, why: event } };
      }
      const said = readContent(event);
      if (said.kind === "agent.register" && event.to === "*" && !isAgent(event.author)) {
        keys.set(`${event.author}/${said.content.repo}`, said.content.pubkey); // As the hub learned it when it stored this.
      }
      previous = chain;
      events += 1;
    }
    return { events, head: previous, broken: null };
  } finally {
    db.close();
  }
}

export class Database {
  private readonly db: DatabaseSync;

  /** Open the database at `path`, laying down the schema when the file is new, and what an older schema lacks when 0.5 or phase 2 made it (see UPGRADABLE). Throws when any other version of Player Two made it. */
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: BUSY_WAIT * 1000 });
    const version = versionSchema.parse(this.db.prepare("PRAGMA user_version").get()).user_version;
    const { tables } = tablesSchema.parse(this.db.prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table'").get());
    if (tables > 0 && version !== SCHEMA_VERSION && !UPGRADABLE.has(version)) {
      this.db.close();
      throw new Error(`${path} was made by another version of Player Two (schema ${String(version)}, this one uses ${String(SCHEMA_VERSION)}); start with an empty database`);
    }
    this.db.exec(SCHEMA);
    if (version !== SCHEMA_VERSION) {
      // The index starts empty, and is filled in the same transaction that says the schema is this one's, so a hub stopped halfway fills it again from the start.
      this.transaction(() => {
        const rows = version < INDEXED_FROM ? this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE kind IN ${INDEXED} ORDER BY seq`).iterate() : [];
        for (const row of rows) {
          const stored = eventRowSchema.parse(row);
          this.index(stored.seq, stored.event);
        }
        this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
      });
    }
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

  /** The key `owner`'s agent in `repo` signs with, or null when they have never registered one. */
  public agentKeyOf(owner: string, repo: string): string | null {
    return pubkeySchema.parse(this.db.prepare("SELECT pubkey FROM agents WHERE owner = ? AND repo = ?").get(owner, repo))?.pubkey ?? null;
  }

  /** Set the key `owner`'s agent in `repo` signs with, as their agent.register at `seq` says, in place of any before it. */
  public setAgentKey(owner: string, repo: string, pubkey: string, seq: number): void {
    this.db.prepare("INSERT OR REPLACE INTO agents (owner, repo, pubkey, seq) VALUES (?, ?, ?, ?)").run(owner, repo, pubkey, seq);
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
    this.index(seq, event);
    return seq;
  }

  /**
   * Keep the search index as every reader's fold has it: the text of each message and answer, a message's replaced by its edit and taken out by its delete.
   * Those count only from the message's author, in the message's own chat, and on a message rather than an answer; an edit after a delete finds nothing to change. Content its kind does not hold is passed over.
   */
  private index(seq: number, event: Event): void {
    const said = readContent(event);
    if (said.kind === "message" || said.kind === "job.result") {
      this.db.prepare("INSERT INTO search (rowid, text) VALUES (?, ?)").run(seq, searchable(said.content.text));
    } else if (said.kind === "message.edit" || said.kind === "message.delete") {
      // The same author writing to the same recipient is the same chat: a channel, or the two people in a direct one.
      const target = seqSchema.parse(this.db.prepare("SELECT seq FROM events WHERE id = ? AND author = ? AND recipient = ? AND kind = 'message'").get(event.refs[0] ?? "", event.author, event.to));
      if (target !== undefined && said.kind === "message.edit") {
        this.db.prepare("UPDATE search SET text = ? WHERE rowid = ?").run(searchable(said.content.text), target.seq);
      } else if (target !== undefined) {
        this.db.prepare("DELETE FROM search WHERE rowid = ?").run(target.seq);
      }
    }
  }

  /** Everything `me` can see after `after`, oldest first, at most `limit` of it. */
  public eventsAfter(me: string, after: number, limit: number): readonly Delivered[] {
    return eventRowsSchema.parse(this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq > :after AND ${VISIBLE} ORDER BY seq LIMIT :limit`).all({ me, after, limit }));
  }

  /** One chat's events before `before`, newest first, at most `limit` of them: a channel's, or those between `me` and one other person, either way. */
  public chatEvents(me: string, chat: string, before: number, limit: number): readonly Delivered[] {
    return eventRowsSchema.parse(
      this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq < :before AND ${inChat(chat)} AND ${VISIBLE} ORDER BY seq DESC LIMIT :limit`).all({ me, chat, before, limit })
    );
  }

  /** One chat's events around `around`, oldest first: up to half of `limit` from before it, and the rest from it on, so that a page opened at one event shows what came either side of it. */
  public chatAround(me: string, chat: string, around: number, limit: number): readonly Delivered[] {
    const older = Math.floor(limit / 2);
    const these = `${inChat(chat)} AND ${VISIBLE}`;
    const before = `SELECT * FROM (SELECT ${EVENT_COLUMNS} FROM events WHERE seq < :around AND ${these} ORDER BY seq DESC LIMIT :older)`;
    const from = `SELECT * FROM (SELECT ${EVENT_COLUMNS} FROM events WHERE seq >= :around AND ${these} ORDER BY seq LIMIT :newer)`;
    return eventRowsSchema.parse(this.db.prepare(`${before} UNION ALL ${from} ORDER BY seq`).all({ me, chat, around, older, newer: limit - older }));
  }

  /** One event `me` can see, by its id; null when there is none, or none they can see, which the caller cannot tell apart. */
  public event(me: string, id: string): Delivered | null {
    const row = this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = :id AND ${VISIBLE}`).get({ me, id });
    return row === undefined ? null : eventRowSchema.parse(row);
  }

  /**
   * The messages and answers `me` can see that hold every one of `words`, in one chat or in any, best match first, at most `limit` of them; each with a stretch of its text, as last edited, the words found marked with HIT_OPEN and HIT_CLOSE.
   * Each word is quoted, so nothing typed is read as FTS5's own syntax: a word is matched as the tokens it holds, and one that holds none matches nothing. GET /search hands over words of one token each.
   * ponytail: FTS5 does the work of every word against every row that holds it, synchronously; GET /search allows a few words. Move searching off the hub's one thread if the log grows past what that takes.
   */
  public search(me: string, words: readonly string[], chat: string | null, limit: number): readonly (Delivered & { readonly snippet: string })[] {
    const terms = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" ");
    const where = chat === null ? "" : ` AND ${inChat(chat)}`;
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS}, snippet(search, 0, :open, :close, '…', 16) AS snippet FROM search JOIN events ON events.seq = search.rowid WHERE search MATCH :terms AND ${VISIBLE}${where} ORDER BY search.rank LIMIT :limit`
      )
      .all({ me, terms, limit, open: HIT_OPEN, close: HIT_CLOSE, ...(chat === null ? {} : { chat }) });
    return rows.map(({ snippet, ...event }) => ({ ...eventRowSchema.parse(event), ...hitRowSchema.parse({ snippet }) }));
  }
}
