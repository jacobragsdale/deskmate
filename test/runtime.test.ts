/** The Linux runtime as the window ships it: packed around a stand-in for Node, installed by the real install script, then the command run through its links and the desk started by its launcher. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pack, tarballIn } from "../scripts/build-runtime.ts";
import { installScript } from "../src/core/install.ts";
import { byCodeUnit } from "../src/core/text.ts";
import { VERSION } from "../src/core/version.ts";
import { PROTOCOL } from "../src/core/wire.ts";
import { deskLineSchema } from "../src/shared/ipc.ts";

const BUILT = join(import.meta.dirname, "..", "dist", "player-two.js");

await test("the runtime installs, its command runs through the links with the proxy and CA flags, and its launcher starts the desk", { timeout: 30_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "player-two-it's a runtime-")); // A space and a quote, as a Windows user's folder may have.
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const home = join(dir, "home");
  mkdirSync(home);
  const env = { HOME: home, PATH: process.env["PATH"], PLAYER_TWO_HOME: join(home, "identity") };

  // Node itself, behind a script that writes down what it was started with.
  const node = join(dir, "node");
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/node-args"\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  const archive = join(dir, "wsl-runtime.tar.gz");
  const digest = pack(node, BUILT, archive);

  assert.equal(readFileSync(`${archive}.sha256`, "utf8"), `${digest}  wsl-runtime.tar.gz\n`);
  assert.equal(spawnSync("sha256sum", ["--check", "--status", `${archive}.sha256`], { cwd: dir }).status, 0);
  const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout.trim().split("\n").sort(byCodeUnit);
  assert.deepEqual(listed, ["bin/", "bin/node", "bin/player-two", "bin/player-two-desk", "lib/", "lib/player-two.js"]);

  const installed = spawnSync("sh", ["-s"], { input: installScript(archive, digest), env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);

  // Through ~/.local/bin/player-two, a link to a link: the command finds Node and its file beside the runtime's real folder.
  const help = spawnSync(join(home, ".local", "bin", "player-two"), ["--help"], { env, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage: player-two COMMAND/);
  const runtime = join(home, ".player-two", "runtime", `sha256-${digest}`);
  assert.deepEqual(readFileSync(join(home, "node-args"), "utf8").split("\n"), ["--use-env-proxy", "--use-system-ca", `${runtime}/bin/../lib/player-two.js`, "--help", ""]);

  // The launcher, by the path the window starts it at, runs the desk, which says hello first and stops when its input ends.
  const desk = spawnSync(join(home, ".player-two", "current", "bin", "player-two-desk"), { env, input: "", encoding: "utf8" });
  assert.equal(desk.status, 0, desk.stderr);
  assert.deepEqual(deskLineSchema.parse(JSON.parse(desk.stdout.split("\n")[0] ?? "")), { t: "hello", version: VERSION, protocol: PROTOCOL });
  assert.equal(readFileSync(join(home, "node-args"), "utf8").split("\n").at(-2), "desk");
});

await test("the tarball is found in Node's list of digests by its name", () => {
  const digest = "ab".repeat(32);
  const sums = [`${"cd".repeat(32)}  node-v26.3.1-linux-arm64.tar.gz`, `${digest}  node-v26.3.1-linux-x64.tar.gz`, `${"ef".repeat(32)}  node-v26.3.1-linux-x64.tar.xz`].join("\n");
  assert.deepEqual(tarballIn(sums), { name: "node-v26.3.1-linux-x64.tar.gz", digest });
  assert.equal(tarballIn(sums.replaceAll("v26", "v27")), null);
});
