/** The hub: keeps everyone's public key and channel memberships, relays signed events, and keeps them for later reading. One table of routes on node:http. */

import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join as joinPath } from "node:path";
import { pipeline } from "node:stream";

import { z } from "zod";

import { digestIn, hubInstallScript } from "../core/install.ts";
import { AGENT_KINDS, PUBLIC_KINDS, readContent } from "../core/kinds.ts";
import { isUnder, prefixKey } from "../core/remotes.ts";
import { authClaim, authIsValid, eventId, eventIsAuthentic, isFresh } from "../core/sign.ts";
import { VERSION } from "../core/version.ts";
import { addressSchema, eventSchema, isAgent, isChannel, joinSchema, ownerOf, PROTOCOL, repoSchema } from "../core/wire.ts";
import type { ChannelInfo, Event, RepoRef } from "../core/wire.ts";
import { Database } from "./db.ts";

const PAGE = 100; // Events one read gets when it does not say how many.
const MAX_PAGE = 200; // Most events one read may ask for.
const HITS = 20; // Search results one search gets when it does not say how many.
const MAX_HITS = 50; // Most search results one search may ask for.
const MAX_WORDS = 8; // Most words one search may hold: each is matched against every message that holds it, and the hub does nothing else meanwhile.
const MAX_QUERY = 200; // Most characters one search may be: far more than eight words take, and no more to split.
const TOO_MUCH = `a search holds 1 to ${String(MAX_WORDS)} words, in at most ${String(MAX_QUERY)} characters`;
const PING = 20; // Seconds between the comment lines that keep an open stream from looking idle to a proxy.
const MAX_REPOS = 500; // Most checkouts one person may advertise.
const MAX_REQUEST = 4_000_000; // Most characters one request's body may hold: several times the longest list of repos or the longest event.
const RUNTIME = "wsl-runtime.tar.gz"; // The Linux runtime in the downloads folder, with its digest beside it in the same name and ".sha256".
const INSTALLER = "player-two-setup.exe"; // The Windows installer, as electron-builder names it (`nsis.artifactName` in package.json).
const PLAIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // A file in the downloads folder is asked for by this name as it arrived: no slash, no "..", nothing percent-encoded.
const ADDRESS = /^https?:\/\/[A-Za-z0-9.\-:[\]/_]+$/; // The hub's own address is written into a script and a page, so only plain URL characters pass.

export interface HubSettings {
  readonly joinToken: string; // The shared secret that lets a teammate register a name.
  readonly db: string; // The file the hub keeps everything in.
  readonly repos: string; // The URL the team's repos live under; only those may be shared.
  readonly downloads: string; // The folder of what a teammate installs, served to anyone who asks; "" when there is none.
}

/** Something worth a line in the hub's log: what happened, and the facts of it. */
export type Log = (event: string, facts: Readonly<Record<string, string | number>>) => void;

const advertsSchema = z.array(repoSchema).max(MAX_REPOS);

// A query string holds only text, so numbers arrive written out.
const numeric = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform(Number);
const eventsQuerySchema = z.object({
  chat: z.union([addressSchema, z.literal("*")]).optional(), // "*" is the events to everyone: agents' registrations and grants.
  before: numeric.pipe(z.int()).optional(),
  after: numeric.pipe(z.int()).optional(),
  around: numeric.pipe(z.int()).optional(),
  limit: numeric.pipe(z.int().min(1).max(MAX_PAGE)).default(PAGE)
});
const streamQuerySchema = z.object({ after: numeric.pipe(z.int()).default(0) });
const searchQuerySchema = z.object({
  // A word is a run of letters and digits, which is what FTS5's tokenizer makes one token of, so the limit counts what a search costs: "the.the.the" is three words, not one.
  q: z
    .string()
    .max(MAX_QUERY, TOO_MUCH)
    .transform((q) => q.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ""))
    .pipe(z.array(z.string()).min(1, TOO_MUCH).max(MAX_WORDS, TOO_MUCH)),
  chat: addressSchema.optional(),
  limit: numeric.pipe(z.int().min(1).max(MAX_HITS)).default(HITS)
});

/** One request as a route sees it. */
interface Ask {
  readonly me: string; // Who is asking, proved by their signature, or the owner of the agent asking, who sees what its owner sees; "" on the routes open to anyone.
  readonly signer: string; // Whose signature it is: `me`, or one of their agents, "me/repo".
  readonly id: string; // The event id the path names; "" on a route that names none.
  readonly query: URLSearchParams;
  readonly body: string; // What the request carried, not yet parsed.
  readonly response: ServerResponse; // For the stream, which writes to it itself.
}

