/** The player-two command: one-shot commands for scripts and agents, and the hub. One program, so one file to ship. */

import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { chatOf, mayCome } from "../core/chat.ts";
import type { Entry, Message } from "../core/chat.ts";
import { readContent } from "../core/kinds.ts";
import { noteLink, noteOf } from "../core/links.ts";
import { problemOf } from "../core/text.ts";
import { channelSchema, commandLineOf, defaultAgentOf, fitText, isChannel, ownerOf } from "../core/wire.ts";
import type { ChannelInfo, Delivered, Event } from "../core/wire.ts";
import { DEFAULT_PRESET, oneshotAgent, PRESETS } from "../desk/agents/presets.ts";
import { defaultDev, defaultHome, http, join, loadClient, PlayerTwoError } from "../desk/client.ts";
import type { Client, Transport } from "../desk/client.ts";
import { runChecks } from "../desk/doctor.ts";
import { runDesk } from "../desk/main.ts";
import { agentOf, ask, glance, readNote, trust } from "../desk/notes.ts";
import type { Agent, Asked } from "../desk/notes.ts";
import { runHub, verifyHub } from "../hub/main.ts";
import { createServer } from "../mcp/server.ts";
import type { Check } from "../shared/ipc.ts";

const INBOX = 20; // Messages and answers `inbox` prints when it is not told where to start.

const USAGE = `usage: player-two COMMAND

  join HUB NAME TOKEN [--agent AGENT]   register your name and a new key with a hub
  send TO TEXT... [--wait SECONDS]      send a message to a name or a channel such as '#backend'; a TEXT of - reads it from standard input
  inbox [--after SEQ] [--wait SECONDS]  print the messages and agents' answers other people sent you or your channels
  who                                   list everyone who has joined
  repos                                 list every agent as @person/repo with the branch it is on
  search WORDS... [--in CHAT]           find the messages and answers that hold every word, in every chat or in one, each with its link
  read NOTE [--thread]                  print one note, given as its link or id, as it reads now, where each agent it tags stands, their answers, and with --thread its replies
  ask @PERSON/REPO TEXT... [--in CHANNEL] [--wait SECONDS]
                                        ask an agent, in the direct chat with its owner or in a channel, and print its answer once its owner has let it run; --wait defaults to 900
  status                                print the hub, your name, the repos you share and the requests waiting for your agents
  channel [join NAME | leave NAME]      list the channels, or join or leave one
  hub [--host HOST] [--port PORT]       run the hub; it reads PLAYER_TWO_JOIN_TOKEN, PLAYER_TWO_DB, PLAYER_TWO_REPOS and, if set, PLAYER_TWO_DOWNLOADS
  hub verify                            check that no event in the log in PLAYER_TWO_DB was changed or taken out since it was stored
  desk                                  run your side with no window, for the window to start: it speaks JSON lines on standard input and output
  mcp [--allow-send]                    run the MCP server, for an agent's editor to start: the chat as tools, over standard input and output; --allow-send adds sending, asking and withdrawing
  doctor                                check what Player Two needs on this machine, and say how to fix what is missing

send, inbox, who, repos, channel, search, read, ask, status and doctor take --json, and then print one JSON value and nothing else.
A command exits with 0 on success, 1 after printing a failure, and 2 when it was not given what it takes.
ask also exits with 3 when the owner declined, 4 when the run failed, was stopped or was withdrawn, and 5 when nothing final came in time.
--wait takes at most 86400 seconds, a day.`;

/** The command was not given what it takes. The usage is printed, and the exit status says so. */
class UsageError extends Error {}

/** A command did what it was asked, and what came of it was not what was hoped for: `status` is the exit status that says which outcome it was. */
class Ended extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
  readonly env?: Readonly<Record<string, string | undefined>>; // Where an agent's run says which agent it is (see agentEnv); this process's environment when not given.
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

const MAX_WAIT = 86_400; // Most seconds a --wait may be: a day. Node fires a timer set further off than 2^31 ms, about 24.8 days, at once.

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

/** The seconds a --wait was given, at most a day. */
function waitOf(given: string): number {
  const seconds = numberOf(secondsSchema, given, "wait");
  if (seconds > MAX_WAIT) {
    throw new UsageError(`--wait takes at most ${String(MAX_WAIT)} seconds, a day, not ${given}`);
  }
  return seconds;
}

/** Print what a command found: the thing itself as one line of JSON when --json was given, and otherwise in words. */
function show(out: (line: string) => void, json: boolean, found: unknown, words: string): void {
  out(json ? JSON.stringify(found) : words);
}

/**
 * An entry as --json prints it: as the hub delivered it, with whether it is trusted, and with its `content` null when it is not.
 * A script or an agent reading the JSON gets no more of a note that failed its signature check than a person reading the words does.
 */
