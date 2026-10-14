/**
 * Reading the chat for the command and the MCP server: a note with where the agents it tags stand and their answers.
 * Everything is folded as the window folds it (src/core/chat.ts), so an edit, a delete or a job's events count here exactly as they count there.
 */

import { ChatLog, chatOf } from "../core/chat.ts";
import type { Entry, Message, Request } from "../core/chat.ts";
import type { Delivered } from "../core/wire.ts";
import type { Client } from "./client.ts";

const PAGE = 200; // The most events the hub gives at once.

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
