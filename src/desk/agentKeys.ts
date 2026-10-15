/** Each checkout's agent has a key of its own, kept beside its owner's, so what the agent says is signed by the agent and not by them. */

import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** The key of the agent in my checkout of `repo`, made the first time it is asked for. Replacing the file gives the agent a new key. */
export function agentKey(home: string, repo: string): KeyObject {
  const file = agentKeyFile(home, repo);
  mkdirSync(join(home, "agents"), { mode: 0o700, recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, privateHex(newKey()), { mode: 0o600 });
  }
  return loadKey(readFileSync(file, "utf8").trim());
}

/**
 * What the agent in `owner`'s checkout of `repo` is told of who it is for a run, so that whatever it does through the player-two command or its MCP server is signed as the agent, not as its owner.
 * It runs as its owner's user all the same, and could read their key if it went looking: this makes the honest path the agent's, and is no wall.
 */
export function agentEnv(home: string, owner: string, repo: string): Readonly<Record<string, string>> {
  return { [AGENT_VAR]: `${owner}/${repo}`, [AGENT_KEY_VAR]: agentKeyFile(home, repo) };
}