function vouched(entry: Entry): Omit<Entry, "event"> & { readonly event: Omit<Event, "content"> & { readonly content: string | null } } {
  return entry.trusted ? entry : { ...entry, event: { ...entry.event, content: null } };
}

/** What a message or an agent's answer says, and which agent's answer it is; null for an event of any other kind, or one the fold counts for nothing from its author, which the inbox passes over. */
function saying(event: Event): { readonly text: string; readonly agent: string | null } | null {
  const said = readContent(event);
  if (!mayCome(event, said)) {
    return null;
  }
  if (said.kind === "message") {
    return { text: said.content.text, agent: null };
  }
  return said.kind === "job.result" ? { text: said.content.text, agent: said.content.repo } : null;
}

/**
 * One message or answer as the terminal shows it, numbered by its seq, which `inbox --after` takes. One that failed its signature check is never shown with its text.
 * Cited, as `search` and `read` show a note, it shows `cite.text` in place of what the event says, says whom the reader's own message in a direct chat went to, and ends with the note's link.
 */
export function render(delivered: Delivered, trusted: boolean, cite: { readonly me: string; readonly text: string } | null = null): string {
  const { seq, event } = delivered;
  if (!trusted) {
    return `!! ${String(seq)} claims to be from ${event.author}, but its signature does not match the key first seen for them. Ignored.`;
  }
  const said = saying(event);
  const when = new Date(event.ts * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }); // "Fri 14:05", in this machine's own time.
  const lines = (cite?.text ?? said?.text ?? `(${event.kind})`).split(/\r\n|\r|\n/).map((line) => `│ ${line}`);
  const agent = said?.agent ?? null;
  const writer = ownerOf(event.author); // An agent's answer under its owner's name, as the window shows it.
  let where = isChannel(event.to) ? ` in ${event.to}` : "";
  if (cite?.me === writer && where === "") {
    where = ` to ${event.to}`;
  }
  return [`┌ ${String(seq)} · ${writer}${agent === null ? "" : ` (${agent} agent)`}${where} · ${when}`, ...lines, cite === null ? "└" : `└ ${noteLink(event.id)}`].join("\n");
}

/** The setup check as aligned text: how each item stands, what was checked and what was found, and under one that is not right, the fix to copy. */
function layout(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.title.length));
  return checks.flatMap((check) => [`${check.status.padEnd(4)}  ${check.title.padEnd(width)}  ${check.detail}`, ...(check.fix === "" ? [] : [`      fix: ${check.fix}`])]).join("\n");
}

/** The messages and answers among what the hub delivered that someone else sent, as delivered, each with whether it holds under the key first seen for its author. */
function fromOthers(client: Client, found: readonly Delivered[]): Promise<Entry[]> {
  return trust(
    client,
    found.filter((delivered) => ownerOf(delivered.event.author) !== client.config.name && saying(delivered.event) !== null)
  );
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
  const seconds = waitOf(values.wait);
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
  const wait = waitOf(values.wait);
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
  show(out, values.json, found.map(vouched), found.length === 0 ? "no messages" : found.map((each) => render(each, each.trusted)).join("\n"));
}

/** Print the messages and answers that hold every word given, best match first, each with a stretch of its text as last edited and its link. */
async function search(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { in: { type: "string" }, json: { type: "boolean", default: false } } });
  if (positionals.length === 0) {
    throw new UsageError("search takes the words to look for");
  }
  const client = joined();
  const q = positionals.join(" ");
  const found = (await client.search(values.in === undefined ? { q } : { q, chat: values.in })).filter((match) => mayCome(match.event)); // As the fold, which shows one an agent may not send nowhere.
  const trusted = await trust(client, found);
  const matches = found.map((match, index) => ({ ...match, trusted: trusted[index]?.trusted ?? false, link: noteLink(match.event.id) }));
  const words = matches.map((match) => render(match, match.trusted, { me: client.config.name, text: match.snippet.map((piece) => piece.text).join("") }));
  const json = matches.map((match) => ({ ...vouched(match), snippet: match.trusted ? match.snippet : null, link: match.link })); // The snippet is a stretch of the same text.
  show(out, values.json, json, words.length === 0 ? "nothing found" : words.join("\n"));
}

/** A note as `read --json` prints it: as --json prints any entry, with its link, and its text as last edited, null when it is not a message or an answer or its signature fails. */
function shown(entry: Entry, message: Message | null): ReturnType<typeof vouched> & { readonly link: string; readonly text: string | null; readonly edited: boolean; readonly deleted: boolean } {
  return { ...vouched(entry), link: noteLink(entry.event.id), text: message?.text ?? null, edited: message?.edited ?? false, deleted: message?.deleted ?? false };
}

