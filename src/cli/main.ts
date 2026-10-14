/** The deskmate command: one-shot commands for scripts and agents, and the hub. One program, so one file to ship. */

import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

import { z } from "zod";

import { chatOf } from "../core/chat.ts";
import { isChannel } from "../core/wire.ts";
import type { Delivered } from "../core/wire.ts";
import { DEFAULT_AGENT, defaultHome, DeskmateError, http, join, loadClient, POLL_WAIT } from "../desk/client.ts";
import type { Client, Transport } from "../desk/client.ts";
import { problemOf } from "../desk/session.ts";
import { runHub } from "../hub/main.ts";

const INBOX = 20; // Notes `inbox` prints when it is not told where to start.

const USAGE = `usage: deskmate COMMAND

  join HUB NAME TOKEN [--agent AGENT]   register your name and a new key with a hub
  send TO TEXT... [--wait SECONDS]      send a note to a name or a channel such as '#backend'; a TEXT of - reads it from standard input
  inbox [--after ID] [--wait SECONDS]   print the notes other people sent you or your channels
  who                                   list everyone who has joined
  repos                                 list every agent as @person/repo with the branch it is on
  channel [join NAME | leave NAME]      list the channels, or join or leave one
  hub [--host HOST] [--port PORT]       run the hub; it reads DESKMATE_JOIN_TOKEN, DESKMATE_DB and DESKMATE_REPOS

send, inbox, who, repos and channel take --json, and then print one JSON value and nothing else.
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
  readonly stdin?: NodeJS.ReadableStream; // Where `send TO -` reads the note from.
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

// An argument is text whatever it stands for, so a number is checked before anything is sent.
const secondsSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform(Number);
const idSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.int());

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

/** One note as the terminal shows it. One that failed its signature check is never shown with its text. */
export function render(delivered: Delivered, trusted: boolean): string {
  const { id, note } = delivered;
  if (!trusted) {
    return `!! note ${String(id)} claims to be from ${note.sender}, but its signature does not match the key first seen for them. Ignored.`;
  }
  const when = new Date(note.ts * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }); // "Fri 14:05", in this machine's own time.
  const lines = note.body.split(/\r\n|\r|\n/).map((line) => `│ ${line}`);
  return [`┌ ${String(id)} · ${note.sender}${note.agent === null ? "" : ` (${note.agent} agent)`}${isChannel(note.to) ? ` in ${note.to}` : ""} · ${when}`, ...lines, "└"].join("\n");
}

/** The next trusted note from someone else in this chat, if one arrives in time. */
async function awaitReply(client: Client, chat: string, sent: number, seconds: number): Promise<Delivered | null> {
  const deadline = performance.now() + seconds * 1000;
  let after = sent;
  for (let remaining = seconds; remaining > 0; remaining = (deadline - performance.now()) / 1000) {
    for (const delivered of await client.notes({ after, wait: Math.min(remaining, POLL_WAIT), mine: false, status: false })) {
      after = delivered.id;
      if (chatOf(delivered.note, client.config.name) === chat && (await client.isTrusted(delivered.note))) {
        return delivered;
      }
    }
  }
  return null;
}

async function send(joined: () => Client, args: string[], stdin: NodeJS.ReadableStream, out: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { wait: { type: "string", default: "0" }, json: { type: "boolean", default: false } } });
  const [to, ...words] = positionals;
  const seconds = numberOf(secondsSchema, values.wait, "wait");
  if (to === undefined || words.length === 0) {
    throw new UsageError("send takes who it is to and the note");
  }
  const client = joined();
  const sent = await client.send(to, words.length === 1 && words[0] === "-" ? (await text(stdin)).trim() : words.join(" "));
  if (!values.json) {
    out(`→ sent ${String(sent)} to ${to}`);
  }
  if (seconds > 0) {
    // With --json the one value is the reply as the hub delivered it, or null when none came; without --wait it is the hub's receipt for what was sent.
    const reply = await awaitReply(client, to, sent, seconds);
    const words = reply === null ? `nothing new in ${to} yet; check later with: deskmate inbox --after ${String(sent)}` : render(reply, true);
    show(out, values.json, reply === null ? null : { ...reply, trusted: true }, words);
  } else if (values.json) {
    out(JSON.stringify({ id: sent }));
  }
}

async function inbox(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { values } = parseArgs({ args, options: { after: { type: "string" }, wait: { type: "string", default: "0" }, json: { type: "boolean", default: false } } });
  const wait = numberOf(secondsSchema, values.wait, "wait");
  const after = values.after === undefined ? null : numberOf(idSchema, values.after, "after");
  const client = joined();
  const notes = after === null ? await client.notes({ tail: INBOX, mine: false, status: false }) : await client.notes({ after, wait, mine: false, status: false });
  const found: (Delivered & { readonly trusted: boolean })[] = [];
  for (const delivered of notes) {
    found.push({ ...delivered, trusted: await client.isTrusted(delivered.note) });
  }
  show(out, values.json, found, found.length === 0 ? "no notes" : found.map((each) => render(each, each.trusted)).join("\n"));
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
    throw new DeskmateError(`which channel? Try: deskmate channel ${action} backend`);
  }
  const info = action === "join" ? await client.joinChannel(name) : await client.leaveChannel(name);
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

async function run(argv: readonly string[], options: Options, out: (line: string) => void): Promise<void> {
  const [command = "", ...args] = argv;
  const home = options.home ?? defaultHome();
  const transport = options.transport ?? http;
  const joined = (): Client => {
    const client = loadClient(home, transport, options.now ?? (() => Date.now() / 1000));
    if (client === null) {
      throw new DeskmateError("not joined yet: run `deskmate join HUB NAME TOKEN`");
    }
    return client;
  };
  switch (command) {
    case "hub":
      runHub(args, process.env); // It keeps the program alive from here, until it is told to stop.
      break;
    case "join":
      await register(home, transport, args, out);
      break;
    case "send":
      await send(joined, args, options.stdin ?? process.stdin, out);
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
      err(`deskmate: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    err(`deskmate: ${problemOf(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
