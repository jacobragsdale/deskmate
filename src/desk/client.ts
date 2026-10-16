/** Talking to the hub as one person: identity, signed requests, events, searching them and the stream of them, and key pinning. Running an agent is in agents/oneshot.ts. */

import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { chatOf, mayCome } from "../core/chat.ts";
import type { Entry } from "../core/chat.ts";
import { contentSchema, readContent } from "../core/kinds.ts";
import type { Content, ContentOf } from "../core/kinds.ts";
import { problemOf } from "../core/text.ts";
import { authHeader, eventIsAuthentic, loadKey, newKey, privateHex, publicHex, signEvent } from "../core/sign.ts";
import {
  authorSchema,
  channelInfoSchema,
  configSchema,
  deliveredSchema,
  eventSchema,
  HIT_CLOSE,
  HIT_OPEN,
  HUB,
  hubInfoSchema,
  isAgent,
  MAX_SKEW,
  ownerOf,
  personSchema,
  PROTOCOL,
  receiptSchema,
  repoSchema,
  teamRepoSchema,
  userSchema
} from "../core/wire.ts";
import type { Agent, ChannelInfo, Config, Delivered, Event, HubInfo, Person, Repo, TeamRepo } from "../core/wire.ts";
import { AGENT_KEY_VAR, AGENT_VAR, JOB_VAR, ONLY_CHAT_VAR } from "./agentKeys.ts";
import { DEFAULT_PRESET, oneshotAgent } from "./agents/presets.ts";

const CALL_TIMEOUT = 10; // Seconds any one request but the stream may take.
const CATCH_UP_PAGE = 200; // Events one catching-up request asks for: the most the hub gives at once.
const STREAM_RETRY = 30; // Most seconds between two tries at opening the stream again.
const JSON_BODY = { "Content-Type": "application/json" };

/** Makes one HTTP request and resolves with the response body. Rejects with a PlayerTwoError the user can act on. Aborting `signal`, when one is given, ends the request at once. */
export type Transport = (method: string, url: string, headers: Readonly<Record<string, string>>, body: string | null, signal?: AbortSignal) => Promise<string>;
/** Runs the agent command in a folder, with `env` added to the desk's environment, and resolves with what it printed. Aborting `cancel` stops it. */
export type Runner = (argv: readonly string[], cwd: string, cancel: AbortSignal, env?: Readonly<Record<string, string>>) => Promise<string>;

const peopleSchema = z.array(personSchema);
const reposSchema = z.array(repoSchema);
const teamReposSchema = z.array(teamRepoSchema);
const channelsSchema = z.array(channelInfoSchema);
const eventListSchema = z.array(deliveredSchema);
const auditHeadSchema = z.object({ seq: z.int(), chain: z.string() }).readonly();
const pinsSchema = z.record(z.string(), z.string());
const hubErrorSchema = z.object({ detail: z.string() });
const protocolSchema = z.object({ protocol: z.int() }); // All of /info a client of any protocol can count on.
const healthSchema = z.object({ now: z.number() }); // The hub's clock, which /healthz gives to anyone.
const legacyConfigSchema = z.strictObject({ hub: z.string(), name: z.string(), agent: z.string() }); // config.json before phase 3.

/** A search result's snippet cut at the hub's marks into plain stretches and the words the search found. */
function marked(snippet: string): { readonly text: string; readonly hit: boolean }[] {
  // Split on a pattern with a group, the found words come between the plain stretches: every second piece is one.
  return snippet
    .split(new RegExp(`${HIT_OPEN}(.*?)${HIT_CLOSE}`, "su"))
    .map((text, index) => ({ text, hit: index % 2 === 1 }))
    .filter((piece) => piece.text !== "");
}

/** A search result: a message or an answer, and a stretch of its text as last edited, in pieces, the words found marked. */
const foundSchema = z.object({ seq: z.int(), event: eventSchema, snippet: z.string().transform(marked) }).readonly();
const foundListSchema = z.array(foundSchema);

