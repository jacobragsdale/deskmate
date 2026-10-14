/** Each checkout's agent has a key of its own, kept beside its owner's, so what the agent says is signed by the agent and not by them. */

import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadKey, newKey, privateHex } from "../core/sign.ts";
import { repoNameSchema } from "../core/wire.ts";

/** The key of the agent in my checkout of `repo`: `agents/<repo>.key` in `home`, made the first time it is asked for. Replacing the file gives the agent a new key. */
export function agentKey(home: string, repo: string): KeyObject {
  const folder = join(home, "agents");
  const file = join(folder, `${repoNameSchema.parse(repo)}.key`); // A repo's name is a file name here, so it must be one: never a path.
  mkdirSync(folder, { mode: 0o700, recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, privateHex(newKey()), { mode: 0o600 });
  }
  return loadKey(readFileSync(file, "utf8").trim());
}