/** A note as `read` shows it in words: what it says now, edits applied. */
function cited(client: Client, entry: Entry, message: Message | null): string {
  let text = saying(entry.event)?.text ?? `(${entry.event.kind})`;
  if (message !== null) {
    text = message.deleted ? "(message deleted)" : `${message.text}${message.edited ? "\n(edited)" : ""}`;
  }
  return render(entry, entry.trusted, { me: client.config.name, text });
}

/** Print one note as it reads now, where each agent it tags stands, and their answers; with --thread, the replies under it too. */
async function read(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { thread: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });
  const [given = ""] = positionals;
  const id = noteOf(given) ?? noteOf(noteLink(given));
  if (id === null || positionals.length > 1) {
    throw new UsageError("read takes one note, as its player-two://note/ link or its id");
  }
  const client = joined();
  const note = await readNote(client, id);
  if (note === null) {
    throw new PlayerTwoError("there is no note with that id that you can see");
  }
  const { entry, message, jobs, answers } = note;
  const replies = values.thread ? (message?.replies ?? []) : [];
  const found = {
    ...shown(entry, message),
    jobs: jobs.map((job) => ({ agent: `${job.owner}/${job.repo}`, state: job.state })),
    answers: answers.map((answer) => shown(answer.entry, answer)),
    ...(values.thread ? { replies: replies.map((reply) => shown(reply.entry, reply)) } : {})
  };
  const words = [cited(client, entry, message), ...jobs.map((job) => `@${job.owner}/${job.repo}: ${job.state}`), ...[...answers, ...replies].map((each) => cited(client, each.entry, each))];
  show(out, values.json, found, words.join("\n"));
}

/** Print the hub, the user's name, the repos they share, and the requests waiting for their agents in what the window would load of each chat. */
async function status(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { json } = parseArgs({ args, options: { json: { type: "boolean", default: false } } }).values;
  const client = joined();
  const me = client.config.name;
  const [{ log, rows }, team] = await Promise.all([glance(client), client.repos()]);
  const mine = team.filter((repo) => repo.user === me);
  const waiting = rows.flatMap((row) => log.waitingForMe(row.chat, client.now()));
  const found = { hub: client.config.hub, name: me, repos: mine, waiting: waiting.map((request) => ({ agent: `${request.owner}/${request.repo}`, ...shown(request.message.entry, request.message) })) };
  const words = [
    `hub: ${client.config.hub}`,
    `name: ${me}`,
    `repos: ${mine.length === 0 ? "none yet; repos under ~/dev are shared once the window has run" : mine.map((repo) => `${repo.name} (${repo.branch})`).join(", ")}`,
    `waiting for your agents: ${waiting.length === 0 ? "nothing" : String(waiting.length)}`,
    ...waiting.map((request) => cited(client, request.message.entry, request.message))
  ];
  show(out, json, found, words.join("\n"));
}

/** A channel, given with or without its "#"; null when that is no channel's name. */
function channelNamed(name: string): string | null {
  const channel = channelSchema.safeParse(name.startsWith("#") ? name : `#${name}`);
  return channel.success ? channel.data : null;
}

/** What came of an ask that was not answered, as the exit status that says so and words that say what to do; null when it was answered. */
function unanswered(asked: Asked, agent: Agent, seconds: number): Ended | null {
  const tagged = `@${agent.owner}/${agent.repo}`;
  const link = noteLink(asked.sent.event.id);
  switch (asked.state) {
    case "answered":
      return null;
    case "declined":
      return new Ended(3, `${agent.owner} declined to run ${tagged}: ${link}`);
    case "failed":
    case "stopped":
    case "withdrawn":
      return new Ended(4, `${tagged} ${asked.state === "failed" ? "failed" : `was ${asked.state}`}: ${link}`);
    case "working":
    case "waiting": {
      const now = asked.state === "working" ? `${tagged} is working on it` : `it is waiting for ${agent.owner} to let ${tagged} run`;
      return new Ended(5, `nothing final within ${String(seconds)} seconds: ${now}. Check later with:\nplayer-two read ${link}`);
    }
  }
}

/** Ask an agent and wait for that one request to end: print the answer, or end with the exit status that says what happened instead. */
async function askAgent(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { in: { type: "string" }, wait: { type: "string", default: "900" }, json: { type: "boolean", default: false } } });
  const [given = "", ...words] = positionals;
  const agent = agentOf(given);
  const seconds = waitOf(values.wait);
  const channel = values.in === undefined ? agent?.owner : channelNamed(values.in);
  if (agent === null || words.length === 0) {
    throw new UsageError("ask takes an agent, as @person/repo, and what to ask it");
  }
  if (channel === null || channel === undefined) {
    throw new UsageError(`--in takes a channel, such as '#backend', not ${values.in ?? ""}`);
  }
  const asked = await ask(joined(), agent, channel, words.join(" "), "cli", seconds);
  if (values.json) {
    out(JSON.stringify(asked.answer?.entry ?? null)); // The answer as the hub delivered it, with whether it is trusted; null when there is none.
  } else if (asked.answer !== null) {
    out(asked.answer.text);
  }
  const ended = unanswered(asked, agent, seconds);
  if (ended !== null) {
    throw ended;
  }
}

