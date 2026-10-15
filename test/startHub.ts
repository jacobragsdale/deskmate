/** A hub for one test: the real one, started in the test's own process, on a clock that stands still unless the test brings its own. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { oneshotAgent } from "../src/desk/agents/presets.ts";
import { http, join as joinHub, loadClient, readConfig } from "../src/desk/client.ts";
import type { Client } from "../src/desk/client.ts";
import { signEvent } from "../src/core/sign.ts";
import type { Delivered, PermissionMode } from "../src/core/wire.ts";
import { createHub } from "../src/hub/app.ts";
import { Database } from "../src/hub/db.ts";

export const NOW = 1_800_000_000;
export const TOKEN = "a-join-token-for-tests";
export const TEAM_REPOS = "https://dev.azure.com/acme/"; // Only repos under this address may be shared on the test hub.

export interface Hub {
  readonly url: string;
  readonly dir: string; // Holds the hub's database and a home folder for each person who joins.
  readonly join: (name: string, ownMode?: PermissionMode) => Promise<Client>; // Join under a name, with the mode its own requests run at when given, and return a client for that identity.
  readonly drop: () => void; // Cut every connection open to the hub, as a proxy that gives up on them would.
}

/**
 * A hub of its own for one test, listening on a port the system picked. A test of something that reads the real clock, as the desk does, passes that clock as `now`; one of what a teammate installs
 * passes the folder it serves; one of a team whose repos are somewhere else passes where.
 */
export async function startHub(t: TestContext, now: () => number = () => NOW, downloads = "", repos = TEAM_REPOS): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "player-two-hub-"));
  const server = createHub({ joinToken: TOKEN, db: join(dir, "hub.db"), repos, downloads }, now);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${String(address.port)}`;
  return {
    url,
    dir,
    join: async (name, mode) => {
      await joinHub(join(dir, name), url, name, TOKEN, oneshotAgent("fake-agent"), http);
      if (mode !== undefined) {
        ownMode(join(dir, name), mode);
      }
      const client = loadClient(join(dir, name), http, now);
      assert.ok(client !== null);
      return client;
    },
    drop: () => {
      server.closeAllConnections();
    }
  };
}

/**
 * Give this test process a home folder and a git configuration of its own, before anything reads either: a teammate's run above read-only makes a worktree under ~/.player-two/worktrees,
 * which must never be the real one, and git commits there as a test identity. Removed as the process exits.
 */
export function ownHome(): string {
  const home = mkdtempSync(join(tmpdir(), "player-two-home-"));
  const config = join(home, ".gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n");
  process.env["HOME"] = home;
  process.env["GIT_CONFIG_GLOBAL"] = config;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.once("exit", () => {
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

/** A real git checkout of the team's `repo` in `dev`, with one commit and its origin, as a run on a clean copy needs, unless there is one already. Returns its path. */
export function checkout(dev: string, repo: string): string {
  const path = join(dev, repo);
  if (existsSync(join(path, ".git"))) {
    return path;
  }
  mkdirSync(path, { recursive: true });
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", `${TEAM_REPOS}Platform/_git/${repo}`],
    ["commit", "-q", "--allow-empty", "-m", "first"]
  ]) {
    execFileSync("git", ["-C", path, ...args], { stdio: "ignore" });
  }
  return path;
}

/** Set the mode an identity's own requests of its own agents run at, in its config.json. A one-shot command, such as the one every identity here starts with, runs only at "full". */
export function ownMode(home: string, mode: PermissionMode): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...readConfig(home), ownMode: mode }, null, 1));
}

/**
 * Sign an event with `key` and store it as a hub that checked nothing about it would, chained after the rest, for a test of what a client makes of one the hub refuses.
 * A stream open on the hub hears of it with the next event posted. Content is given as the object it is the JSON text of.
 */
export function storedUnchecked(
  hub: Hub,
  key: KeyObject,
  event: { readonly author: string; readonly to: string; readonly kind: string; readonly content: object; readonly ts: number; readonly refs: readonly string[] }
): Delivered {
  const signed = signEvent(key, { ...event, content: JSON.stringify(event.content) });
  const db = new Database(join(hub.dir, "hub.db"));
  try {
    return { seq: db.transaction(() => db.addEvent(signed)), event: signed };
  } finally {
    db.close();
  }
}
