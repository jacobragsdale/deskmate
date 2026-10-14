/** The player-two command: one-shot commands for scripts and agents, and the hub. One program, so one file to ship. */

import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

import { z } from "zod";

import { chatOf } from "../core/chat.ts";
import type { Entry } from "../core/chat.ts";
import { readContent } from "../core/kinds.ts";
import { problemOf } from "../core/text.ts";
import { channelSchema, fitText, isChannel } from "../core/wire.ts";
import type { ChannelInfo, Delivered, Event } from "../core/wire.ts";
import { DEFAULT_AGENT, defaultDev, defaultHome, http, join, loadClient, PlayerTwoError } from "../desk/client.ts";
import type { Client, Transport } from "../desk/client.ts";
import { runChecks } from "../desk/doctor.ts";
import { runDesk } from "../desk/main.ts";
import { runHub, verifyHub } from "../hub/main.ts";
import type { Check } from "../shared/ipc.ts";

const INBOX = 20; // Messages and answers `inbox` prints when it is not told where to start.

const USAGE = `usage: player-two COMMAND

  join HUB NAME TOKEN [--agent AGENT]   register your name and a new key with a hub
  send TO TEXT... [--wait SECONDS]      send a message to a name or a channel such as '#backend'; a TEXT of - reads it from standard input
  inbox [--after SEQ] [--wait SECONDS]  print the messages and agents' answers other people sent you or your channels
  who                                   list everyone who has joined
  repos                                 list every agent as @person/repo with the branch it is on
  channel [join NAME | leave NAME]      list the channels, or join or leave one
  hub [--host HOST] [--port PORT]       run the hub; it reads PLAYER_TWO_JOIN_TOKEN, PLAYER_TWO_DB, PLAYER_TWO_REPOS and, if set, PLAYER_TWO_DOWNLOADS
  hub verify                            check that no event in the log in PLAYER_TWO_DB was changed or taken out since it was stored
  desk                                  run your side with no window, for the window to start: it speaks JSON lines on standard input and output
  doctor                                check what Player Two needs on this machine, and say how to fix what is missing

send, inbox, who, repos, channel and doctor take --json, and then print one JSON value and nothing else.
A command exits with 0 on success, 1 after printing a failure, and 2 when it was not given what it takes.`;

/** The command was not given what it takes. The usage is printed, and the exit status says so. */
class UsageError extends Error {}

/** Whether a failure is the command line's fault: one of ours, or one parseArgs raises for an option it does not know or a word it did not expect. */
function isUsage(error: unknown): error is Error {
  return error instanceof UsageError || (error instanceof TypeError && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_"));
}

/** Where the command finds things and where it writes. The defaults are the real ones; a test passes its own. */
export interface Options {
  readonly home?: string; // The folder the identity is in.
  readonly transport?: Transport;
  readonly now?: () => number; // Unix seconds.
  readonly stdin?: NodeJS.ReadableStream; // Where `send TO -` reads the message from.
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

// An argument is text whatever it stands for, so a number is checked before anything is sent.
const secondsSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform(Number);
const seqSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.int());

function numberOf(schema: z.ZodType<number>, given: string, option: string): number {
  const result = schema.safeParse(given);
  if (!result.success) {
    throw new UsageError(`--${option} takes a number, not ${given}`);
  }
  return result.data;
}

/** Print what a command found: the thing itself as one line of JSON when --json was given, and otherwise in words. */
function show(out: (line: string) => void, json: boolean, found: unknown, words: string): void {
  out(json ? JSON.stringify(found) : words);
}

/** What a message or an agent's answer says, and which agent's answer it is; null for an event of any other kind, which the inbox passes over as status notes were. */
function saying(event: Event): { readonly text: string; readonly agent: string | null } | null {
  const said = readContent(event);
  if (said.kind === "message") {
    return { text: said.content.text, agent: null };
  }
  return said.kind === "job.result" ? { text: said.content.text, agent: said.content.repo } : null;
}

/** One message or answer as the terminal shows it, numbered by its seq, which `inbox --after` takes. One that failed its signature check is never shown with its text. */
export function render(delivered: Delivered, trusted: boolean): string {
  const { seq, event } = delivered;
  if (!trusted) {
    return `!! ${String(seq)} claims to be from ${event.author}, but its signature does not match the key first seen for them. Ignored.`;
  }
  const said = saying(event);
  const when = new Date(event.ts * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }); // "Fri 14:05", in this machine's own time.
  const lines = (said?.text ?? `(${event.kind})`).split(/\r\n|\r|\n/).map((line) => `│ ${line}`);
  const agent = said?.agent ?? null;
  return [`┌ ${String(seq)} · ${event.author}${agent === null ? "" : ` (${agent} agent)`}${isChannel(event.to) ? ` in ${event.to}` : ""} · ${when}`, ...lines, "└"].join("\n");
}

