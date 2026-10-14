/** An agent's key: made once, beside its owner's, where PLAYER_TWO_HOME moves it, readable by nobody else, and replaced by replacing the file. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { privateHex, publicHex } from "../src/core/sign.ts";
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