export type Found = z.infer<typeof foundSchema>;

/** A failure the user can act on; shown as it is. */
export class PlayerTwoError extends Error {}

/** The hub refused a request. `status` is the HTTP status it answered with, for a caller to tell "not there" from any other failure. */
export class Refused extends PlayerTwoError {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The user stopped an agent run. */
export class AgentCancelledError extends PlayerTwoError {}

/** An agent run took longer than it may. */
export class AgentTimedOutError extends PlayerTwoError {}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** What `read` makes of one of the identity's files, such as config.json, known.json or a key: a failure names the file, so the user knows which one to look at. */
function fromFile<T>(file: string, read: (text: string) => T): T {
  const text = readFileSync(file, "utf8"); // Node's own failure names the file already.
  try {
    return read(text);
  } catch (error) {
    throw new PlayerTwoError(`${file} cannot be read: ${problemOf(error)}`, { cause: error });
  }
}

function detailOf(raw: string): string {
  try {
    return hubErrorSchema.parse(parseJson(raw)).detail;
  } catch {
    return "";
  }
}

/** Why an address could not be reached: fetch says only "fetch failed", and why, a connection refused or a name not found, is in its cause, by its words or by its code. */
function unreached(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { cause } = error;
  const words = cause instanceof Error ? cause.message : "";
  const why = words === "" && cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : words;
  return why === "" || error.message.includes(why) ? error.message : `${error.message} (${why})`;
}

export const http: Transport = async (method, url, headers, body, signal) => {
  let response: Response;
  let text: string;
  const timeout = AbortSignal.timeout(CALL_TIMEOUT * 1000);
  try {
    response = await fetch(url, { method, headers, body, signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]) });
    text = await response.text();
  } catch (error) {
    throw new PlayerTwoError(`cannot reach the hub at ${url}: ${unreached(error)}`, { cause: error });
  }
  // The hub answers everything asked here in JSON, its refusals too; a web page, or a proxy's word that what is behind it is down, is not the hub's, and its body would only fail to parse.
  const type = response.headers.get("content-type") ?? "no content type";
  if (!type.startsWith("application/json")) {
    throw new PlayerTwoError(`${url} did not answer as a Player Two hub does (${String(response.status)} ${type}): is the hub's address right?`);
  }
  if (!response.ok) {
    const detail = detailOf(text);
    throw new Refused(response.status, detail === "" ? `the hub answered ${String(response.status)} for ${url}` : detail);
  }
  return text;
};

export class Client {
  public readonly home: string;
  public readonly now: () => number; // Unix seconds.
  public readonly signer: string; // Who signs what this client sends and asks: the person who joined, or with `as`, one of their agents, "owner/repo". It reads as the person does.
  public readonly ownKey: string; // The person's public key, from the key file this machine holds: what their own events are checked against, whatever the hub says.
  private readonly key: KeyObject;
  private readonly transport: Transport;
  private readonly greets: boolean; // Whether to ask the hub which protocol it speaks before the first request: see `greeting`.
  private readonly only: string | null; // The one chat it reads, in an agent's run under a grant (see ONLY_CHAT_VAR): nothing from any other is handed over. Null for every chat the person sees.
  public readonly job: string | null; // The one request it may ask other agents under, in an agent's run its owner let ask them (see JOB_VAR); null for any other.
  private greeted: Promise<void> | null = null; // Asking it, or having heard this protocol; null before, and again after a failure, so that the next request asks again.
  private settings: Config;
  private readonly registrations = new Map<string, Entry>(); // Every agent.register read from the hub, by id, with whether it holds under the key pinned for its author.
  private registeredTo = 0; // The seq of the newest event to everyone read: every agent.register up to it is in `registrations`.
  private learning: Promise<void> | null = null; // Reading the registrations newer than that, while it goes on.