type Answer = readonly [status: number, body: unknown];

interface Route {
  readonly method: string;
  readonly path: string; // With "{id}" where an event's id goes.
  readonly open?: true; // Answered without asking who is calling.
  readonly answer: (ask: Ask) => Answer | null; // Null when the route has answered by itself.
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

function sendText(response: ServerResponse, type: string, text: string, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": Buffer.byteLength(text) }).end(text);
}

/** The address a request reached the hub by: the host it named, and https when the ingress in front of the hub says the request came that way. */
function addressOf(request: IncomingMessage): string {
  const address = `${request.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${request.headers.host ?? ""}`;
  if (!ADDRESS.test(address)) {
    throw new Refusal(400, "unsupported host header");
  }
  return address;
}

/** The size of a file, or null when there is no file there. */
function sizeOf(path: string): number | null {
  try {
    const found = statSync(path);
    return found.isFile() ? found.size : null;
  } catch {
    return null;
  }
}

/** The page a teammate is sent to: the installer and the three steps, with the hub's address where they need it. `hub` has passed ADDRESS, so it holds nothing HTML would read as markup. */
function installPage(hub: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Player Two</title>
    <style>
      body { font: 15px/1.5 system-ui, sans-serif; max-width: 42em; margin: 3em auto; padding: 0 1em; color-scheme: light dark; }
      code { background: #8882; padding: 0 0.25em; border-radius: 3px; }
    </style>
  </head>
  <body>
    <h1>Player Two</h1>
    <p>Chat with your team and their coding agents. To join this hub from Windows:</p>
    <ol>
      <li>Install WSL with Ubuntu, if you have not: in PowerShell, <code>wsl --install -d Ubuntu</code>, then restart and open Ubuntu once to make your user.</li>
      <li>Download <a href="/downloads/${INSTALLER}">the Player Two installer</a> and run it.</li>
      <li>Open Player Two and join with this hub's address, <code>${hub}</code>, your name, and the join token from whoever runs the hub.</li>
    </ol>
    <p>On Linux, for the <code>player-two</code> command alone: <code>curl -fsSL ${hub}/install.sh | sh</code></p>
  </body>
</html>
`;
}

/** Open the hub's database and return its server, not yet listening. `now` is the hub's clock in Unix seconds. Closing the server closes the database. */
export function createHub(settings: HubSettings, now: () => number = () => Date.now() / 1000, log: Log = () => undefined): Server {
  const prefix = prefixKey(settings.repos);
  const db = new Database(settings.db);
  const waiting = new Set<() => void>(); // Streams open for the next event; each is called when one is stored.

  /** Who signed the request, a person or one of their agents, once their header is seen to be signed for this very request: its method, and its path and query as they arrived. */
  function caller(request: IncomingMessage): string {
    const claim = authClaim(request.headers.authorization ?? "");
    const pubkey = claim === null ? null : keyOf(claim.name);
    if (claim === null || pubkey === null || !authIsValid(claim, pubkey, now(), request.method ?? "", request.url ?? "")) {
      throw new Refusal(401, "not signed by a known user, or your clock is more than 5 minutes off");
    }
    if (!isAgent(claim.name)) {
      db.sawUser(claim.name, Math.floor(now())); // Every signed request doubles as "I am here". An agent at work says nothing of whether its owner is.
    }
    return claim.name;
  }

  function channelInfo(channel: string): ChannelInfo {
    return { name: channel, members: db.members(channel), ...db.pinOf(channel) };
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
    if (ask.signer !== ask.me) {
      throw new Refusal(403, "agents cannot change which repos their owner shares");
    }
    const mine = jsonBody(advertsSchema, ask.body);
    mine.forEach(shareable);
    if (new Set(mine.map((repo) => repo.name)).size !== mine.length) {
      throw new Refusal(422, "two repos share a name");
    }
    db.replaceRepos(ask.me, mine);
    return [200, mine];
  }

  /** The key `author` signs with: a person's, from joining; an agent's, "owner/repo", from its owner's newest registration of it. Null when there is none. */
  function keyOf(author: string): string | null {
    const owner = ownerOf(author);
    return isAgent(author) ? db.agentKeyOf(owner, author.slice(owner.length + 1)) : db.pubkeyOf(author);
  }

  /** What an agent may send: its run's own reports, about its own repo, never an answer said to be reviewed, and requests of other agents as the last agent each came through. */
  function mayAgentSend(event: Event): void {
    const said = readContent(event);
    const own = event.author.slice(ownerOf(event.author).length + 1);
    if (!AGENT_KINDS.has(event.kind)) {
      throw new Refusal(403, `agents cannot send ${event.kind}: only a person can`);
    }
    if (said.kind === "unknown") {
      throw new Refusal(422, `invalid content: not what ${event.kind} holds`); // Nobody could read whose report it is.
    }
    if ("repo" in said.content && said.content.repo !== own) {
      throw new Refusal(403, `${event.author} reports only on its own repo, ${own}`); // Every reader would count it for nothing (mayCome in src/core/chat.ts).
    }
    if (said.kind === "job.request" && said.content.chain.at(-1) !== event.author) {
      throw new Refusal(403, `a job.request's chain ends with the agent that sends it, ${event.author}`); // As every reader would count it for nothing.
    }
    if (said.kind === "job.result" && said.content.reviewed) {
      throw new Refusal(403, "an agent cannot say its answer was reviewed: one its owner reviewed is sent by its owner"); // As every reader would count it for nothing.
    }
  }

