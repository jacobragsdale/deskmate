/**
 * Reading the chat for the command and the MCP server: a note with where the agents it tags stand and their answers; and asking an agent, then waiting for that one job to end.
 * Everything is folded as the window folds it (src/core/chat.ts), so an edit, a delete or a job's events count here exactly as they count there.
 */

import { ChatLog, chatOf, mayCome } from "../core/chat.ts";
import type { Entry, Message, Request, Row, State } from "../core/chat.ts";
import { checkRequest } from "../core/delegation.ts";
import { readContent } from "../core/kinds.ts";
import { fitText, isChannel, NAME, ownerOf, REPO_NAME } from "../core/wire.ts";
import type { Delivered } from "../core/wire.ts";
import { JOB_VAR } from "./agentKeys.ts";
import type { Client } from "./client.ts";

const PAGE = 200; // The most events the hub gives at once.
const GLANCE = 50; // Events of each chat a glance folds: what the window loads of each when it starts, so the two count alike.
const FINAL: ReadonlySet<State> = new Set(["answered", "declined", "failed", "stopped", "withdrawn"]); // Where an ask stops waiting. The owner may run a declined, failed or stopped request again, but the one who asked has had their answer.
const AGENT = new RegExp(`^@?(${NAME})/(${REPO_NAME})$`, "u"); // An agent named as @person/repo, the "@" optional.

/** One person's checkout of one repo. */
export interface Agent {
  readonly owner: string;
  readonly repo: string;
}