  constructor(
    home: string,
    config: Config,
    key: KeyObject,
    transport: Transport,
    now: () => number,
    signer: string = config.name,
    greets = false,
    ownKey: string = publicHex(key),
    only: string | null = null,
    job: string | null = null
  ) {
    this.home = home;
    this.settings = config;
    this.key = key;
    this.transport = transport;
    this.now = now;
    this.signer = signer;
    this.greets = greets;
    this.ownKey = ownKey;
    this.only = only;
    this.job = job;
  }

  /** The same person's client, signing as their agent `agent`, "owner/repo", with the agent's own key: what it publishes, and the requests it makes, are the agent's. */
  public as(agent: string, key: KeyObject): Client {
    return new Client(this.home, this.settings, key, this.transport, this.now, agent, this.greets, this.ownKey, this.only, this.job);
  }

  /**
   * The same client, asking the hub which protocol it speaks before its first request, until it has heard this one's, and failing that request with words that say which side to update.
   * For the command and the MCP server, which would otherwise fail on the first answer they cannot read; the desk asks for itself, and tries again later (see the session's `greet`).
   */
  public greeting(): Client {
    return new Client(this.home, this.settings, this.key, this.transport, this.now, this.signer, true, this.ownKey, this.only, this.job);
  }

  public get config(): Config {
    return this.settings;
  }

  /** Whether it reads `chat`: every chat, unless it is confined to one; then that one, and the events to everyone, "*", which are registrations and grants. */
  private reads(chat: string): boolean {
    return this.only === null || chat === this.only || chat === "*";
  }

  /** Whether it hands over an event the hub delivered: one in a chat it reads. */
  private readable({ event }: Delivered): boolean {
    return this.reads(event.to === "*" ? "*" : chatOf(event, this.settings.name));
  }

  /** Replace the agents and which of them answers: in config.json first, then here. */
  public saveAgents(agents: readonly Agent[], defaultAgent: string): void {
    this.save({ ...this.settings, agents, defaultAgent });
  }

  /** Replace the repos held back, whose agents answer nobody and which the hub is not told of: in config.json first, then here. */
  public saveHeld(held: readonly string[]): void {
    this.save({ ...this.settings, held });
  }

  private save(changed: Config): void {
    const config = configSchema.parse(changed);
    writeFileSync(joinPath(this.home, "config.json"), JSON.stringify(config, null, 1));
    this.settings = config;
  }

  public async info(): Promise<HubInfo> {
    return hubInfoSchema.parse(parseJson(await this.call("GET", "/info")));
  }

  public async users(): Promise<Person[]> {
    return peopleSchema.parse(parseJson(await this.call("GET", "/users")));
  }

  /** Tell the hub which team repos this user has checked out, replacing what it knew. */
  public async advertise(repos: readonly Repo[]): Promise<void> {
    await this.call("PUT", "/repos", JSON.stringify(reposSchema.parse(repos)));
  }

  /** Every repo anyone has checked out, with whose copy it is and the branch it is on. */
  public async repos(): Promise<TeamRepo[]> {
    return teamReposSchema.parse(parseJson(await this.call("GET", "/repos")));
  }

  public async channels(): Promise<ChannelInfo[]> {
    return channelsSchema.parse(parseJson(await this.call("GET", "/channels")));
  }

  /** Sign an event and hand it to the hub. Its id is known once it is signed; resolves with the event and the place the hub gave it. */
  public async publish<K extends Content["kind"]>(to: string, kind: K, content: ContentOf<K>, refs: readonly string[] = []): Promise<Delivered> {
    return this.post(this.sign(to, kind, content, refs));
  }

  /** Sign an event without sending it, as `publish` does, for what is to be judged before it goes. */
  public sign<K extends Content["kind"]>(to: string, kind: K, content: ContentOf<K>, refs: readonly string[] = []): Event {
    const ts = Math.floor(this.now());
    const said = contentSchema.parse({ kind, content, ts }); // What is signed is what this version reads the kind as, at the time it is signed with, so every reader of the kind can read it.
    return signEvent(this.key, { author: this.signer, to, kind, content: JSON.stringify(said.content), ts, refs });
  }

