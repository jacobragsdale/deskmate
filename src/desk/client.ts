/** Talking to the hub as one person: identity, signed requests, events and the stream of them, and key pinning. Running an agent is in agents/oneshot.ts. */

import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { contentSchema } from "../core/kinds.ts";
import type { Content, ContentOf } from "../core/kinds.ts";
import { authHeader, eventIsAuthentic, loadKey, newKey, noteIsAuthentic, privateHex, publicHex, signEvent, signNote } from "../core/sign.ts";
import {
  channelInfoSchema,
  configSchema,
  deliveredNoteSchema,
  deliveredSchema,
  hubInfoSchema,
  nameSchema,
  noteReceiptSchema,
  personSchema,
  receiptSchema,
  repoRefSchema,
  repoSchema,
  teamRepoSchema,
  userSchema
} from "../core/wire.ts";
import type { ChannelInfo, Config, Delivered, DeliveredNote, Event, HubInfo, Kind, Note, Person, Repo, RepoRef, TeamRepo } from "../core/wire.ts";
import { AGENT_CHOICES } from "../shared/ipc.ts";

export const DEFAULT_AGENT: string = AGENT_CHOICES[0].command; // Cursor, as the join form offers it first.
export const POLL_WAIT = 25; // Seconds one long-poll stays open; under the hub's limit and common proxy timeouts.
const CALL_TIMEOUT = 10;
const CATCH_UP_PAGE = 200; // Events one catching-up request asks for: the most the hub gives at once.
const STREAM_RETRY = 30; // Most seconds between two tries at opening the stream again.
const JSON_BODY = { "Content-Type": "application/json" };

/** Makes one HTTP request and resolves with the response body. Rejects with a PlayerTwoError the user can act on. */
export type Transport = (method: string, url: string, headers: Readonly<Record<string, string>>, body: string | null, timeoutSeconds: number, signal?: AbortSignal) => Promise<string>;
/** Runs the agent command in a folder and resolves with what it printed. Aborting `cancel` stops it. */
export type Runner = (argv: readonly string[], cwd: string, cancel: AbortSignal) => Promise<string>;

const peopleSchema = z.array(personSchema);
const reposSchema = z.array(repoSchema);
const teamReposSchema = z.array(teamRepoSchema);
const channelsSchema = z.array(channelInfoSchema);
const noteListSchema = z.array(deliveredNoteSchema);
const eventListSchema = z.array(deliveredSchema);
const auditHeadSchema = z.object({ seq: z.int(), chain: z.string() }).readonly();
const pinsSchema = z.record(z.string(), z.string());
const hubErrorSchema = z.object({ detail: z.string() });

/** A failure the user can act on; shown as it is. */
export class PlayerTwoError extends Error {}

/** The user stopped an agent run. */
export class AgentCancelledError extends PlayerTwoError {}

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