  /**
   * The fourth of the checks an event passes: whether its author may write to whom it is for. Anyone may write to everyone, "*", but only the public kinds.
   * An agent sends only what `mayAgentSend` lets it, and only where its owner may write.
   */
  function mayWrite(event: Event): void {
    const writer = ownerOf(event.author);
    if (isAgent(event.author)) {
      mayAgentSend(event);
    }
    if (event.to === "*") {
      if (!PUBLIC_KINDS.has(event.kind)) {
        throw new Refusal(403, `${event.kind} cannot be sent to everyone`);
      }
    } else if (isChannel(event.to)) {
      if (event.kind !== "channel.join" && !db.members(event.to).includes(writer)) {
        throw new Refusal(403, `join ${event.to} before posting to it`);
      }
    } else if (db.pubkeyOf(event.to) === null) {
      throw new Refusal(404, `nobody named '${event.to}' has joined`);
    }
  }

  /** Act on agent.register, stored at `seq`: from now on its author's agent in its repo signs with its key, whatever key it had before. It is sent to everyone, so that every reader can learn the key from it. */
  function register(event: Event, seq: number): void {
    const said = readContent(event);
    if (event.to !== "*") {
      throw new Refusal(422, `${event.kind} is sent to everyone, "*"`);
    }
    if (said.kind !== "agent.register") {
      throw new Refusal(422, `invalid content: not what ${event.kind} holds`);
    }
    db.setAgentKey(event.author, said.content.repo, said.content.pubkey, seq);
    log("agent registered", { agent: `${event.author}/${said.content.repo}` });
  }

  /**
   * Act on a structural kind, stored at `seq`: joining and leaving change who is in the channel, a pin sets or clears the repo it is about, and a registration sets an agent's key. Anything else the hub only stores.
   * Run in the event's transaction, and refuses an event it cannot act on, so that what the hub keeps and what its tables say never disagree.
   */
  function apply(event: Event, seq: number): void {
    if (event.kind === "agent.register") {
      register(event, seq);
      return;
    }
    if (event.kind !== "channel.join" && event.kind !== "channel.leave" && event.kind !== "channel.pin") {
      return;
    }
    const said = readContent(event);
    if (!isChannel(event.to)) {
      throw new Refusal(422, `${event.kind} is sent to the channel it is about`);
    }
    if (said.kind === "channel.join") {
      db.addMember(event.to, event.author); // A channel nobody was in starts here.
      log("channel joined", { channel: event.to, user: event.author });
    } else if (said.kind === "channel.leave") {
      db.removeMember(event.to, event.author);
      log("channel left", { channel: event.to, user: event.author });
    } else if (said.kind === "channel.pin") {
      // The fourth check has already made sure the author is in the channel.
      const { repo, branch } = said.content;
      if (repo === null) {
        db.removePin(event.to);
      } else {
        shareable(repo);
        db.setPin(event.to, repo, branch);
      }
    } else {
      throw new Refusal(422, `invalid content: not what ${event.kind} holds`);
    }
  }

