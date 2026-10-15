/** Talking to the hub as one person: identity, signed requests, events, searching them and the stream of them, and key pinning. Running an agent is in agents/oneshot.ts. */

import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type { Entry } from "../core/chat.ts";
import { contentSchema, readContent } from "../core/kinds.ts";
import type { Content, ContentOf } from "../core/kinds.ts";
import { authHeader, eventIsAuthentic, loadKey, newKey, privateHex, publicHex, signEvent } from "../core/sign.ts";
import {
  authorSchema,
  channelInfoSchema,
  configSchema,
  deliveredSchema,
  eventSchema,
  HIT_CLOSE,
  HIT_OPEN,
  hubInfoSchema,
  isAgent,
  MAX_SKEW,
  ownerOf,
  personSchema,
  receiptSchema,
  repoSchema,
  teamRepoSchema,
  userSchema
} from "../core/wire.ts";
import type { Agent, ChannelInfo, Config, Delivered, Event, HubInfo, Person, Repo, TeamRepo } from "../core/wire.ts";
import { AGENT_KEY_VAR, AGENT_VAR } from "./agentKeys.ts";
import { oneshotAgent } from "./agents/presets.ts";

const CALL_TIMEOUT = 10; // Seconds any one request but the stream may take.
const CATCH_UP_PAGE = 200; // Events one catching-up request asks for: the most the hub gives at once.
const STREAM_RETRY = 30; // Most seconds between two tries at opening the stream again.
const JSON_BODY = { "Content-Type": "application/json" };

/** Makes one HTTP request and resolves with the response body. Rejects with a PlayerTwoError the user can act on. */
export type Transport = (method: string, url: string, headers: Readonly<Record<string, string>>, body: string | null) => Promise<string>;
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

function detailOf(raw: string): string {
  try {
    return hubErrorSchema.parse(parseJson(raw)).detail;
  } catch {
    return "";
  }
}