export const http: Transport = async (method, url, headers, body, timeoutSeconds, signal) => {
  const timeout = AbortSignal.timeout(Math.ceil(timeoutSeconds * 1000)); // A whole number of milliseconds: what is left of a wait rarely is one, and a fraction is refused.
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { method, headers, body, signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]) });
    text = await response.text();
  } catch (error) {
    throw new PlayerTwoError(`cannot reach the hub at ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) {
    const detail = detailOf(text);
    throw new PlayerTwoError(detail === "" ? `the hub answered ${String(response.status)} for ${url}` : detail);
  }
  return text;
};

/** A channel's name without its "#". It becomes part of a URL path, so anything but a plain name is refused. */
function bare(channel: string): string {
  return nameSchema.parse(channel.startsWith("#") ? channel.slice(1) : channel);
}

export class Client {
  public readonly home: string;
  public readonly config: Config;
  public readonly now: () => number; // Unix seconds.
  private readonly key: KeyObject;
  private readonly transport: Transport;

  constructor(home: string, config: Config, key: KeyObject, transport: Transport, now: () => number) {
    this.home = home;
    this.config = config;
    this.key = key;
    this.transport = transport;
    this.now = now;
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

  /** Join a channel, creating it if it does not exist. The name may be given with or without its "#". */
  public async joinChannel(channel: string): Promise<ChannelInfo> {
    return channelInfoSchema.parse(parseJson(await this.call("POST", `/channels/${bare(channel)}/join`)));
  }

  public async leaveChannel(channel: string): Promise<ChannelInfo> {
    return channelInfoSchema.parse(parseJson(await this.call("POST", `/channels/${bare(channel)}/leave`)));
  }

  /** Say which repo a channel is about. */
  public async pin(channel: string, repo: RepoRef): Promise<ChannelInfo> {
    const pinned = repoRefSchema.parse({ name: repo.name, key: repo.key, url: repo.url });
    return channelInfoSchema.parse(parseJson(await this.call("PUT", `/channels/${bare(channel)}/repo`, JSON.stringify(pinned))));
  }

  public async unpin(channel: string): Promise<ChannelInfo> {
    return channelInfoSchema.parse(parseJson(await this.call("DELETE", `/channels/${bare(channel)}/repo`)));
  }

  /** Sign a note and hand it to the hub. Resolves with the id the hub gave it. */
  public async send(to: string, body: string, options: { readonly kind?: Kind; readonly agent?: string | null; readonly re?: number | null } = {}): Promise<number> {
    const note = signNote(this.key, { sender: this.config.name, to, kind: options.kind ?? "note", body, ts: Math.floor(this.now()), agent: options.agent ?? null, re: options.re ?? null });
    return noteReceiptSchema.parse(parseJson(await this.transport("POST", `${this.config.hub}/notes`, JSON_BODY, JSON.stringify(note), CALL_TIMEOUT))).id;
  }

  /** Notes this user can see: sent to them, to their channels, and (unless `mine` is false) by them. `status` false leaves out agent status reports. */
  public async notes(
    options: { readonly after?: number; readonly wait?: number; readonly tail?: number; readonly mine?: boolean; readonly status?: boolean; readonly signal?: AbortSignal } = {}
  ): Promise<DeliveredNote[]> {
    const wait = options.wait ?? 0;
    const query = `/notes?after=${String(options.after ?? 0)}&wait=${wait.toFixed(1)}&mine=${String(options.mine ?? true)}&status=${String(options.status ?? true)}${options.tail === undefined ? "" : `&tail=${String(options.tail)}`}`;
    return noteListSchema.parse(parseJson(await this.call("GET", query, null, wait + CALL_TIMEOUT, options.signal)));
  }

  /** Sign an event and hand it to the hub. Its id is known once it is signed; resolves with the event and the place the hub gave it. */
  public async publish<K extends Content["kind"]>(to: string, kind: K, content: ContentOf<K>, refs: readonly string[] = []): Promise<Delivered> {
    const said = contentSchema.parse({ kind, content }); // What is signed is what this version reads the kind as, so every reader of the kind can read it.
    const event = signEvent(this.key, { author: this.config.name, to, kind, content: JSON.stringify(said.content), ts: Math.floor(this.now()), refs });
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

  /** The newest seq in the hub's log, and its chain value. */
  public async head(): Promise<z.infer<typeof auditHeadSchema>> {
    return auditHeadSchema.parse(parseJson(await this.call("GET", "/audit/head")));
  }

  /** Everything this user can see after `after`, oldest first, a page at a time until there is no more. */
  public async catchUp(after: number): Promise<Delivered[]> {
    const found: Delivered[] = [];
    for (;;) {
      const page = eventListSchema.parse(parseJson(await this.call("GET", `/events?after=${String(found.at(-1)?.seq ?? after)}&limit=${String(CATCH_UP_PAGE)}`)));
      found.push(...page);
      if (page.length < CATCH_UP_PAGE) {
        return found;
      }
    }
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

  /** Check an event against the key first seen for its author, so a hub that later swaps a key cannot forge one. A note, until the command reads events, is checked the same way. */
  public async isTrusted(signed: Event | Note): Promise<boolean> {
    const author = "author" in signed ? signed.author : signed.sender;
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
    return "author" in signed ? eventIsAuthentic(signed, pubkey) : noteIsAuthentic(signed, pubkey);
  }

  private headers(method: string, path: string, body: string | null): Readonly<Record<string, string>> {
    return { Authorization: authHeader(this.key, this.config.name, Math.floor(this.now()), method, path), ...(body === null ? {} : JSON_BODY) };
  }

  private call(method: string, path: string, body: string | null = null, timeoutSeconds = CALL_TIMEOUT, signal?: AbortSignal): Promise<string> {
    return this.transport(method, this.config.hub + path, this.headers(method, path, body), body, timeoutSeconds, signal);
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

/** Register a name with a hub, creating a key first if this machine has none. */
export async function join(home: string, hub: string, name: string, token: string, agent: string, transport: Transport): Promise<Config> {
  const config = configSchema.parse({ hub: hub.replace(/\/+$/, ""), name, agent });
  mkdirSync(home, { mode: 0o700, recursive: true });
  const keyFile = joinPath(home, "key");
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, privateHex(newKey()), { mode: 0o600 });
  }
  const request = { ...userSchema.parse({ name, pubkey: publicHex(loadKey(readFileSync(keyFile, "utf8").trim())) }), token };
  await transport("POST", `${config.hub}/join`, JSON_BODY, JSON.stringify(request), CALL_TIMEOUT);
  writeFileSync(joinPath(home, "config.json"), JSON.stringify(config, null, 1));
  return config;
}

/** The client for the identity in `home`, or null when nobody has joined from there yet. */
export function loadClient(home: string, transport: Transport, now: () => number): Client | null {
  const configFile = joinPath(home, "config.json");
  const keyFile = joinPath(home, "key");
  if (!existsSync(configFile) || !existsSync(keyFile)) {
    return null;
  }
  return new Client(home, configSchema.parse(parseJson(readFileSync(configFile, "utf8"))), loadKey(readFileSync(keyFile, "utf8").trim()), transport, now);
}
