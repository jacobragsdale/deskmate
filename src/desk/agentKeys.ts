/** Each checkout's agent has a key of its own, kept beside its owner's, so what the agent says is signed by the agent and not by them. */

import type { KeyObject } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadKey, newKey, privateHex } from "../core/sign.ts";
import { problemOf } from "../core/text.ts";
import { repoNameSchema } from "../core/wire.ts";

// What an agent's process is told during a run: which agent it is, "owner/repo", and the file its key is in. The player-two command, and its MCP server, sign as that agent when both are set.
export const AGENT_VAR = "PLAYER_TWO_AGENT";
export const AGENT_KEY_VAR = "PLAYER_TWO_AGENT_KEY_FILE";
// In a run under a grant, the one chat the command reads, the request's: whoever asked must not be handed, unreviewed, what the owner's other chats hold.
export const ONLY_CHAT_VAR = "PLAYER_TWO_ONLY_CHAT";
// In a run its owner let ask other agents, and only there, the request it was asked: the one its MCP server may ask them under. Another run of the same agent is told no request, or its own.
export const JOB_VAR = "PLAYER_TWO_JOB";

/** The file the key of the agent in my checkout of `repo` is kept in: `agents/<repo>.key` in `home`. */
export function agentKeyFile(home: string, repo: string): string {
  return join(home, "agents", `${repoNameSchema.parse(repo)}.key`); // A repo's name is a file name here, so it must be one: never a path.
}

/**
 * Refuse a folder or key file other users of this machine can get at: one of them may have read the key, or put their own there, and nothing tells which.
 * It is not made private here, which would hide that: `fix` is the chmod that does it once its owner has looked.
 */
function refuseOpen(path: string, what: string, fix: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is open to other users of this machine (mode ${mode.toString(8)}), so ${what} may already have been read or put there by one of them, and is not used. ` +
        `Delete it to have a new key made and registered the next time one is needed; or, if nobody else could have got at it, run: ${fix} ${path}`
    );
  }
}

/**
 * The key of the agent in my checkout of `repo`, made the first time it is asked for, in a folder only its owner can open, and readable by nobody else; one that is not is refused.
 * Replacing the file gives the agent a new key.
 */
export function agentKey(home: string, repo: string): KeyObject {
  const file = agentKeyFile(home, repo);
  const folder = join(home, "agents");
  mkdirSync(folder, { mode: 0o700, recursive: true });
  refuseOpen(folder, "a key in it", "chmod 700");
  try {
    writeFileSync(file, privateHex(newKey()), { mode: 0o600, flag: "wx" }); // Only where there is none: one another desk made a moment ago is the key.
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  refuseOpen(file, "the agent's key", "chmod 600");
  const text = readFileSync(file, "utf8").trim();
  try {
    return loadKey(text);
  } catch (error) {
    throw new Error(`${file} cannot be read: ${problemOf(error)}`, { cause: error }); // Which of the agents' keys it is.
  }
}

/**
 * The file in `home` whose private key `text` holds, the user's own or one of their agents', null when it holds none: as the file has it, hex in either case, or the raw key in base64 or base64url,
 * whitespace inside it aside. For an answer posted with nobody reviewing it. It is a last net and no wall: an agent that read a key could send it in pieces or in another form.
 */
export function keyIn(home: string, text: string): string | null {
  const squeezed = text.replace(/\s+/g, "");
  const folder = join(home, "agents");
  let agents: string[] = [];
  try {
    agents = readdirSync(folder).flatMap((name) => (name.endsWith(".key") ? [join(folder, name)] : []));
  } catch {
    // No agent has a key yet.
  }
  return (
    [join(home, "key"), ...agents].find((file) => {
      let held: string;
      try {
        held = readFileSync(file, "utf8").trim();
      } catch {
        return false;
      }
      const raw = Buffer.from(held, "hex");
      // Only a key a desk could load: anything else is no key, and an empty file would be found in every text.
      return (
        /^[0-9a-fA-F]{64}$/.test(held) &&
        (squeezed.toLowerCase().includes(held.toLowerCase()) || [raw.toString("base64").replace(/=+$/, ""), raw.toString("base64url")].some((form) => squeezed.includes(form)))
      );
    }) ?? null
  );
}

/**
 * What the agent in `owner`'s checkout of `repo` is told of who it is for a run, so that whatever it does through the player-two command or its MCP server is signed as the agent, not as its owner;
 * with `onlyChat`, as under a grant, the one chat the command reads; and with `job`, in a run its owner let ask other agents, the request it may ask them under. It runs as its owner's
 * user all the same, and could read their key, or any chat, if it went looking: this makes the honest path the agent's, and is no wall.
 */
export function agentEnv(home: string, owner: string, repo: string, onlyChat?: string, job?: string): Readonly<Record<string, string>> {
  return {
    [AGENT_VAR]: `${owner}/${repo}`,
    [AGENT_KEY_VAR]: agentKeyFile(home, repo),
    ...(onlyChat === undefined ? {} : { [ONLY_CHAT_VAR]: onlyChat }),
    ...(job === undefined ? {} : { [JOB_VAR]: job })
  };
}
