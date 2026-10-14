/** What is left of the chat state over notes: the chat a note belongs to, for the command until it reads events (P1-F1), which deletes this file. No IO. */

import { isChannel } from "./wire.ts";
import type { Note } from "./wire.ts";

/** The chat a note belongs to: its channel, or the other person in a direct chat. */
export function chatOf(note: Note, me: string): string {
  if (isChannel(note.to)) {
    return note.to;
  }
  return note.sender === me ? note.to : note.sender;
}
