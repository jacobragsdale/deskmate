/** The setup check against a real hub in this process: a machine where everything is in place, then one thing wrong at a time. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { runChecks } from "../src/desk/doctor.ts";
import type { Check } from "../src/shared/ipc.ts";
import { startHub, TEAM_REPOS } from "./startHub.ts";

const IDS = ["node", "identity", "hub", "proxy", "protocol", "clock", "dev", "repos", "git", "git-auth", "agent"];

interface Machine {
  readonly home: string;
  readonly dev: string;
}

/**
 * A machine that has joined a hub whose clock is `skew` seconds ahead of this one: its agent command on the PATH, and a checkout of a team repo
 * whose origin git is told to find in a bare repository on disk, so asking the remote needs no network and no credentials.
 */
async function machine(t: TestContext, skew = 0): Promise<Machine> {
  const hub = await startHub(t, () => Date.now() / 1000 + skew);
  await hub.join("alice"); // Its agent command is "fake-agent".
  const tools = join(hub.dir, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "fake-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const path = process.env["PATH"];
  process.env["PATH"] = `${tools}:${path ?? ""}`;
  for (const variable of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
    Reflect.deleteProperty(process.env, variable); // The hub is on this machine; a proxy set where the tests run would only get in the way.
  }
  t.after(() => {
    process.env["PATH"] = path;
  });
  const dev = join(hub.dir, "dev");
  const remote = `${TEAM_REPOS}Platform/_git/uploader`;
  const git = (...args: string[]): void => {
    execFileSync("git", args, { stdio: "ignore" });
  };
  git("init", "-q", "--bare", join(hub.dir, "uploader.git"));
  git("init", "-q", join(dev, "uploader"));
  git("-C", join(dev, "uploader"), "remote", "add", "origin", remote);
  git("-C", join(dev, "uploader"), "config", `url.${join(hub.dir, "uploader.git")}.insteadOf`, remote);
  return { home: join(hub.dir, "alice"), dev };
}

function statuses(checks: readonly Check[]): Record<string, string> {
  return Object.fromEntries(checks.map((check) => [check.id, check.status]));
}

await test("on a machine with everything in place every check passes, in order", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  const checks = await runChecks(home, dev);
  assert.deepEqual(
    checks.map((check) => check.id),
    IDS
  );
  assert.deepEqual(statuses(checks), Object.fromEntries(IDS.map((id) => [id, "ok"])), JSON.stringify(checks, null, 1));
  assert.ok(checks.every((check) => check.fix === ""));
});

await test("a hub clock 400 seconds ahead fails the clock, and the hub is not asked what it would refuse", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t, 400);
  const checks = await runChecks(home, dev);
  const clock = checks.find((check) => check.id === "clock");
  assert.equal(clock?.status, "fail");
  assert.match(clock.detail, /^this clock is (399|40[01]) seconds behind the hub's, so the hub refuses this machine's signatures$/);
  assert.notEqual(clock.fix, "");
  assert.deepEqual(statuses(checks), { ...Object.fromEntries(IDS.map((id) => [id, "ok"])), clock: "fail", protocol: "skip", repos: "skip", "git-auth": "skip" });
});

await test("a missing key fails the identity", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  rmSync(join(home, "key"));
  const checks = await runChecks(home, dev);
  assert.deepEqual(
    checks.find((check) => check.id === "identity"),
    { id: "identity", title: "This machine has joined a hub", status: "fail", detail: `not joined: there is no key in ${home}`, fix: "Join from the window, or run: player-two join HUB NAME TOKEN" }
  );
  assert.equal(statuses(checks)["protocol"], "skip"); // Asking /info takes a signature, and there is no key to make one.
});

await test("an unreachable hub fails the hub, and the checks that need its answer are skipped", { timeout: 60_000 }, async (t) => {
  const { home, dev } = await machine(t);
  const gone = createServer().listen(0, "127.0.0.1"); // A port nothing listens on once this has let it go.
  await once(gone, "listening");
  const address = gone.address();
  assert.ok(address !== null && typeof address === "object");
  gone.close();
  const hub = `http://127.0.0.1:${String(address.port)}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ hub, name: "alice", agent: "fake-agent" }));
  const checks = await runChecks(home, dev);
  assert.equal(checks.find((check) => check.id === "hub")?.detail, `cannot reach ${hub}: connect ECONNREFUSED 127.0.0.1:${String(address.port)}`);
  assert.deepEqual(statuses(checks), { ...Object.fromEntries(IDS.map((id) => [id, "ok"])), hub: "fail", protocol: "skip", clock: "skip", repos: "skip", "git-auth": "skip" });
});
