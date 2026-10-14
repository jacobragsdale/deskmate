/** The hub: keeps everyone's public key and channel memberships, relays signed notes, and keeps them for later reading. Ported from src/deskmate/hub.py route for route: the same paths, the same statuses, the same words. */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { z } from "zod";

import { isUnder, prefixKey, unquote } from "../core/remotes.ts";
import { authClaim, authIsValid, isFresh, noteIsAuthentic } from "../core/sign.ts";
import { isChannel, joinSchema, nameSchema, noteSchema, repoRefSchema, repoSchema } from "../core/wire.ts";
import type { ChannelInfo, RepoRef } from "../core/wire.ts";
import { Database } from "./db.ts";

const MAX_WAIT = 30; // Longest a client may hold one long-poll open, in seconds.
const HISTORY = 500; // Most notes one `tail` request may ask for.
const MAX_REPOS = 500; // Most checkouts one person may advertise.
const MAX_REQUEST = 4_000_000; // Most characters one request's body may hold: several times the longest list of repos or the longest note.

export interface HubSettings {
  readonly joinToken: string; // The shared secret that lets a teammate register a name.
  readonly db: string; // The file the hub keeps everything in.
  readonly repos: string; // The URL the team's repos live under; only those may be shared.
}

/** Something worth a line in the hub's log: what happened, and the facts of it. */
export type Log = (event: string, facts: Readonly<Record<string, string | number>>) => void;

const advertsSchema = z.array(repoSchema).max(MAX_REPOS);

// A query string holds only text, so numbers and yes-or-no arrive written out, the latter in any of the spellings the hub has always taken.
const numeric = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform(Number);
const flag = z.stringbool({ truthy: ["1", "on", "t", "true", "y", "yes"], falsy: ["0", "off", "f", "false", "n", "no"] });
const notesQuerySchema = z.object({
  after: numeric.pipe(z.int()).default(0),
  wait: numeric.pipe(z.number().max(MAX_WAIT)).default(0),
  tail: numeric.pipe(z.int().min(1).max(HISTORY)).optional(),
  mine: flag.default(true),
  status: flag.default(true)
});

/** One request as a route sees it. */
interface Ask {
  readonly me: string; // Who is asking, proved by their signature; "" on the routes open to anyone.
  readonly channel: string; // The channel the path names, with its "#"; "" on a route that names none.
  readonly query: URLSearchParams;
  readonly body: string; // What the request carried, not yet parsed.
  readonly response: ServerResponse; // Only for a long-poll to see that its reader has hung up.
}

type Answer = readonly [status: number, body: unknown];

interface Route {
  readonly method: string;
  readonly path: string; // With "{name}" where a channel's name goes.
  readonly open?: true; // Answered without asking who is calling.
  readonly answer: (ask: Ask) => Answer | Promise<Answer>;
}

/** A request the hub will not serve. The words are for whoever sent it. */
class Refusal extends Error {
  public readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

/** Parse one part of a request. A failure answers 422 and names the field that was wrong. */
function parsed<T>(schema: z.ZodType<T>, value: unknown, part: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new Refusal(422, `invalid ${issue === undefined || issue.path.length === 0 ? part : issue.path.join(".")}: ${issue?.message ?? "not what the hub expects"}`);
}

/** The JSON a request carried, as `schema` describes it. */
function jsonBody<T>(schema: z.ZodType<T>, text: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refusal(422, "invalid body: not JSON");
  }
  return parsed(schema, value, "body");
}

/** Read a request's body. One too long to be anything the hub accepts is cut off rather than held in memory. */
function bodyText(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.length > MAX_REQUEST) {
        request.destroy(); // No client of the hub sends this much, so there is nobody to explain it to.
        reject(new Refusal(413, "the request is too large"));
      }
    });
    request.on("end", () => {
      resolve(text);
    });
    request.on("error", reject);
  });
}

function sameSecret(given: string, expected: string): boolean {
  // Compared as hashes, so the time it takes says nothing about where they differ or how long the secret is.
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function send(response: ServerResponse, [status, body]: Answer): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) }).end(text);
}