  /**
   * Hand an event this client signed to the hub; resolves with it and the place the hub gave it.
   * A request with no answer, as when the hub is too slow and the time runs out, may have been stored all the same, and the user told it failed would send it again and have it twice:
   * so it is sent once more, the same event, which the hub, keeping each id once, stores now or says it has already, and then is asked where. What the user is told is what the hub holds.
   * ponytail: one more try; a hub silent for longer than two requests' time still leaves the user told it failed when it may yet store it. Try until the event is too old to store, if that is seen.
   */
  public async post(event: Event): Promise<Delivered> {
    const body = JSON.stringify(event);
    const send = async (): Promise<Delivered> => ({ seq: receiptSchema.parse(parseJson(await this.call("POST", "/events", body))).seq, event });
    try {
      return await send();
    } catch (error) {
      if (error instanceof Refused || !(error instanceof PlayerTwoError)) {
        throw error; // Refused, or answered with what this cannot read: either way the hub did answer.
      }
    }
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof Refused && error.status === 409)) {
        throw error;
      }
    }
    const { seq } = deliveredSchema.parse(parseJson(await this.call("GET", `/events/${encodeURIComponent(event.id)}`))); // Its author's own: theirs to see wherever it went.
    return { seq, event };
  }

  /** One chat's events, newest first: the newest `limit` of them (the hub's page when not given), or those older than `before`. A channel is named with its "#". */
  public async events(query: { readonly chat: string; readonly before?: number; readonly limit?: number }): Promise<Delivered[]> {
    if (!this.reads(query.chat)) {
      return [];
    }
    const params = new URLSearchParams({ chat: query.chat });
    if (query.before !== undefined) {
      params.set("before", String(query.before));
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return eventListSchema.parse(parseJson(await this.call("GET", `/events?${params.toString()}`)));
  }

  /** One chat's page centred on `around`, a seq, oldest first: up to half of `limit` (the hub's page when not given) from before it, and the rest from it on. A channel is named with its "#". */
  public async around(query: { readonly chat: string; readonly around: number; readonly limit?: number }): Promise<Delivered[]> {
    if (!this.reads(query.chat)) {
      return [];
    }
    const params = new URLSearchParams({ chat: query.chat, around: String(query.around) });
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return eventListSchema.parse(parseJson(await this.call("GET", `/events?${params.toString()}`)));
  }

  /** One event this user can see, by its id, with its seq; null when there is none they can see. Untrusted until `isTrusted` says otherwise, as is every event the hub hands over. */
  public async event(id: string): Promise<Delivered | null> {
    try {
      const found = deliveredSchema.parse(parseJson(await this.call("GET", `/events/${encodeURIComponent(id)}`)));
      return this.readable(found) ? found : null;
    } catch (error) {
      if (error instanceof Refused && error.status === 404) {
        return null; // Never stored, or not for this user: the hub does not say which.
      }
      throw error;
    }
  }

  /**
   * The messages and answers this user can see that hold every word of `q` (at most 8), in one chat or in all, best match first: at most `limit` (20 when not given, up to 50).
   * Confined to one chat, it searches that one, and finds nothing in any other.
   */
  public async search(query: { readonly q: string; readonly chat?: string; readonly limit?: number }): Promise<Found[]> {
    const chat = query.chat ?? this.only ?? undefined;
    if (chat !== undefined && !this.reads(chat)) {
      return [];
    }
    const params = new URLSearchParams({ q: query.q });
    if (chat !== undefined) {
      params.set("chat", chat);
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return foundListSchema.parse(parseJson(await this.call("GET", `/search?${params.toString()}`)));
  }

  /** A channel's live workflows, each as the workflow.define that made it live, oldest first. Untrusted until `isTrusted` says otherwise; none of a chat it does not read. */
  public async workflows(channel: string): Promise<Delivered[]> {
    if (!this.reads(channel)) {
      return [];
    }
    return eventListSchema.parse(parseJson(await this.call("GET", `/workflows?${new URLSearchParams({ chat: channel }).toString()}`)));
  }

  /** The newest seq in the hub's log, and its chain value. */
  public async head(): Promise<z.infer<typeof auditHeadSchema>> {
    return auditHeadSchema.parse(parseJson(await this.call("GET", "/audit/head")));
  }

  /** Everything this user can see after `after`, oldest first, a page at a time until there is no more. */
  public async catchUp(after: number): Promise<Delivered[]> {
    const found: Delivered[] = [];
    for (;;) {
      const page = await this.page(found.at(-1)?.seq ?? after, CATCH_UP_PAGE);
      found.push(...page);
      if (page.length < CATCH_UP_PAGE) {
        return found.filter((each) => this.readable(each));
      }
    }
  }

  /**
   * Everything this user can see that was stored since `ts`, Unix seconds, oldest first, with some from before it. The hub pages by seq, not by time, so where to start is found by looking back
   * from its newest seq, twice as far each time, until the first event there is older than `ts` by more than an event's time and the hub's may differ twice over, or there is nothing further back.
   * The hub's clock only goes forward, so everything stored after that event was signed at `ts` or later.
   */
  public async since(ts: number): Promise<Delivered[]> {
    const { seq } = await this.head();
    let after = seq;
    for (let back = CATCH_UP_PAGE; after > 0; back *= 2) {
      after = Math.max(0, seq - back);
      const [first] = await this.page(after, 1);
      if (first !== undefined && first.event.ts < ts - 2 * MAX_SKEW) {
        break;
      }
    }
    return this.catchUp(after);
  }

  /** What this user can see after `after`, oldest first: at most `limit` events. */
  private async page(after: number, limit: number): Promise<Delivered[]> {
    return eventListSchema.parse(parseJson(await this.call("GET", `/events?after=${String(after)}&limit=${String(limit)}`)));
  }

  /**
   * Follow the hub until `signal` is aborted: hand `onEvents` what this user can see after `after`, then each event as the hub stores it, a batch for each piece of the response read.
   * When the stream drops it is opened again from the last seq handed over, after a second, then twice as long each time it fails, up to STREAM_RETRY.
   * It does not go through the transport, whose time limit would cut a response that is meant never to end.
   */
  public async stream(after: number, onEvents: (batch: readonly Delivered[]) => Promise<void>, signal: AbortSignal): Promise<void> {
    let last = after;
    let wait = 1;
    while (!signal.aborted) {
      try {
        const path = `/stream?after=${String(last)}`;
        const response = await fetch(this.config.hub + path, { headers: this.headers("GET", path, null), signal });
        if (!response.ok || response.body === null) {
          throw new PlayerTwoError(detailOf(await response.text()));
        }
        wait = 1;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let held = ""; // The start of a line whose end has not arrived yet.
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          const lines = (held + read.value).split("\n");
          held = lines.pop() ?? "";
          // Each event is one "data:" line; anything else is the comment that keeps proxies from closing an idle stream.
          const batch = lines.filter((line) => line.startsWith("data: ")).map((line) => deliveredSchema.parse(parseJson(line.slice("data: ".length))));
          if (batch.length > 0) {
            await onEvents(batch.filter((each) => this.readable(each)));
            last = batch.at(-1)?.seq ?? last;
          }
        }
      } catch {
        // Dropped, refused or unreadable: opened again below, from what was last handed over.
      }
      await delay(wait * 1000, undefined, { signal }).catch(() => undefined);
      wait = Math.min(wait * 2, STREAM_RETRY);
    }
  }

  /** The key `agent` ("owner/repo") signs with now, as its owner last registered it in the log; null when they never have. */
  public async registeredKey(agent: string): Promise<string | null> {
    await this.learnRegistrations();
    return this.keyAt(agent, Infinity);
  }

  /**
   * Whether an event, at its place in the log, holds under its author's key. A person's is the key first seen for them, so a hub that later swaps a key cannot forge one; the user's own is the one in their key file.
   * An agent's is the one its owner's newest registration before the event holds, among those that hold under the owner's: an agent with none, or whose owner's key is not the one pinned, is not trusted.
   * So the user's own agents are checked against registrations their own key signed, and never against a key the hub vouches for.
   * A registration is learned as it passes; one this client has not seen is asked of the hub before an agent's event is refused.
   */
  public async isTrusted({ seq, event }: Delivered): Promise<boolean> {
    if (!isAgent(event.author)) {
      const trusted = await this.pinned(event);
      if (event.kind === "agent.register" && event.to === "*") {
        this.registrations.set(event.id, { seq, event, trusted });
      }
      return trusted;
    }
    const holds = (): boolean => {
      const pubkey = this.keyAt(event.author, seq);
      return pubkey !== null && eventIsAuthentic(event, pubkey);
    };
    if (holds()) {
      return true;
    }
    await this.learnRegistrations();
    return holds();
  }

  /**
   * The key `agent` ("owner/repo") signs with as of `seq`: its owner's newest registration of it before then, to everyone, among those whose signature holds under the key pinned for the owner.
   * Null when there is none: an agent's key is never taken from anything its owner did not sign.
   */
  private keyAt(agent: string, seq: number): string | null {
    let newest: { readonly seq: number; readonly pubkey: string } | null = null;
    for (const { seq: at, event, trusted } of this.registrations.values()) {
      const said = readContent(event);
      // One the hub signed counts for nothing (mayCome): nobody is called hub, so it has no agents.
      if (trusted && at < seq && at > (newest?.seq ?? 0) && event.to === "*" && said.kind === "agent.register" && mayCome(event, said) && `${event.author}/${said.content.repo}` === agent) {
        newest = { seq: at, pubkey: said.content.pubkey };
      }
    }
    return newest?.pubkey ?? null;
  }

  /** Read the registrations stored since the newest event to everyone read before, from the events to everyone, a page at a time from the newest back. One reading at a time: a second call waits for the first. */
  private learnRegistrations(): Promise<void> {
    this.learning ??= (async (): Promise<void> => {
      const found: Delivered[] = [];
      for (let before: number | undefined; ;) {
        const page = await this.events(before === undefined ? { chat: "*", limit: CATCH_UP_PAGE } : { chat: "*", before, limit: CATCH_UP_PAGE });
        found.push(...page.filter((delivered) => delivered.seq > this.registeredTo));
        before = page.at(-1)?.seq;
        if (page.length < CATCH_UP_PAGE || (before ?? 0) <= this.registeredTo) {
          break;
        }
      }
      for (const delivered of found.filter((each) => each.event.kind === "agent.register" && !isAgent(each.event.author))) {
        this.registrations.set(delivered.event.id, { ...delivered, trusted: await this.pinned(delivered.event) });
      }
      this.registeredTo = Math.max(this.registeredTo, found[0]?.seq ?? 0);
    })().finally(() => {
      this.learning = null;
    });
    return this.learning;
  }

  /**
   * Whether an event holds under the key first seen for its author, a person: the one the hub said when this client first asked, or the one in known.json when it did before.
   * The user's own is the key in the file this machine holds, never one the hub says: a hub could otherwise sign a grant in their name, and their desk would run what it lets go.
   * The hub's own, `hub`, from phase 7, is pinned the same way under that name, from its `hubKey` in /info rather than from those who joined, among whom nobody may be called that.
   */
  private async pinned(event: Event): Promise<boolean> {
    const { author } = event;
    if (author === this.config.name) {
      return eventIsAuthentic(event, this.ownKey);
    }
    const pinFile = joinPath(this.home, "known.json");
    let pins = existsSync(pinFile) ? fromFile(pinFile, (text) => pinsSchema.parse(parseJson(text))) : {};
    if (pins[author] === undefined) {
      const fromHub = author === HUB ? await this.hubKey() : Object.fromEntries((await this.users()).filter((user) => user.name !== HUB).map((user) => [user.name, user.pubkey]));
      pins = { ...fromHub, ...pins, [this.config.name]: this.ownKey }; // Keys already pinned win over what the hub says now, and the user's own over both.
      writeFileSync(pinFile, JSON.stringify(pins, null, 1));
    }
    const pubkey = pins[author];
    if (pubkey === undefined) {
      return false;
    }
    return eventIsAuthentic(event, pubkey);
  }

  /** The hub's own key as it says it now, to pin under its name; nothing from a hub that has none. */
  private async hubKey(): Promise<Record<string, string>> {
    const { hubKey } = await this.info();
    return hubKey === undefined ? {} : { [HUB]: hubKey };
  }

  private headers(method: string, path: string, body: string | null): Readonly<Record<string, string>> {
    return { Authorization: authHeader(this.key, this.signer, Math.floor(this.now()), method, path), ...(body === null ? {} : JSON_BODY) };
  }

  private async call(method: string, path: string, body: string | null = null): Promise<string> {
    if (this.greets) {
      this.greeted ??= this.askProtocol().catch((error: unknown) => {
        this.greeted = null;
        throw error;
      });
      await this.greeted;
    }
    return this.signed(method, path, body);
  }

  /**
   * Send a request signed by this client. The hub refuses a signature with the same words whether it does not take the signer's key or the clocks are more than MAX_SKEW apart, as it cannot
   * tell which; its clock, which /healthz gives without a signature, can. When the two agree, the hub lists another key for the signer than the one this machine holds, or none, as when it was
   * started again on an empty database, and the refusal says so, so that the user is not sent to set a clock that is right.
   */
  private async signed(method: string, path: string, body: string | null = null): Promise<string> {
    try {
      return await this.transport(method, this.config.hub + path, this.headers(method, path, body), body);
    } catch (error) {
      if (!(error instanceof Refused) || error.status !== 401) {
        throw error;
      }
      const hubNow = await this.transport("GET", `${this.config.hub}/healthz`, {}, null).then(
        (answer) => healthSchema.parse(parseJson(answer)).now,
        () => null
      );
      if (hubNow === null || Math.abs(this.now() - hubNow) >= MAX_SKEW) {
        throw error;
      }
      throw new Refused(401, `the hub refuses this machine's key for ${this.signer} though the clocks agree, so it lists another key for ${this.signer}, or none: tell whoever runs it`);
    }
  }

  /** Fail, with words that say which side to update, when the hub speaks another protocol than this one. */
  private async askProtocol(): Promise<void> {
    const { protocol } = protocolSchema.parse(parseJson(await this.signed("GET", "/info")));
    if (protocol !== PROTOCOL) {
      const update = protocol > PROTOCOL ? "Player Two on this machine" : "the hub";
      throw new PlayerTwoError(`this hub speaks protocol ${String(protocol)}; this command speaks protocol ${String(PROTOCOL)}: update ${update}`);
    }
  }
}