/** The setup check as aligned text: how each item stands, what was checked and what was found, and under one that is not right, the fix to copy. */
function layout(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.title.length));
  return checks.flatMap((check) => [`${check.status.padEnd(4)}  ${check.title.padEnd(width)}  ${check.detail}`, ...(check.fix === "" ? [] : [`      fix: ${check.fix}`])]).join("\n");
}

/** The messages and answers among what the hub delivered that someone else sent, as delivered, each with whether it holds under the key first seen for its author. */
async function fromOthers(client: Client, found: readonly Delivered[]): Promise<Entry[]> {
  const kept: Entry[] = [];
  for (const delivered of found) {
    if (delivered.event.author !== client.config.name && saying(delivered.event) !== null) {
      kept.push({ ...delivered, trusted: await client.isTrusted(delivered.event) });
    }
  }
  return kept;
}

/** The first messages and answers from someone else after `after` that `wanted` keeps, from the hub's stream as soon as there are any; none once `seconds` have passed. */
async function next(client: Client, after: number, seconds: number, wanted: (entry: Entry) => boolean): Promise<Entry[]> {
  const stop = new AbortController();
  const timer = setTimeout(() => {
    stop.abort();
  }, seconds * 1000);
  let found: Entry[] = [];
  await client.stream(
    after,
    async (batch) => {
      found = (await fromOthers(client, batch)).filter(wanted);
      if (found.length > 0) {
        stop.abort();
      }
    },
    stop.signal
  );
  clearTimeout(timer);
  return found;
}

/** The newest `count` messages and answers from someone else, looking back from the hub's newest seq four times as far each time until there are enough or there is nothing further back. */
async function newest(client: Client, count: number): Promise<Entry[]> {
  const { seq } = await client.head();
  for (let span = count * 10; ; span *= 4) {
    const after = Math.max(0, seq - span);
    const found = await fromOthers(client, await client.catchUp(after));
    if (found.length >= count || after === 0) {
      return found.slice(-count);
    }
  }
}

async function send(joined: () => Client, args: string[], out: (line: string) => void, stdin: NodeJS.ReadableStream = process.stdin): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { wait: { type: "string", default: "0" }, json: { type: "boolean", default: false } } });
  const [to, ...words] = positionals;
  const seconds = numberOf(secondsSchema, values.wait, "wait");
  if (to === undefined || words.length === 0) {
    throw new UsageError("send takes who it is to and the message");
  }
  const client = joined();
  const message = fitText(words.length === 1 && words[0] === "-" ? (await text(stdin)).trim() : words.join(" "));
  if (message === "") {
    throw new PlayerTwoError("there is nothing to send");
  }
  const sent = await client.publish(to, "message", { text: message, via: "cli" });
  if (!values.json) {
    out(`→ sent ${String(sent.seq)} to ${to}`);
  }
  if (seconds > 0) {
    // With --json the one value is the reply as the hub delivered it with whether it is trusted, or null when none came; without --wait it is the message as sent, with its place in the hub's log.
    const [reply] = await next(client, sent.seq, seconds, (entry) => entry.trusted && chatOf(entry.event, client.config.name) === to);
    const words = reply === undefined ? `nothing new in ${to} yet; check later with: player-two inbox --after ${String(sent.seq)}` : render(reply, true);
    show(out, values.json, reply ?? null, words);
  } else if (values.json) {
    out(JSON.stringify(sent));
  }
}

async function inbox(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { values } = parseArgs({ args, options: { after: { type: "string" }, wait: { type: "string", default: "0" }, json: { type: "boolean", default: false } } });
  const wait = numberOf(secondsSchema, values.wait, "wait");
  const after = values.after === undefined ? null : numberOf(seqSchema, values.after, "after");
  const client = joined();
  let found: Entry[];
  if (after === null) {
    found = await newest(client, INBOX);
  } else {
    const caught = await client.catchUp(after);
    found = await fromOthers(client, caught);
    if (found.length === 0 && wait > 0) {
      found = await next(client, caught.at(-1)?.seq ?? after, wait, () => true);
    }
  }
  show(out, values.json, found, found.length === 0 ? "no messages" : found.map((each) => render(each, each.trusted)).join("\n"));
}

/** Join or leave a channel, given with or without its "#", unless the user is already in it or already out of it, and return it as the hub then reports it. */
async function joinOrLeave(client: Client, action: "join" | "leave", name: string): Promise<ChannelInfo> {
  const channel = channelSchema.safeParse(name.startsWith("#") ? name : `#${name}`);
  if (!channel.success) {
    throw new PlayerTwoError("a channel's name is lowercase letters, digits, - and _, at most 32 characters");
  }
  const found = async (): Promise<ChannelInfo> => (await client.channels()).find((each) => each.name === channel.data) ?? { name: channel.data, members: [], repo: null, branch: null }; // A channel everyone has left is not listed.
  if ((await found()).members.includes(client.config.name) !== (action === "join")) {
    await client.publish(channel.data, action === "join" ? "channel.join" : "channel.leave", {});
  }
  return found();
}