/** Join or leave a channel, given with or without its "#", unless the user is already in it or already out of it, and return it as the hub then reports it. */
async function joinOrLeave(client: Client, action: "join" | "leave", name: string): Promise<ChannelInfo> {
  const channel = channelNamed(name);
  if (channel === null) {
    throw new PlayerTwoError("a channel's name is lowercase letters, digits, - and _, at most 32 characters");
  }
  const found = async (): Promise<ChannelInfo> => (await client.channels()).find((each) => each.name === channel) ?? { name: channel, members: [], repo: null, branch: null }; // A channel everyone has left is not listed.
  if ((await found()).members.includes(client.config.name) !== (action === "join")) {
    await client.publish(channel, action === "join" ? "channel.join" : "channel.leave", {});
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
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { agent: { type: "string", default: DEFAULT_PRESET.id } } });
  const [hub, name, token] = positionals;
  if (hub === undefined || name === undefined || token === undefined || positionals.length > 3) {
    throw new UsageError("join takes the hub's address, your name and the join token");
  }
  // A preset by its id, or else a one-shot command typed as one line.
  const config = await join(home, hub, name, token, PRESETS.find((preset) => preset.id === values.agent) ?? oneshotAgent(values.agent), transport);
  const agent = defaultAgentOf(config);
  out(`joined ${config.hub} as ${config.name}; your agent is ${agent.label}, \`${commandLineOf(agent)}\``);
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

async function who(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { json } = parseArgs({ args, options: { json: { type: "boolean", default: false } } }).values;
  const client = joined();
  const people = await client.users();
  show(out, json, people, people.map((user) => `${user.name}${user.name === client.config.name ? " (you)" : ""}`).join("\n"));
}

async function repos(joined: () => Client, args: string[], out: (line: string) => void): Promise<void> {
  const { json } = parseArgs({ args, options: { json: { type: "boolean", default: false } } }).values;
  const team = await joined().repos();
  const lines = team.map((repo) => `@${repo.user}/${repo.name}  ${repo.branch}`);
  show(out, json, team, lines.length === 0 ? "nobody has shared a repo yet; repos under ~/dev are shared once the window has run" : lines.join("\n"));
}

/** Serve the chat to an agent's editor over MCP until it closes standard input: to read, and with --allow-send to send and ask as well. */
async function mcp(joined: () => Client, args: string[]): Promise<void> {
  const allowSend = parseArgs({ args, options: { "allow-send": { type: "boolean", default: false } } }).values["allow-send"];
  const client = joined();
  globalThis.console = new console.Console(process.stderr); // Standard output carries the protocol's messages and nothing else, as for the desk.
  await createServer(client, allowSend).connect(new StdioServerTransport());
}

/** The commands that act as the person who joined from here, by name. */
const AS_USER = new Map<string, (joined: () => Client, args: string[], out: (line: string) => void, options: Options) => Promise<void>>([
  ["send", (joined, args, out, options) => send(joined, args, out, options.stdin)],
  ["inbox", inbox],
  ["channel", channel],
  ["who", who],
  ["repos", repos],
  ["search", search],
  ["read", read],
  ["ask", askAgent],
  ["status", status],
  ["mcp", mcp]
]);

async function run(argv: readonly string[], options: Options, out: (line: string) => void): Promise<void> {
  const [command = "", ...args] = argv;
  const home = options.home ?? defaultHome();
  const transport = options.transport ?? http;
  // As the person who joined from here; or, in an agent's run, as that agent, so that what it does through the command or the MCP server is the agent's and not its owner's.
  const joined = (): Client => {
    const client = loadClient(home, transport, options.now ?? (() => Date.now() / 1000), options.env ?? process.env);
    if (client === null) {
      throw new PlayerTwoError("not joined yet: run `player-two join HUB NAME TOKEN`");
    }
    return client.greeting(); // A hub on another protocol is told apart from an answer that cannot be read.
  };
  const asUser = AS_USER.get(command);
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
    default:
      if (asUser === undefined) {
        throw new UsageError(command === "" ? "which command?" : `no such command: ${command}`);
      }
      await asUser(joined, args, out, options);
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
    if (error instanceof Ended) {
      err(`player-two: ${error.message}`);
      return error.status;
    }
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
