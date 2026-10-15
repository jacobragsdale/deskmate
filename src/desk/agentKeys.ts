/** Each checkout's agent has a key of its own, kept beside its owner's, so what the agent says is signed by the agent and not by them. */

import type { KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadKey, newKey, privateHex } from "../core/sign.ts";
import { repoNameSchema } from "../core/wire.ts";

// What an agent's process is told during a run: which agent it is, "owner/repo", and the file its key is in. The player-two command, and its MCP server, sign as that agent when both are set.
export const AGENT_VAR = "PLAYER_TWO_AGENT";
export const AGENT_KEY_VAR = "PLAYER_TWO_AGENT_KEY_FILE";

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
  return loadKey(readFileSync(file, "utf8").trim());
}

/**
 * What the agent in `owner`'s checkout of `repo` is told of who it is for a run, so that whatever it does through the player-two command or its MCP server is signed as the agent, not as its owner.
 * It runs as its owner's user all the same, and could read their key if it went looking: this makes the honest path the agent's, and is no wall.
 */
export function agentEnv(home: string, owner: string, repo: string): Readonly<Record<string, string>> {
  return { [AGENT_VAR]: `${owner}/${repo}`, [AGENT_KEY_VAR]: agentKeyFile(home, repo) };
}