/** Open the hub's database and return its server, not yet listening. `now` is the hub's clock in Unix seconds. Closing the server closes the database. */
export function createHub(settings: HubSettings, now: () => number = () => Date.now() / 1000, log: Log = () => undefined): Server {
  const prefix = prefixKey(settings.repos);
  const db = new Database(settings.db);
  const waiting = new Set<() => void>(); // Readers holding a request open for the next note; each is called when one arrives.

  /** Settles when a note arrives, when `ms` have passed, or when the reader hangs up, whichever is first. A waiting reader costs a timer, not a thread. */
  function arrival(ms: number, response: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        waiting.delete(wake);
        response.off("close", wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      waiting.add(wake);
      response.once("close", wake);
    });
  }

  function caller(header: string): string {
    const claim = authClaim(header);
    const pubkey = claim === null ? null : db.pubkeyOf(claim.name);
    if (claim === null || pubkey === null || !authIsValid(claim, pubkey, now())) {
      throw new Refusal(401, "not signed by a known user, or your clock is more than 5 minutes off");
    }
    db.sawUser(claim.name, Math.floor(now())); // Every signed request doubles as "I am here".
    return claim.name;
  }

  function channelInfo(channel: string): ChannelInfo {
    return { name: channel, members: db.members(channel), repo: db.pinOf(channel) };
  }

  function mustBeIn(channel: string, me: string): void {
    if (!db.members(channel).includes(me)) {
      throw new Refusal(403, `join ${channel} first`);
    }
  }

  function shareable(repo: RepoRef): void {
    if (!isUnder(repo.key, prefix)) {
      throw new Refusal(422, `${repo.name} is not under ${prefix}, so this hub does not share it`);
    }
  }

  function join(ask: Ask): Answer {
    const { name, pubkey, token } = jsonBody(joinSchema, ask.body);
    if (!sameSecret(token, settings.joinToken)) {
      throw new Refusal(403, "wrong join token");
    }
    db.addUser(name, pubkey);
    if (db.pubkeyOf(name) !== pubkey) {
      throw new Refusal(409, `the name '${name}' is taken by another key`);
    }
    log("user joined", { user: name });
    return [201, { name, pubkey }];
  }

  /** Replace the list of repos the caller has checked out. */
  function putRepos(ask: Ask): Answer {
    const mine = jsonBody(advertsSchema, ask.body);
    mine.forEach(shareable);
    if (new Set(mine.map((repo) => repo.name)).size !== mine.length) {
      throw new Refusal(422, "two repos share a name");
    }
    db.replaceRepos(ask.me, mine);
    return [200, mine];
  }

  function postNote(ask: Ask): Answer {
    const note = jsonBody(noteSchema, ask.body);
    const pubkey = db.pubkeyOf(note.sender);
    if (pubkey === null || !noteIsAuthentic(note, pubkey)) {
      throw new Refusal(401, "note is not signed by its sender");
    }
    if (!isFresh(note.ts, now())) {
      throw new Refusal(400, "note timestamp is more than 5 minutes off the hub clock; check your system time");
    }
    if (isChannel(note.to)) {
      if (!db.members(note.to).includes(note.sender)) {
        throw new Refusal(403, `join ${note.to} before posting to it`);
      }
    } else if (db.pubkeyOf(note.to) === null) {
      throw new Refusal(404, `nobody named '${note.to}' has joined`);
    }
    const id = db.addNote(note);
    if (id === null) {
      throw new Refusal(409, "this exact note was already delivered");
    }
    waiting.forEach((wake) => {
      wake();
    });
    log("note queued", { note_id: id, sender: note.sender, recipient: note.to, kind: note.kind });
    return [201, { id }];
  }

  /**
   * Notes the caller can see with an id above `after`, oldest first: sent to them, to a channel they are in, or (unless `mine` is false) sent by them.
   * `wait` holds the request open until one arrives; `tail` returns only the newest few; `status` false leaves out agent status reports.
   */
  async function getNotes(ask: Ask): Promise<Answer> {
    const { after, wait, tail, mine, status } = parsed(notesQuerySchema, Object.fromEntries(ask.query), "query");
    const deadline = performance.now() + wait * 1000;
    for (;;) {
      // Looking and going to sleep happen in one turn of the loop, so a note cannot land between "nothing yet" and waiting for it.
      const notes = db.notes(ask.me, after, tail ?? null, mine, status);
      const remaining = deadline - performance.now();
      if (notes.length > 0 || remaining <= 0) {
        return [200, notes];
      }
      await arrival(remaining, ask.response);
      if (ask.response.destroyed) {
        return [200, []]; // Nobody is listening, and the database may have closed with the server.
      }
    }
  }

  /** Join a channel, creating it if nobody is in it yet. */
  function joinChannel(ask: Ask): Answer {
    db.addMember(ask.channel, ask.me);
    log("channel joined", { channel: ask.channel, user: ask.me });
    return [200, channelInfo(ask.channel)];
  }

  function leaveChannel(ask: Ask): Answer {
    db.removeMember(ask.channel, ask.me);
    log("channel left", { channel: ask.channel, user: ask.me });
    return [200, channelInfo(ask.channel)];
  }

  /** Say which repo a channel is about. Any member may set or change it. */
  function pinRepo(ask: Ask): Answer {
    const repo = jsonBody(repoRefSchema, ask.body);
    mustBeIn(ask.channel, ask.me);
    shareable(repo);
    db.setPin(ask.channel, repo);
    return [200, channelInfo(ask.channel)];
  }

  function unpinRepo(ask: Ask): Answer {
    mustBeIn(ask.channel, ask.me);
    db.removePin(ask.channel);
    return [200, channelInfo(ask.channel)];
  }

  const routes: readonly Route[] = [
    { method: "GET", path: "/healthz", open: true, answer: () => [200, { ok: true }] },
    { method: "POST", path: "/join", open: true, answer: join },
    { method: "GET", path: "/info", answer: () => [200, { repos: prefix }] },
    { method: "GET", path: "/users", answer: () => [200, db.users()] },
    { method: "PUT", path: "/repos", answer: putRepos },
    { method: "GET", path: "/repos", answer: () => [200, db.repos()] },
    { method: "POST", path: "/notes", open: true, answer: postNote }, // A note carries its own signature, so it needs no header.
    { method: "GET", path: "/notes", answer: getNotes },
    { method: "GET", path: "/channels", answer: () => [200, db.channels().map(channelInfo)] },
    { method: "POST", path: "/channels/{name}/join", answer: joinChannel },
    { method: "POST", path: "/channels/{name}/leave", answer: leaveChannel },
    { method: "PUT", path: "/channels/{name}/repo", answer: pinRepo },
    { method: "DELETE", path: "/channels/{name}/repo", answer: unpinRepo }
  ];
  const table = routes.map((route) => ({ route, pattern: new RegExp(`^${route.path.replace("{name}", "([^/]+)")}$`) }));

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<Answer> {
    const [path = "", ...query] = (request.url ?? "").split("?");
    const there = table.flatMap(({ route, pattern }) => {
      const found = pattern.exec(path);
      return found === null ? [] : [{ route, name: found[1] }];
    });
    const hit = there.find((candidate) => candidate.route.method === request.method);
    if (hit === undefined) {
      throw there.length === 0 ? new Refusal(404, "Not Found") : new Refusal(405, "Method Not Allowed");
    }
    const me = hit.route.open === true ? "" : caller(request.headers.authorization ?? "");
    const channel = hit.name === undefined ? "" : `#${parsed(nameSchema, unquote(hit.name), "name")}`;
    return hit.route.answer({ me, channel, query: new URLSearchParams(query.join("?")), body: await bodyText(request), response });
  }

  const server = createServer((request, response) => {
    answer(request, response).then(
      (found) => {
        send(response, found);
      },
      (error: unknown) => {
        if (error instanceof Refusal) {
          send(response, [error.status, { detail: error.message }]);
        } else {
          log("request failed", { path: request.url ?? "", error: error instanceof Error ? error.message : String(error) });
          send(response, [500, { detail: "Internal Server Error" }]);
        }
      }
    );
  });
  server.on("close", () => {
    db.close();
  });
  log("hub ready", { db: settings.db, repos: prefix });
  return server;
}
