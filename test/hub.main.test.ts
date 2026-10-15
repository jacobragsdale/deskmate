/** The hub as a program, started the way it is in use, as `player-two hub`: it says what is missing rather than starting without it, and it stops when it is told to. */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { authHeader, loadKey } from "../src/core/sign.ts";
import { oneshotAgent } from "../src/desk/agents/presets.ts";
import { http, join as joinHub } from "../src/desk/client.ts";

const COMMAND = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const TOKEN = "a-join-token-for-tests";

await test("the hub refuses to start without its settings and names each one", () => {
  const run = spawnSync(process.execPath, [COMMAND, "hub"], { env: { PLAYER_TWO_JOIN_TOKEN: "too-short", PLAYER_TWO_REPOS: "https://dev.azure.com/acme/" }, encoding: "utf8" });

  assert.equal(run.status, 1);
  assert.equal(run.stderr, "player-two: PLAYER_TWO_JOIN_TOKEN must be at least 16 characters; PLAYER_TWO_DB is not set\n");
  const env = { PLAYER_TWO_JOIN_TOKEN: TOKEN, PLAYER_TWO_DB: "unused.db", PLAYER_TWO_REPOS: "https://dev.azure.com/acme/", PLAYER_TWO_WEBHOOK_ALLOW: "ci.example.com, *.corp.internal" };
  const listed = spawnSync(process.execPath, [COMMAND, "hub"], { env, encoding: "utf8" });
  assert.deepEqual(
    [listed.status, listed.stderr],
    [1, "player-two: PLAYER_TWO_WEBHOOK_ALLOW *.corp.internal is not a host name or an IP address; a name lets the hub call every name under it, so example.com rather than *.example.com\n"]
  );
});

await test("the hub stops at once when told to, even with a reader waiting", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "player-two-hub-main-"));
  const hub = spawn(process.execPath, [COMMAND, "hub", "--port", "0"], {
    env: { PLAYER_TWO_JOIN_TOKEN: TOKEN, PLAYER_TWO_DB: join(dir, "hub.db"), PLAYER_TWO_REPOS: "https://dev.azure.com/acme/", PLAYER_TWO_DOWNLOADS: dir },
    stdio: ["ignore", "ignore", "pipe"]
  });
  t.after(() => {
    hub.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  let logged = "";
  const exited = new Promise<number | null>((resolve) => {
    hub.once("exit", resolve);
  });
  const url = await new Promise<string>((resolve, reject) => {
    hub.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      logged += chunk;
      const port = /hub listening .*port=(\d+)\n/.exec(logged)?.[1];
      if (port !== undefined) {
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    hub.once("exit", () => {
      reject(new Error(`the hub exited before it was listening:\n${logged}`));
    });
  });
  await joinHub(join(dir, "alice"), url, "alice", TOKEN, oneshotAgent("fake-agent"), http);
  const path = "/stream?after=0";
  const key = loadKey(readFileSync(join(dir, "alice", "key"), "utf8").trim());
  const stream = await fetch(url + path, { headers: { Authorization: authHeader(key, "alice", Math.floor(Date.now() / 1000), "GET", path) } }); // Answered at once with its headers, then held open.
  assert.equal(stream.status, 200);
  const reading = stream.text().then(
    () => "ended",
    () => "cut off"
  );

  const told = Date.now();
  hub.kill("SIGTERM");

  assert.equal(await exited, 0);
  assert.ok(Date.now() - told < 3000, `took ${String(Date.now() - told)} ms`);
  assert.equal(await reading, "cut off");
  assert.match(logged, /^hub ready db=\S+ repos=dev\.azure\.com\/acme downloads=\S+\nhub listening host=127\.0\.0\.1 port=\d+\nuser joined user=alice\nhub stopping\n$/);
});
