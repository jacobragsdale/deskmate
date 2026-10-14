/**
 * Reading the chat for the command and the MCP server: a note with where the agents it tags stand and their answers; and asking an agent, then waiting for that one job to end.
 * Everything is folded as the window folds it (src/core/chat.ts), so an edit, a delete or a job's events count here exactly as they count there.
 */

import { ChatLog, chatOf } from "../core/chat.ts";
import type { Entry, Message, Request, State } from "../core/chat.ts";
import { fitText, NAME, REPO_NAME } from "../core/wire.ts";
import type { Delivered } from "../core/wire.ts";
import type { Client } from "./client.ts";

const PAGE = 200; // The most events the hub gives at once.
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
    entries.push({ ...delivered, trusted: await client.isTrusted(delivered.event) });
  }
  return entries;
}

/** Every message and answer a chat shows, replies included, in the order the fold placed them. */
export function messagesIn(log: ChatLog, chat: string): Message[] {
  return log.items(chat).flatMap((item) => (item.kind === "message" ? [item.message, ...item.message.replies] : []));
}

/**
 * A chat's events from `seq` to its newest, a page at a time from the newest back.
 * ponytail: reads all of a chat after a note to find what was said about it; a hub route for the events that refer to one would be the upgrade if old notes in busy chats get slow.
 */
async function chatFrom(client: Client, chat: string, seq: number): Promise<Entry[]> {
  const found: Delivered[] = [];
  for (;;) {
    const before = found.at(-1)?.seq;
    const page = await client.events(before === undefined ? { chat, limit: PAGE } : { chat, before, limit: PAGE });
    found.push(...page);
    if (page.length < PAGE || (page.at(-1)?.seq ?? 0) <= seq) {
      return trust(
        client,
        found.filter((delivered) => delivered.seq >= seq)
      );
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
  if (found === null) {
    return null;
  }
  const chat = chatOf(found.event, client.config.name);
  const log = new ChatLog(client.config.name);
  const entries = await chatFrom(client, chat, found.seq);
  log.add(entries);
  const message = log.message(id);
  return {
    entry: entries.find((entry) => entry.event.id === id) ?? { ...found, trusted: await client.isTrusted(found.event) },
    chat,
    message,
    jobs: message === null ? [] : log.requests(message, client.now()),
    answers: messagesIn(log, chat).filter((each) => each.answers === id)
  };
}

/** How an ask ended: `answered`, with the answer; another final state; or `waiting` or `working` when nothing final came in time. */
export interface Asked {
  readonly sent: Delivered; // The request.
  readonly state: State;
  readonly answer: Entry | null; // The agent's answer, when it is answered.
}

/**
 * Ask an agent: publish a message in `chat` that tags it, then wait up to `seconds` for that one job to end. Nothing else said in the chat ends the wait.
 * It is a message like any other, so the tag waits for the agent's owner to act on it, even when the owner is the one asking: only a message typed in their own window runs at once.
 */
export async function ask(client: Client, agent: Agent, chat: string, text: string, via: "cli" | "mcp", seconds: number): Promise<Asked> {
  const { owner, repo } = agent;
  const me = client.config.name;
  const sent = await client.publish(chat, "message", { text: fitText(`@${owner}/${repo} ${text}`), via });
  const log = new ChatLog(me);
  log.add([{ ...sent, trusted: true }]);
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
      log.add(
        await trust(
          client,
          batch.filter((delivered) => chatOf(delivered.event, me) === chat)
        )
      );
      if (FINAL.has(where())) {
        stop.abort();
      }
    },
    stop.signal
  );
  clearTimeout(timer);
  const state = where();
  // The answer that settled it: once a job is answered nothing moves it again, so it is the newest from the owner's agent to this request.
  const answer = state === "answered" ? messagesIn(log, chat).findLast((each) => each.answers === sent.event.id && each.agent === repo && each.entry.event.author === owner) : undefined;
  return { sent, state, answer: answer?.entry ?? null };
}