async function channel(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
  const [action = "list", name] = positionals;
  if (action !== "list" && action !== "join" && action !== "leave") {
    throw new UsageError(`channel takes list, join or leave, not ${action}`);
  }
  const client = joined();
  if (action === "list") {
    const channels = await client.channels();
    const lines = channels.map((each) => `${each.name}${each.members.includes(client.config.name) ? " (joined)" : ""}  ${each.members.join(", ")}`);
    show(out, values.json, channels, lines.length === 0 ? "no channels yet" : lines.join("\n"));
    return;
  }
  if (name === undefined) {
    throw new PlayerTwoError(`which channel? Try: player-two channel ${action} backend`);
  }
  const info = await joinOrLeave(client, action, name);
  show(out, values.json, info, `${action === "join" ? "joined" : "left"} ${info.name}; members: ${info.members.length === 0 ? "none" : info.members.join(", ")}`);
}

async function register(home: string, transport: Transport, args: string[], out: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { agent: { type: "string", default: DEFAULT_AGENT } } });
  const [hub, name, token] = positionals;
  if (hub === undefined || name === undefined || token === undefined || positionals.length > 3) {
    throw new UsageError("join takes the hub's address, your name and the join token");
  }
  const config = await join(home, hub, name, token, values.agent, transport);
  out(`joined ${config.hub} as ${config.name}; your agent command is \`${config.agent}\``);
}

/** Print the setup check, and fail when any of it failed: what is printed is the list, and the exit status says whether it is all right. */
async function doctor(home: string, args: string[], out: (line: string) => void): Promise<void> {
  const { json } = parseArgs({ args, options: { json: { type: "boolean", default: false } } }).values;
  const checks = await runChecks(home, defaultDev());
  show(out, json, checks, layout(checks));
  const failed = checks.filter((check) => check.status === "fail").length;
  if (failed > 0) {
    throw new PlayerTwoError(`${String(failed)} ${failed === 1 ? "check" : "checks"} failed`);
  }
}

/** Run the hub, or with `verify`, check the chain of its log and say that it holds. */
function hub(args: string[], out: (line: string) => void): void {
  if (args[0] === "verify") {
    out(verifyHub(process.env));
  } else {
    runHub(args, process.env); // It keeps the program alive from here, until it is told to stop.
  }
}

async function run(argv: readonly string[], options: Options, out: (line: string) => void): Promise<void> {
  const [command = "", ...args] = argv;
  const home = options.home ?? defaultHome();
  const transport = options.transport ?? http;
  const joined = (): Client => {
    const client = loadClient(home, transport, options.now ?? (() => Date.now() / 1000));
    if (client === null) {
      throw new PlayerTwoError("not joined yet: run `player-two join HUB NAME TOKEN`");
    }
    return client;
  };
  switch (command) {
    case "hub":
      hub(args, out);
      break;
    case "desk":
      globalThis.console = new console.Console(process.stderr); // Standard output carries the protocol's lines and nothing else, so whatever anything logs goes to standard error.
      await runDesk(process.stdin, process.stdout);
      break;
    case "join":
      await register(home, transport, args, out);
      break;
    case "doctor":
      await doctor(home, args, out);
      break;
    case "send":
      await send(joined, args, out, options.stdin);
      break;
    case "inbox":
      await inbox(joined, args, out);
      break;
    case "channel":
      await channel(joined, args, out);
      break;
    case "who": {
      const { json } = parseArgs({ args, options: { json: { type: "boolean", default: false } } }).values;
      const client = joined();
      const people = await client.users();
      show(out, json, people, people.map((user) => `${user.name}${user.name === client.config.name ? " (you)" : ""}`).join("\n"));
      break;
    }
    case "repos": {
      const { json } = parseArgs({ args, options: { json: { type: "boolean", default: false } } }).values;
      const team = await joined().repos();
      const lines = team.map((repo) => `@${repo.user}/${repo.name}  ${repo.branch}`);
      show(out, json, team, lines.length === 0 ? "nobody has shared a repo yet; repos under ~/dev are shared once the window has run" : lines.join("\n"));
      break;
    }
    default:
      throw new UsageError(command === "" ? "which command?" : `no such command: ${command}`);
  }
}

/** Run one command and resolve with its exit status: 0 when it worked, 1 after saying on standard error what went wrong, 2 when the command line itself was wrong. */
export async function main(argv: readonly string[], options: Options = {}): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  if (argv[0] === "--help" || argv[0] === "-h") {
    out(USAGE);
    return 0;
  }
  try {
    await run(argv, options, out);
    return 0;
  } catch (error) {
    if (isUsage(error)) {
      err(`player-two: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    err(`player-two: ${problemOf(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