export const http: Transport = async (method, url, headers, body) => {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(CALL_TIMEOUT * 1000) });
    text = await response.text();
  } catch (error) {
    throw new PlayerTwoError(`cannot reach the hub at ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
  private readonly key: KeyObject;
  private readonly transport: Transport;
  private settings: Config;
  private readonly registrations = new Map<string, Entry>(); // Every agent.register read from the hub, by id, with whether it holds under the key pinned for its author.
  private registeredTo = 0; // The seq of the newest event to everyone read: every agent.register up to it is in `registrations`.
  private learning: Promise<void> | null = null; // Reading the registrations newer than that, while it goes on.

  constructor(home: string, config: Config, key: KeyObject, transport: Transport, now: () => number, signer: string = config.name) {
    this.home = home;
    this.settings = config;
    this.key = key;
    this.transport = transport;
    this.now = now;
    this.signer = signer;
  }

  /** The same person's client, signing as their agent `agent`, "owner/repo", with the agent's own key: what it publishes, and the requests it makes, are the agent's. */
  public as(agent: string, key: KeyObject): Client {
    return new Client(this.home, this.settings, key, this.transport, this.now, agent);
  }

  public get config(): Config {
    return this.settings;
  }

  /** Replace the agents and which of them answers: in config.json first, then here. */
  public saveAgents(agents: readonly Agent[], defaultAgent: string): void {
    const config = configSchema.parse({ ...this.settings, agents, defaultAgent });
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
    const ts = Math.floor(this.now());
    const said = contentSchema.parse({ kind, content, ts }); // What is signed is what this version reads the kind as, at the time it is signed with, so every reader of the kind can read it.
    const event = signEvent(this.key, { author: this.signer, to, kind, content: JSON.stringify(said.content), ts, refs });
    const { seq } = receiptSchema.parse(parseJson(await this.call("POST", "/events", JSON.stringify(event))));
    return { seq, event };
  }

  /** One chat's events, newest first: the newest `limit` of them (the hub's page when not given), or those older than `before`. A channel is named with its "#". */
  public async events(query: { readonly chat: string; readonly before?: number; readonly limit?: number }): Promise<Delivered[]> {
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
    const params = new URLSearchParams({ chat: query.chat, around: String(query.around) });
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return eventListSchema.parse(parseJson(await this.call("GET", `/events?${params.toString()}`)));
  }

  /** One event this user can see, by its id, with its seq; null when there is none they can see. Untrusted until `isTrusted` says otherwise, as is every event the hub hands over. */
  public async event(id: string): Promise<Delivered | null> {
    try {
      return deliveredSchema.parse(parseJson(await this.call("GET", `/events/${encodeURIComponent(id)}`)));
    } catch (error) {
      if (error instanceof Refused && error.status === 404) {
        return null; // Never stored, or not for this user: the hub does not say which.
      }
      throw error;
    }
  }

  /** The messages and answers this user can see that hold every word of `q` (at most 8), in one chat or in all, best match first: at most `limit` (20 when not given, up to 50). */
  public async search(query: { readonly q: string; readonly chat?: string; readonly limit?: number }): Promise<Found[]> {
    const params = new URLSearchParams({ q: query.q });
    if (query.chat !== undefined) {
      params.set("chat", query.chat);
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return foundListSchema.parse(parseJson(await this.call("GET", `/search?${params.toString()}`)));
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
        return found;
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
            await onEvents(batch);
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
   * Whether an event, at its place in the log, holds under its author's key. A person's is the key first seen for them, so a hub that later swaps a key cannot forge one.
   * An agent's is the one its owner's newest registration before the event holds, among those that hold under the owner's: an agent with none, or whose owner's key is not the one pinned, is not trusted.
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
      if (trusted && at < seq && at > (newest?.seq ?? 0) && event.to === "*" && said.kind === "agent.register" && `${event.author}/${said.content.repo}` === agent) {
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

  /** Whether an event holds under the key first seen for its author, a person: the one the hub said when this client first asked, or the one in known.json when it did before. */
  private async pinned(event: Event): Promise<boolean> {
    const { author } = event;
    const pinFile = joinPath(this.home, "known.json");
    let pins = existsSync(pinFile) ? pinsSchema.parse(parseJson(readFileSync(pinFile, "utf8"))) : {};
    if (pins[author] === undefined) {
      const fromHub = Object.fromEntries((await this.users()).map((user) => [user.name, user.pubkey]));
      pins = { ...fromHub, ...pins }; // Keys already pinned win over what the hub says now.
      writeFileSync(pinFile, JSON.stringify(pins, null, 1));
    }
    const pubkey = pins[author];
    if (pubkey === undefined) {
      return false;
    }
    return eventIsAuthentic(event, pubkey);
  }

  private headers(method: string, path: string, body: string | null): Readonly<Record<string, string>> {
    return { Authorization: authHeader(this.key, this.signer, Math.floor(this.now()), method, path), ...(body === null ? {} : JSON_BODY) };
  }

  private call(method: string, path: string, body: string | null = null): Promise<string> {
    return this.transport(method, this.config.hub + path, this.headers(method, path, body), body);
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

/** Register a name with a hub, creating a key first if this machine has none. `agent` is the one agent it starts with. */
export async function join(home: string, hub: string, name: string, token: string, agent: Agent, transport: Transport): Promise<Config> {
  const config = configSchema.parse({ hub: hub.replace(/\/+$/, ""), name, agents: [agent], defaultAgent: agent.id, ownMode: "auto-edits" });
  mkdirSync(home, { mode: 0o700, recursive: true });
  const keyFile = joinPath(home, "key");
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, privateHex(newKey()), { mode: 0o600 });
  }
  const request = { ...userSchema.parse({ name, pubkey: publicHex(loadKey(readFileSync(keyFile, "utf8").trim())) }), token };
  await transport("POST", `${config.hub}/join`, JSON_BODY, JSON.stringify(request));
  writeFileSync(joinPath(home, "config.json"), JSON.stringify(config, null, 1));
  return config;
}

/**
 * The client for the identity in `home`, or null when nobody has joined from there yet. When `env` names one of that identity's agents and the file its key is in,
 * as an agent's environment does during a run (see `agentEnv`), it signs as that agent: the player-two command and its MCP server pass their own environment, and the desk none.
 */
export function loadClient(home: string, transport: Transport, now: () => number, env: Readonly<Record<string, string | undefined>> = {}): Client | null {
  const configFile = joinPath(home, "config.json");
  const keyFile = joinPath(home, "key");
  if (!existsSync(configFile) || !existsSync(keyFile)) {
    return null;
  }
  const client = new Client(home, readConfig(home), loadKey(readFileSync(keyFile, "utf8").trim()), transport, now);
  const agent = env[AGENT_VAR] ?? "";
  const agentKeyFile = env[AGENT_KEY_VAR] ?? "";
  if (agent === "" || agentKeyFile === "") {
    return client;
  }
  if (!isAgent(agent) || !authorSchema.safeParse(agent).success || ownerOf(agent) !== client.config.name) {
    throw new PlayerTwoError(`${AGENT_VAR} is ${JSON.stringify(agent)}, which is not one of ${client.config.name}'s agents, as owner/repo`);
  }
  return client.as(agent, loadKey(readFileSync(agentKeyFile, "utf8").trim()));
}

/**
 * config.json in `home`. One written before agents were configured one by one holds a single command line, `agent`:
 * it is read as one one-shot agent, split into words as a shell would split it, and written back in the new shape.
 */
export function readConfig(home: string): Config {
  const file = joinPath(home, "config.json");
  const raw = parseJson(readFileSync(file, "utf8"));
  const before = legacyConfigSchema.safeParse(raw);
  if (!before.success) {
    return configSchema.parse(raw);
  }
  const agent = oneshotAgent(before.data.agent);
  const config = configSchema.parse({ hub: before.data.hub, name: before.data.name, agents: [agent], defaultAgent: agent.id, ownMode: "auto-edits" });
  writeFileSync(file, JSON.stringify(config, null, 1));
  return config;
}