/** Where the identity lives. The override lets one machine hold several; the default is shared with the `player-two` command. */
export function defaultHome(): string {
  const override = process.env["PLAYER_TWO_HOME"] ?? "";
  return override === "" ? joinPath(homedir(), ".config", "player-two") : override;
}

/** Everyone keeps their repos in ~/dev, so a repo's name is all it takes to find it. The override exists for a second identity on one machine. */
export function defaultDev(): string {
  const override = process.env["PLAYER_TWO_DEV"] ?? "";
  return override === "" ? joinPath(homedir(), "dev") : override;
}

/**
 * Register a name with a hub, creating a key first if this machine has none. `agent`, when given, is the one agent it starts with, replacing any there were. Joining again keeps what config.json
 * held otherwise: the agents, which of them answers, the mode the user's own requests run at and the repos held back, so that a repo held back is not shared again by joining.
 */
export async function join(home: string, hub: string, name: string, token: string, agent: Agent | null, transport: Transport): Promise<Config> {
  const before = existsSync(joinPath(home, "config.json")) ? readConfig(home) : null;
  const agents = agent === null ? null : { agents: [agent], defaultAgent: agent.id };
  const config = configSchema.parse({ ...(before ?? { agents: [DEFAULT_PRESET], defaultAgent: DEFAULT_PRESET.id, ownMode: "auto-edits" }), ...agents, hub: hub.replace(/\/+$/, ""), name });
  mkdirSync(home, { mode: 0o700, recursive: true });
  const keyFile = joinPath(home, "key");
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, privateHex(newKey()), { mode: 0o600 });
  }
  const request = { ...userSchema.parse({ name, pubkey: publicHex(fromFile(keyFile, (text) => loadKey(text.trim()))) }), token };
  await transport("POST", `${config.hub}/join`, JSON_BODY, JSON.stringify(request));
  writeFileSync(joinPath(home, "config.json"), JSON.stringify(config, null, 1));
  const pinFile = joinPath(home, "known.json");
  const pins = existsSync(pinFile) ? fromFile(pinFile, (text) => pinsSchema.parse(parseJson(text))) : {};
  writeFileSync(pinFile, JSON.stringify({ ...pins, [name]: request.pubkey }, null, 1)); // The user's own key is pinned from the start, as their own file has it.
  return config;
}

