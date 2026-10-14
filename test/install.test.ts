/** The script that installs the Linux runtime, run for real with `sh` against small archives in a home folder of the test's own. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installScript } from "../src/core/install.ts";
import { byCodeUnit } from "../src/core/text.ts";

interface Archive {
  readonly path: string;
  readonly digest: string;
}

/** An archive laid out as the runtime is, whose command says which one it is. */
function archive(dir: string, version: string): Archive {
  const staged = join(dir, `staged ${version}`);
  mkdirSync(join(staged, "bin"), { recursive: true });
  mkdirSync(join(staged, "lib"));
  writeFileSync(join(staged, "bin", "player-two"), `#!/bin/sh\necho "runtime ${version}"\n`, { mode: 0o755 });
  writeFileSync(join(staged, "lib", "player-two.js"), "");
  const path = join(dir, `runtime ${version}.tar.gz`);
  const packed = spawnSync("tar", ["-czf", path, "-C", staged, "bin", "lib"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  return { path, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

await test("the install script unpacks a runtime once, points the command at it, keeps the one before and removes the rest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "player-two-it's an install-")); // A space and a quote in every path, as a Windows user's folder may have.
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const home = join(dir, "home");
  mkdirSync(home);
  const root = join(home, ".player-two");
  const folder = (each: Archive): string => join(root, "runtime", `sha256-${each.digest}`);
  const install = (path: string, digest: string): { readonly status: number | null; readonly stderr: string } => {
    const { status, stderr } = spawnSync("sh", ["-s"], { input: installScript(path, digest), env: { HOME: home, PATH: process.env["PATH"] }, encoding: "utf8" });
    return { status, stderr };
  };
  /** Everything the script decides: which runtimes are there, what the links point at, and what the command on the PATH says. */
  const state = (): unknown => ({
    runtimes: readdirSync(join(root, "runtime")).sort(byCodeUnit),
    current: readlinkSync(join(root, "current")),
    previous: existsSync(join(root, "previous")) ? readlinkSync(join(root, "previous")) : null,
    command: readlinkSync(join(home, ".local", "bin", "player-two")),
    says: spawnSync(join(home, ".local", "bin", "player-two"), { encoding: "utf8" }).stdout
  });
  const [one, two, three] = [archive(dir, "one"), archive(dir, "two"), archive(dir, "three")];

  // An archive that is not the one named is refused before anything is touched.
  const refused = install(one.path, two.digest);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^the runtime archive .*runtime one\.tar\.gz is damaged: its SHA-256 is [0-9a-f]{64}, not [0-9a-f]{64}\n$/);
  assert.equal(install(join(dir, "no such archive.tar.gz"), one.digest).status, 1);
  assert.ok(!existsSync(root));

  // The first install: one runtime, the command linked through `current`.
  assert.deepEqual(install(one.path, one.digest), { status: 0, stderr: "" });
  const first = { runtimes: [`sha256-${one.digest}`], current: folder(one), previous: null, command: join(root, "current", "bin", "player-two"), says: "runtime one\n" };
  assert.deepEqual(state(), first);

  // Run again it changes nothing, and does not unpack over what is there.
  writeFileSync(join(folder(one), "left alone"), "");
  assert.deepEqual(install(one.path, one.digest), { status: 0, stderr: "" });
  assert.deepEqual(state(), first);
  assert.ok(existsSync(join(folder(one), "left alone")));

  // A newer runtime takes over and the one before it is kept, however often the script runs.
  mkdirSync(join(root, "runtime", "sha256-left-half-unpacked.new"));
  for (let run = 1; run <= 2; run += 1) {
    assert.deepEqual(install(two.path, two.digest), { status: 0, stderr: "" });
    assert.deepEqual(state(), { ...first, runtimes: [`sha256-${one.digest}`, `sha256-${two.digest}`].sort(byCodeUnit), current: folder(two), previous: folder(one), says: "runtime two\n" });
  }

  // A third leaves the second as the one before, and the first is removed.
  assert.deepEqual(install(three.path, three.digest), { status: 0, stderr: "" });
  assert.deepEqual(state(), { ...first, runtimes: [`sha256-${two.digest}`, `sha256-${three.digest}`].sort(byCodeUnit), current: folder(three), previous: folder(two), says: "runtime three\n" });
});
