/** Talking to the hub as one person: identity, signed requests, key pinning, and running the local agent. Mirrors src/deskmate/client.py. */

import { spawn } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

import { z } from "zod";

import { authHeader, loadKey, newKey, noteIsAuthentic, privateHex, publicHex, signNote } from "./sign.ts";
import { channelInfoSchema, configSchema, deliveredSchema, hubInfoSchema, nameSchema, personSchema, receiptSchema, repoRefSchema, repoSchema, teamRepoSchema, userSchema } from "./wire.ts";
import type { ChannelInfo, Config, Delivered, HubInfo, Kind, Note, Person, Repo, RepoRef, TeamRepo } from "./wire.ts";

export const DEFAULT_AGENT = "claude -p";
export const AGENT_TIMEOUT = 900; // Seconds an approved agent run may take.
export const POLL_WAIT = 25; // Seconds one long-poll stays open; under the hub's limit and common proxy timeouts.
const CALL_TIMEOUT = 10;
const JSON_BODY = { "Content-Type": "application/json" };

/** Makes one HTTP request and resolves with the response body. Rejects with a DeskmateError the user can act on. */
export type Transport = (method: string, url: string, headers: Readonly<Record<string, string>>, body: string | null, timeoutSeconds: number, signal?: AbortSignal) => Promise<string>;
/** Runs the agent command in a folder and resolves with what it printed. Aborting `cancel` stops it. */
export type Runner = (argv: readonly string[], cwd: string, cancel: AbortSignal) => Promise<string>;

const peopleSchema = z.array(personSchema);
const reposSchema = z.array(repoSchema);
const teamReposSchema = z.array(teamRepoSchema);
const channelsSchema = z.array(channelInfoSchema);
const deliveredListSchema = z.array(deliveredSchema);
const pinsSchema = z.record(z.string(), z.string());
const hubErrorSchema = z.object({ detail: z.string() });

/** A failure the user can act on; shown as it is. */
export class DeskmateError extends Error {}

/** The user stopped an agent run. */
export class AgentCancelledError extends DeskmateError {}

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
  const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { method, headers, body, signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]) });
    text = await response.text();
  } catch (error) {
    throw new DeskmateError(`cannot reach the hub at ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) {
    const detail = detailOf(text);
    throw new DeskmateError(detail === "" ? `the hub answered ${String(response.status)} for ${url}` : detail);
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
    return receiptSchema.parse(parseJson(await this.transport("POST", `${this.config.hub}/notes`, JSON_BODY, JSON.stringify(note), CALL_TIMEOUT))).id;
  }

  /** Notes this user can see: sent to them, to their channels, and (unless `mine` is false) by them. `status` false leaves out agent status reports. */
  public async notes(
    options: { readonly after?: number; readonly wait?: number; readonly tail?: number; readonly mine?: boolean; readonly status?: boolean; readonly signal?: AbortSignal } = {}
  ): Promise<Delivered[]> {
    const wait = options.wait ?? 0;
    const query = `/notes?after=${String(options.after ?? 0)}&wait=${wait.toFixed(1)}&mine=${String(options.mine ?? true)}&status=${String(options.status ?? true)}${options.tail === undefined ? "" : `&tail=${String(options.tail)}`}`;
    return deliveredListSchema.parse(parseJson(await this.call("GET", query, null, wait + CALL_TIMEOUT, options.signal)));
  }

  /** Check a note against the key first seen for its sender, so a hub that later swaps a key cannot forge notes. */
  public async isTrusted(note: Note): Promise<boolean> {
    const pinFile = joinPath(this.home, "known.json");
    let pins = existsSync(pinFile) ? pinsSchema.parse(parseJson(readFileSync(pinFile, "utf8"))) : {};
    if (pins[note.sender] === undefined) {
      const fromHub = Object.fromEntries((await this.users()).map((user) => [user.name, user.pubkey]));
      pins = { ...fromHub, ...pins }; // Keys already pinned win over what the hub says now.
      writeFileSync(pinFile, JSON.stringify(pins, null, 1));
    }
    const pubkey = pins[note.sender];
    return pubkey !== undefined && noteIsAuthentic(note, pubkey);
  }

  private call(method: string, path: string, body: string | null = null, timeoutSeconds = CALL_TIMEOUT, signal?: AbortSignal): Promise<string> {
    const headers = { Authorization: authHeader(this.key, this.config.name, Math.floor(this.now())), ...(body === null ? {} : JSON_BODY) };
    return this.transport(method, this.config.hub + path, headers, body, timeoutSeconds, signal);
  }
}

/** Where the identity lives. The override lets one machine hold several; the default is shared with the `deskmate` command. */
export function defaultHome(): string {
  const override = process.env["DESKMATE_HOME"] ?? "";
  return override === "" ? joinPath(homedir(), ".config", "deskmate") : override;
}

/** Everyone keeps their repos in ~/dev, so a repo's name is all it takes to find it. The override exists for a second identity on one machine. */
export function defaultDev(): string {
  const override = process.env["DESKMATE_DEV"] ?? "";
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

// The pieces of a command line: a run of spaces, a quoted stretch of either kind, an escaped character, a quote that never closes, or plain text.
const PIECE = /(\s+)|'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|(['"])|([^\s'"\\]+|\\)/g;

/** Split a command into words the way a shell would, with quotes grouping words. No shell runs it. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (const [, space, single, double, escaped, unclosed, plain] of command.matchAll(PIECE)) {
    if (unclosed !== undefined) {
      throw new DeskmateError("no closing quotation");
    }
    if (space === undefined) {
      word = (word ?? "") + (single ?? double?.replace(/\\(["\\])/g, "$1") ?? escaped ?? plain ?? "");
    } else if (word !== null) {
      words.push(word);
      word = null;
    }
  }
  return word === null ? words : [...words, word];
}

/** Run the agent command and resolve with what it printed. Aborting `cancel` stops it and everything it started. */
export const runAgent: Runner = (argv, cwd, cancel) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new DeskmateError('the agent command is empty. Set "agent" in config.json'));
      return;
    }
    // Its own process group, so stopping it takes the agent's child processes with it.
    // ponytail: process groups are POSIX; on Windows this stops only the agent itself. Use `taskkill /T` there if it matters.
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let ended: "finished" | "cancelled" | "timed out" = "finished";
    const stop = (why: "cancelled" | "timed out"): void => {
      ended = why;
      if (child.pid === undefined) {
        return; // It never started; the "error" event reports why.
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // No such group: the agent has already gone.
      }
    };
    const onCancel = (): void => {
      stop("cancelled");
    };
    const timer = setTimeout(() => {
      stop("timed out");
    }, AGENT_TIMEOUT * 1000);
    cancel.addEventListener("abort", onCancel, { once: true });
    if (cancel.aborted) {
      onCancel();
    }
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      cancel.removeEventListener("abort", onCancel);
      finish();
    };
    child.on("error", (error) => {
      settle(() => {
        reject(new DeskmateError(`could not start the agent command ${JSON.stringify(command)}: ${error.message}. Set "agent" in ${joinPath(defaultHome(), "config.json")}`));
      });
    });
    child.on("close", (code) => {
      settle(() => {
        if (ended === "timed out") {
          reject(new DeskmateError(`the agent did not finish within ${String(AGENT_TIMEOUT)} seconds`));
        } else if (ended === "cancelled") {
          reject(new AgentCancelledError("the agent was stopped"));
        } else if (code !== 0) {
          reject(new DeskmateError(`the agent exited with status ${String(code)}: ${(err === "" ? out : err).trim().slice(-500)}`));
        } else {
          resolve(out.trim());
        }
      });
    });
  });
