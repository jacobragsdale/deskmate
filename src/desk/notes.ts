/** Reading the chat for the command and the MCP server. */

import type { Entry } from "../core/chat.ts";
import type { Delivered } from "../core/wire.ts";
import type { Client } from "./client.ts";

/** Events as the hub delivered them, each with whether it holds under the key first seen for its author. One at a time, as the first look at a new author writes known.json. */
export async function trust(client: Client, found: readonly Delivered[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const delivered of found) {
    entries.push({ ...delivered, trusted: await client.isTrusted(delivered.event) });
  }
  return entries;
}