/** The agent named in `@person/repo` or `person/repo`; null for anything else. */
export function agentOf(given: string): Agent | null {
  const [, owner, repo] = AGENT.exec(given) ?? [];
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

/** Events as the hub delivered them, each with whether it holds under the key first seen for its author. One at a time, as the first look at a new author writes known.json. */
export async function trust(client: Client, found: readonly Delivered[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const delivered of found) {
    entries.push({ ...delivered, trusted: await client.isTrusted(delivered) });
  }
  return entries;
}

/** Every message and answer a chat shows, replies included, in the order the fold placed them. */
export function messagesIn(log: ChatLog, chat: string): Message[] {
  return log.items(chat).flatMap((item) => (item.kind === "message" ? [item.message, ...item.message.replies] : []));
}

/**
 * A chat's events from `seq` to its newest, oldest first, read a page at a time from the newest back.
 * ponytail: reads all of a chat after a note to find what was said about it; a hub route for the events that refer to one would be the upgrade if old notes in busy chats get slow.
 */
export async function chatFrom(client: Client, chat: string, seq: number): Promise<Entry[]> {
  const found: Delivered[] = [];
  for (;;) {
    const before = found.at(-1)?.seq;
    const page = await client.events(before === undefined ? { chat, limit: PAGE } : { chat, before, limit: PAGE });
    found.push(...page);
    if (page.length < PAGE || (page.at(-1)?.seq ?? 0) <= seq) {
      return trust(client, found.filter((delivered) => delivered.seq >= seq).reverse());
    }
  }
}

/** One note as it stands now. */
export interface Note {
  readonly entry: Entry; // As the hub delivered it.
  readonly chat: string;
  readonly message: Message | null; // As the fold has it, edits applied and replies under it; null when it is not a message or an answer, or its signature fails.
  readonly jobs: readonly Request[]; // The agents it tags and where each stands.
  readonly answers: readonly Message[]; // The agents' answers to it, oldest first.
}

/** A note by its event's id, with what has happened to it since: null when there is none this user can see. */
export async function readNote(client: Client, id: string): Promise<Note | null> {
  const found = await client.event(id);
  if (found === null || !mayCome(found.event)) {
    return null; // One the fold counts for nothing from its author is shown nowhere.
  }
  const chat = chatOf(found.event, client.config.name);
  const log = new ChatLog(client.config.name);
  const entries = await chatFrom(client, chat, found.seq);
  log.add(entries);
  const message = log.message(id);
  return {
    entry: entries.find((entry) => entry.event.id === id) ?? { ...found, trusted: await client.isTrusted(found) },
    chat,
    message,
    jobs: message === null ? [] : log.requests(message, client.now()),
    answers: messagesIn(log, chat).filter((each) => each.answers === id)
  };
}

/** Every chat this user has, as the window lists them, each folded from its newest events, with what is unread after the read marks given. */
export async function glance(client: Client, read: Readonly<Record<string, number>> = {}): Promise<{ readonly log: ChatLog; readonly rows: readonly Row[] }> {
  const [people, channels] = await Promise.all([client.users(), client.channels()]);
  const names = people.map((person) => person.name);
  const log = new ChatLog(client.config.name);
  const pages = await Promise.all(log.rows(channels, names, {}).map((row) => client.events({ chat: row.chat, limit: GLANCE })));
  log.add(await trust(client, pages.flat()));
  return { log, rows: log.rows(channels, names, read) };
}

/** How an ask ended: `answered`, with the answer; another final state; or `waiting` or `working` when nothing final came in time. */
export interface Asked {
  readonly sent: Delivered; // The request.
  readonly state: State;
  readonly answer: Message | null; // The agent's answer, when it is answered.
  readonly reason: string; // Why its owner declined it, when they said; "" otherwise.
}

/**
 * Ask an agent: publish a message in `chat` that tags it, then wait up to `seconds` for that one job to end. Nothing else said in the chat ends the wait.
 * It is a message like any other, so the tag waits for the agent's owner to act on it, or runs under a grant of theirs that names whoever asks; one the owner sends this way waits for them all the same: only a message typed in their own window runs at once.
 */
export async function ask(client: Client, agent: Agent, chat: string, text: string, via: "cli" | "mcp", seconds: number): Promise<Asked> {
  const sent = await client.publish(chat, "message", { text: fitText(`@${agent.owner}/${agent.repo} ${text}`), via });
  return waitFor(client, sent, chat, agent, seconds);
}

/** Wait up to `seconds` for the job `agent` was asked by `sent`, in `chat`, to end, from what the hub stores after it. */
async function waitFor(client: Client, sent: Delivered, chat: string, agent: Agent, seconds: number): Promise<Asked> {
  const { owner, repo } = agent;
  const me = client.config.name;
  const log = new ChatLog(me);
  const seen: Entry[] = [{ ...sent, trusted: true }];
  log.add(seen);
  const where = (): State => {
    const request = log.message(sent.event.id);
    return (request === null ? [] : log.requests(request, client.now())).find((job) => job.owner === owner && job.repo === repo)?.state ?? "waiting";
  };
  const stop = new AbortController();
  const timer = setTimeout(() => {
    stop.abort();
  }, seconds * 1000);
  await client.stream(
    sent.seq,
    async (batch) => {
      const entries = await trust(
        client,
        batch.filter((delivered) => chatOf(delivered.event, me) === chat)
      );
      seen.push(...entries);
      log.add(entries);
      if (FINAL.has(where())) {
        stop.abort();
      }
    },
    stop.signal
  );
  clearTimeout(timer);
  const state = where();
  // The answer that settled it: once a job is answered nothing moves it again, so it is the newest from the owner's agent to this request.
  const answer = state === "answered" ? messagesIn(log, chat).findLast((each) => each.answers === sent.event.id && each.agent === repo && ownerOf(each.entry.event.author) === owner) : undefined;
  const declined = seen.findLast(({ trusted, event }) => trusted && event.author === owner && event.kind === "job.declined" && event.refs[0] === sent.event.id);
  const said = declined === undefined ? null : readContent(declined.event);
  return { sent, state, answer: answer ?? null, reason: state === "declined" && said?.kind === "job.declined" ? said.content.reason : "" };
}

/** Where a run's agent may ask another from: the root request, the chat it is in, and the agents its request came through, the asking agent last. */
interface Under {
  readonly root: Delivered;
  readonly chat: string;
  readonly chain: readonly string[];
}

/** Where the agent `me` may ask another from in its run on the request `job`: one whose signature holds, a person's message or a request of `me`; or why not. */
async function under(client: Client, job: string, me: string): Promise<Under | string> {
  const found = await client.event(job);
  const said = found === null ? null : readContent(found.event);
  if (found === null || said === null || !mayCome(found.event, said) || !(await client.isTrusted(found))) {
    return "the request this run was asked is not one you can see";
  }
  const chat = chatOf(found.event, client.config.name);
  if (said.kind === "message") {
    return { root: found, chat, chain: [me] };
  }
  const root = said.kind === "job.request" && said.content.target === me ? await client.event(found.event.refs[0] ?? "") : null;
  return said.kind === "job.request" && root !== null ? { root, chat, chain: [...said.content.chain, me] } : `this run was not asked by a message or a request of ${me}`;
}

/** Why `owner`'s agent cannot be asked in `chat`, as its owner could not see the request there; null when it can. */
async function unseen(client: Client, chat: string, owner: string): Promise<string | null> {
  if (!isChannel(chat)) {
    return owner === chat || owner === client.config.name ? null : `${owner}'s agents cannot be asked in the direct chat between ${client.config.name} and ${chat}, which ${owner} cannot see`;
  }
  const members = (await client.channels()).find((channel) => channel.name === chat)?.members ?? [];
  return members.includes(owner) ? null : `${owner} is not in ${chat}, so their agents cannot be asked there`;
}

/**
 * Why `client` may not ask other agents under the request `job`; null when it may. Only a run its owner let ask them is told a request, in its environment (JOB_VAR), and it asks
 * under that one alone: another run of the same agent, under a grant or let go without asking, cannot ask under it and so name only the people of the run that may.
 */
export function cannotAsk(client: Client, job: string): string | null {
  if (client.job === job) {
    return null;
  }
  return client.job === null
    ? `this run may not ask other agents: only a run its owner let ask them is told, in ${JOB_VAR}, the request it may ask under`
    : `this run may ask other agents only under the request it was asked, which ${JOB_VAR} names`;
}

/**
 * Ask `target`, another agent, "owner/repo", as the agent this client signs as, in its run on the request `job`: a job.request in that request's chat, naming the root, the request,
 * and the agents it came through, after which this waits as `ask` does. It is refused, with why, before anything is sent, when the run may not ask under `job` (see `cannotAsk`), its
 * target's owner could not see it there, or the log shows it may not go (src/core/delegation.ts), which its target's desk judges again.
 */
export async function askUnder(client: Client, job: string, target: string, text: string, seconds: number): Promise<Asked | { readonly refused: string }> {
  const barred = cannotAsk(client, job);
  if (barred !== null) {
    return { refused: barred };
  }
  const from = await under(client, job, client.signer);
  const [owner = "", repo = ""] = target.split("/");
  const hidden = typeof from === "string" ? from : await unseen(client, from.chat, owner);
  if (typeof from === "string" || hidden !== null) {
    return { refused: hidden ?? "" };
  }
  const event = client.sign(from.chat, "job.request", { target, text, chain: from.chain }, [from.root.event.id, job]);
  const request = { seq: Number.MAX_SAFE_INTEGER, event, trusted: true };
  const verdict = checkRequest([...(await chatFrom(client, from.chat, from.root.seq)), request], request);
  if (!verdict.ok) {
    return { refused: verdict.reason };
  }
  return waitFor(client, await client.post(event), from.chat, { owner, repo }, seconds);
}