  /** Store one signed event once it passes the protocol's four checks, in their order, and nothing else: the hub keeps kinds it has never heard of. */
  function postEvent(ask: Ask): Answer {
    const event = jsonBody(eventSchema, ask.body);
    if (event.id !== eventId(event)) {
      throw new Refusal(422, "invalid id: not the hash of the event's signed bytes");
    }
    const pubkey = keyOf(event.author);
    if (pubkey === null || !eventIsAuthentic(event, pubkey)) {
      throw new Refusal(401, "event is not signed by its author");
    }
    if (!isFresh(event.ts, now())) {
      throw new Refusal(400, "event timestamp is more than 5 minutes off the hub clock; check your system time");
    }
    if (db.hasEvent(event.id)) {
      throw new Refusal(409, "this event was already stored");
    }
    mayWrite(event);
    const seq = db.transaction(() => {
      const stored = db.addEvent(event);
      apply(event, stored);
      return stored;
    });
    waiting.forEach((wake) => {
      wake();
    });
    log("event stored", { seq, author: event.author, recipient: event.to, kind: event.kind });
    return [201, { seq }];
  }

  /**
   * One chat's events older than `before`, newest first, for paging back through it; or around `around`, oldest first, for opening it at one event;
   * or without a chat, everything the caller can see after `after`, oldest first, for catching up.
   */
  function getEvents(ask: Ask): Answer {
    const { chat, before, after, around, limit } = parsed(eventsQuerySchema, Object.fromEntries(ask.query), "query");
    if (chat === undefined ? before !== undefined || around !== undefined : after !== undefined || (before !== undefined && around !== undefined)) {
      throw new Refusal(422, "invalid query: before or around goes with chat, and after without it");
    }
    if (chat === undefined) {
      return [200, db.eventsAfter(ask.me, after ?? 0, limit)];
    }
    return [200, around === undefined ? db.chatEvents(ask.me, chat, before ?? Number.MAX_SAFE_INTEGER, limit) : db.chatAround(ask.me, chat, around, limit)];
  }

  /** One event the caller can see, by the id in the path. One they cannot see is answered as one that does not exist, so that asking says nothing about what is in a chat they are not in. */
  function getEvent(ask: Ask): Answer {
    const found = db.event(ask.me, ask.id);
    if (found === null) {
      throw new Refusal(404, "there is no event with that id that you can see");
    }
    return [200, found];
  }

  /** The messages and answers the caller can see that hold every word they asked for, best match first, each with a marked stretch of its text. */
  function search(ask: Ask): Answer {
    const { q, chat, limit } = parsed(searchQuerySchema, Object.fromEntries(ask.query), "query");
    return [200, db.search(ask.me, q, chat ?? null, limit)];
  }