/**
 * The client for the identity in `home`, or null when nobody has joined from there yet. When `env` names one of that identity's agents and the file its key is in,
 * as an agent's environment does during a run (see `agentEnv`), it signs as that agent: the player-two command and its MCP server pass their own environment, and the desk none.
 * When `env` also names one chat, as a run under a grant's does, it reads that chat and no other; and when it names a request, as a run let ask other agents' does, it may ask them under
 * that one, unless it also names a chat: a run under a grant asks no other agent, whatever else its environment says.
 */
export function loadClient(home: string, transport: Transport, now: () => number, env: Readonly<Record<string, string | undefined>> = {}): Client | null {
  const configFile = joinPath(home, "config.json");
  const keyFile = joinPath(home, "key");
  if (!existsSync(configFile) || !existsSync(keyFile)) {
    return null;
  }
  const config = readConfig(home);
  const key = fromFile(keyFile, (text) => loadKey(text.trim()));
  const only = env[ONLY_CHAT_VAR] ?? null;
  const client = new Client(home, config, key, transport, now, config.name, false, publicHex(key), only, only === null ? (env[JOB_VAR] ?? null) : null);
  const agent = env[AGENT_VAR] ?? "";
  const agentKeyFile = env[AGENT_KEY_VAR] ?? "";
  if (agent === "" || agentKeyFile === "") {
    return client;
  }
  if (!isAgent(agent) || !authorSchema.safeParse(agent).success || ownerOf(agent) !== client.config.name) {
    throw new PlayerTwoError(`${AGENT_VAR} is ${JSON.stringify(agent)}, which is not one of ${client.config.name}'s agents, as owner/repo`);
  }
  return client.as(
    agent,
    fromFile(agentKeyFile, (text) => loadKey(text.trim()))
  );
}

/**
 * config.json in `home`. One written before agents were configured one by one holds a single command line, `agent`:
 * it is read as one one-shot agent, split into words as a shell would split it, and written back in the new shape.
 */
export function readConfig(home: string): Config {
  const file = joinPath(home, "config.json");
  const read = fromFile(file, (text) => {
    const raw = parseJson(text);
    const before = legacyConfigSchema.safeParse(raw);
    return before.success ? before.data : configSchema.parse(raw);
  });
  if (!("agent" in read)) {
    return read;
  }
  const agent = oneshotAgent(read.agent);
  const config = configSchema.parse({ hub: read.hub, name: read.name, agents: [agent], defaultAgent: agent.id, ownMode: "auto-edits" });
  writeFileSync(file, JSON.stringify(config, null, 1));
  return config;
}
