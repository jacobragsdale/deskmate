/** A hub for one test: the real one, started in the test's own process, on a clock that stands still unless the test brings its own. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { oneshotAgent } from "../src/desk/agents/presets.ts";
import { http, join as joinHub, loadClient } from "../src/desk/client.ts";
import type { Client } from "../src/desk/client.ts";
import { createHub } from "../src/hub/app.ts";

export const NOW = 1_800_000_000;
export const TOKEN = "a-join-token-for-tests";
export const TEAM_REPOS = "https://dev.azure.com/acme/"; // Only repos under this address may be shared on the test hub.

export interface Hub {
  readonly url: string;
  readonly dir: string; // Holds the hub's database and a home folder for each person who joins.
  readonly join: (name: string) => Promise<Client>; // Join under a name and return a client for that identity.
  readonly drop: () => void; // Cut every connection open to the hub, as a proxy that gives up on them would.
}

/** A hub of its own for one test, listening on a port the system picked. A test of something that reads the real clock, as the desk does, passes that clock as `now`; one of what a teammate installs passes the folder it serves. */
export async function startHub(t: TestContext, now: () => number = () => NOW, downloads = ""): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "player-two-hub-"));
  const server = createHub({ joinToken: TOKEN, db: join(dir, "hub.db"), repos: TEAM_REPOS, downloads }, now);
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
    join: async (name) => {
      await joinHub(join(dir, name), url, name, TOKEN, oneshotAgent("fake-agent"), http);
      const client = loadClient(join(dir, name), http, now);
      assert.ok(client !== null);
      return client;
    },
    drop: () => {
      server.closeAllConnections();
    }
  };
}
