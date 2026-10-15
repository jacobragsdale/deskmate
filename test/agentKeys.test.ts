/** An agent's key: made once, beside its owner's, where PLAYER_TWO_HOME moves it, readable by nobody else, and replaced by replacing the file. */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { newKey, privateHex, publicHex } from "../src/core/sign.ts";
import { agentKey } from "../src/desk/agentKeys.ts";
import { defaultHome } from "../src/desk/client.ts";

await test("an agent's key is made once in the agents folder of PLAYER_TWO_HOME, private to its owner, one per repo, and a new file is a new key", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "player-two-agent-keys-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  process.env["PLAYER_TWO_HOME"] = join(dir, "identity"); // Not made yet: the first key makes it too.
  const home = defaultHome();

  const uploader = publicHex(agentKey(home, "uploader"));
  assert.equal(publicHex(agentKey(home, "uploader")), uploader); // Loaded the second time, not made again.
  assert.notEqual(publicHex(agentKey(home, "billing.api")), uploader);
  assert.equal(statSync(join(dir, "identity", "agents", "uploader.key")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "identity", "agents")).mode & 0o777, 0o700);
  assert.throws(() => agentKey(home, "../key")); // Never a path outside the folder.

  const replacement = privateHex(agentKey(join(dir, "elsewhere"), "uploader"));
  writeFileSync(join(home, "agents", "uploader.key"), replacement);
  assert.equal(privateHex(agentKey(home, "uploader")), replacement);
});

await test("an agent's key made a moment before by another desk is the one used; one in a folder other users can open, or a file they can read, is refused with the chmod that fixes it, and left as it is", (t) => {
  const home = mkdtempSync(join(tmpdir(), "player-two-agent-keys-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const [folder, file] = [join(home, "agents"), join(home, "agents", "uploader.key")];
  mkdirSync(folder, { mode: 0o700 });
  const first = privateHex(newKey());
  writeFileSync(file, first, { mode: 0o600 }); // Made by another desk between this one finding none and making its own.
  assert.equal(privateHex(agentKey(home, "uploader")), first);

  chmodSync(folder, 0o755);
  const open = (path: string, mode: string, fix: string): RegExp =>
    new RegExp(`^${path} is open to other users of this machine \\(mode ${mode}\\), .* may already have been read or put there .* run: ${fix} ${path}$`);
  assert.throws(() => agentKey(home, "uploader"), { message: open(folder, "755", "chmod 700") });
  assert.throws(() => agentKey(home, "billing"), { message: open(folder, "755", "chmod 700") });
  assert.equal(existsSync(join(folder, "billing.key")), false); // No key is made where others could read it.
  assert.equal(statSync(folder).mode & 0o777, 0o755); // Nor made private behind its owner's back.

  chmodSync(folder, 0o700);
  chmodSync(file, 0o640);
  assert.throws(() => agentKey(home, "uploader"), { message: open(file, "640", "chmod 600") });
  assert.equal(statSync(file).mode & 0o777, 0o640);
  chmodSync(file, 0o600);
  assert.equal(privateHex(agentKey(home, "uploader")), first);
});