  /**
   * Hold the response open and send the caller every event they can see after `after`, then each new one as it is stored, and a comment line every PING seconds.
   * Each batch is read through the same rule as every other read, at the moment it is sent, so a channel left since the stream opened sends nothing more.
   */
  function stream(ask: Ask): null {
    const { after } = parsed(streamQuerySchema, Object.fromEntries(ask.query), "query");
    const { me, response } = ask;
    let sent = after;
    const send = (): void => {
      // Stops while the reader has not taken what was written, and goes on when it has ("drain"), so a slow reader holds a page of the log in memory, not all of it.
      while (!response.writableNeedDrain) {
        const newest = db.head().seq; // Nothing can be stored between this and the read below: both happen in this one turn of the loop.
        const page = db.eventsAfter(me, sent, MAX_PAGE);
        for (const delivered of page) {
          response.write(`data: ${JSON.stringify(delivered)}\n\n`);
          sent = delivered.seq;
        }
        if (page.length < MAX_PAGE) {
          sent = Math.max(sent, newest); // Passed over: an event the caller could not see as the stream went by is not sent if they can later, as after joining a channel. Reading the chat shows it.
          return;
        }
      }
    };
    const ping = setInterval(() => {
      response.write(":\n\n");
    }, PING * 1000);
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }).flushHeaders();
    waiting.add(send);
    response.on("drain", send);
    response.once("close", () => {
      clearInterval(ping);
      waiting.delete(send);
      response.off("drain", send);
    });
    send();
    return null;
  }

  const routes: readonly Route[] = [
    { method: "GET", path: "/healthz", open: true, answer: () => [200, { ok: true, now: Math.floor(now()) }] }, // The clock is here as well as in /info for the setup check: once the clocks differ by five minutes, /info refuses the signature that asks for it.
    { method: "POST", path: "/join", open: true, answer: join },
    { method: "GET", path: "/info", answer: () => [200, { version: VERSION, protocol: PROTOCOL, repos: prefix, now: Math.floor(now()) }] },
    { method: "GET", path: "/users", answer: () => [200, db.users()] },
    { method: "PUT", path: "/repos", answer: putRepos },
    { method: "GET", path: "/repos", answer: () => [200, db.repos()] },
    { method: "POST", path: "/events", answer: postEvent },
    { method: "GET", path: "/events", answer: getEvents },
    { method: "GET", path: "/events/{id}", answer: getEvent },
    { method: "GET", path: "/search", answer: search },
    { method: "GET", path: "/stream", answer: stream },
    { method: "GET", path: "/audit/head", answer: () => [200, db.head()] }, // For comparing with what someone saw before: a log changed since cannot end in the same chain value.
    { method: "GET", path: "/channels", answer: () => [200, db.channels().map(channelInfo)] }
  ];
  const table = routes.map((route) => ({ route, pattern: new RegExp(`^${route.path.replace("{id}", "([0-9a-f]{64})")}$`) })); // Any other id is no route at all, and answered 404.

  /** The digest of the runtime in the downloads folder, from the file beside it. */
  function runtimeDigest(): string {
    let digest = "";
    try {
      digest = digestIn(readFileSync(joinPath(settings.downloads, `${RUNTIME}.sha256`), "utf8"));
    } catch {
      // Not there: said below.
    }
    if (digest === "") {
      throw new Refusal(404, `${RUNTIME}.sha256 is not on this hub, so there is no runtime to install`);
    }
    return digest;
  }

  /** Send one file from the downloads folder. It is named by a plain file name and nothing else, so nothing outside that folder can be asked for. */
  function download(name: string, response: ServerResponse): void {
    const path = joinPath(settings.downloads, name);
    const size = PLAIN_FILE.test(name) ? sizeOf(path) : null;
    if (size === null) {
      throw new Refusal(404, "Not Found");
    }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size, "Content-Disposition": `attachment; filename="${name}"` });
    pipeline(createReadStream(path), response, () => undefined); // A reader who hangs up, or a file that goes, ends the response and nothing more.
  }

  // The page and the script carry the address in the request's Host, so a cache between the hub and a teammate must not hand one person's answer to another.
  const BY_HOST = { "Cache-Control": "no-store", Vary: "Host" };

  /** Answer what a teammate installs from, open to anyone: the page, a file from the downloads folder, and the script for Linux. False when `path` is none of these. */
  function served(path: string, request: IncomingMessage, response: ServerResponse): boolean {
    const file = path.startsWith("/downloads/") ? path.slice("/downloads/".length) : null;
    if (request.method !== "GET" || (path !== "/" && path !== "/install.sh" && file === null)) {
      return false;
    }
    if (settings.downloads === "") {
      throw new Refusal(404, "Not Found");
    }
    if (file !== null) {
      download(file, response);
    } else if (path === "/install.sh") {
      sendText(response, "text/x-shellscript; charset=utf-8", hubInstallScript(addressOf(request), runtimeDigest()), BY_HOST);
    } else {
      sendText(response, "text/html; charset=utf-8", installPage(addressOf(request)), { ...BY_HOST, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
    }
    return true;
  }

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<Answer | null> {
    const [path = "", ...query] = (request.url ?? "").split("?");
    if (served(path, request, response)) {
      return null; // Answered already, with a file, a page or a script rather than JSON.
    }
    const there = table.flatMap(({ route, pattern }) => {
      const found = pattern.exec(path);
      return found === null ? [] : [{ route, id: found[1] ?? "" }];
    });
    const hit = there.find((candidate) => candidate.route.method === request.method);
    if (hit === undefined) {
      throw there.length === 0 ? new Refusal(404, "Not Found") : new Refusal(405, "Method Not Allowed");
    }
    const signer = hit.route.open === true ? "" : caller(request);
    return hit.route.answer({ me: ownerOf(signer), signer, id: hit.id, query: new URLSearchParams(query.join("?")), body: await bodyText(request), response });
  }

  const server = createServer((request, response) => {
    answer(request, response).then(
      (found) => {
        if (found !== null) {
          send(response, found);
        }
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
  log("hub ready", { db: settings.db, repos: prefix, downloads: settings.downloads });
  return server;
}
