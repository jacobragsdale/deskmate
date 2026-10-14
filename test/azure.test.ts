/** Azure DevOps: finding a token, with a git credential helper of the test's own. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { findToken, gitPassword } from "../src/desk/azure.ts";
import { defaultHome } from "../src/desk/client.ts";

const REPO_URL = "https://dev.azure.com/acme/Platform/_git/uploader";
const OAUTH = "an-oauth-token"; // What Git Credential Manager keeps for Azure DevOps.

/** A folder for one test, where git's configuration and the identity's folder are moved, so no credential helper of whoever runs the tests is ever asked. */
function isolate(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "player-two-azure-"));
  writeFileSync(join(dir, "gitconfig"), "");
  process.env["GIT_CONFIG_GLOBAL"] = join(dir, "gitconfig");
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["PLAYER_TWO_HOME"] = join(dir, "home");
  for (const variable of ["AZURE_DEVOPS_EXT_PAT", "GIT_ASKPASS", "SSH_ASKPASS", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
    Reflect.deleteProperty(process.env, variable);
  }
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Make git's one credential helper a script that runs `body` when asked for a credential, with what git asked on its standard input. */
function useHelper(dir: string, body: string): void {
  const helper = join(dir, "helper");
  writeFileSync(helper, `#!/bin/sh\ntest "$1" = get || exit 0\n${body}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "gitconfig"), `[credential]\n\thelper = ${helper}\n`);
}

await test("git's credential helper is asked for the repo's address, and the password it gives taken", async (t) => {
  useHelper(isolate(t), `grep -qx 'host=dev.azure.com' && printf 'protocol=https\\nhost=dev.azure.com\\nusername=jacob@example.com\\npassword=${OAUTH}\\n'`);
  assert.equal(await gitPassword(REPO_URL), OAUTH);
  assert.equal(await gitPassword("https://example.com/acme/uploader"), null);
});

await test("nothing may ask the user: with no helper, git neither prompts nor runs an askpass program, from the environment or its configuration", async (t) => {
  const dir = isolate(t);
  const asked = join(dir, "asked");
  const askpass = join(dir, "askpass");
  writeFileSync(askpass, `#!/bin/sh\ntouch '${asked}'\necho from-askpass\n`, { mode: 0o755 });
  writeFileSync(join(dir, "gitconfig"), `[core]\n\taskPass = ${askpass}\n`);
  process.env["GIT_ASKPASS"] = askpass;
  process.env["SSH_ASKPASS"] = askpass;
  t.after(() => {
    Reflect.deleteProperty(process.env, "GIT_ASKPASS");
    Reflect.deleteProperty(process.env, "SSH_ASKPASS");
  });
  assert.equal(await gitPassword(REPO_URL), null);
  assert.equal(existsSync(asked), false);
});

await test("a helper that has not answered within the limit is ended with git, and no password found", async (t) => {
  useHelper(isolate(t), "sleep 30");
  const began = Date.now();
  assert.equal(await gitPassword(REPO_URL, 0.3), null);
  assert.ok(Date.now() - began < 5000, `took ${String(Date.now() - began)} ms`);
});

await test("a token is looked for in the environment, then in azure.json in the identity's folder, then from git", async (t) => {
  const dir = isolate(t);
  const home = defaultHome();
  const saved = join(home, "azure.json");
  useHelper(dir, `printf 'username=jacob@example.com\\npassword=${OAUTH}\\n'`);
  assert.deepEqual(await findToken(home, REPO_URL), { secret: OAUTH, source: "git's credential helper" });

  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(saved, JSON.stringify({ token: "a-saved-pat" }), { mode: 0o600 });
  assert.deepEqual(await findToken(home, REPO_URL), { secret: "a-saved-pat", source: saved });

  process.env["AZURE_DEVOPS_EXT_PAT"] = "a-pat-from-the-environment";
  t.after(() => {
    Reflect.deleteProperty(process.env, "AZURE_DEVOPS_EXT_PAT");
  });
  assert.deepEqual(await findToken(home, REPO_URL), { secret: "a-pat-from-the-environment", source: "AZURE_DEVOPS_EXT_PAT" });

  // With none of the three, there is no token; a file not as the setup page writes one is not one.
  Reflect.deleteProperty(process.env, "AZURE_DEVOPS_EXT_PAT");
  writeFileSync(saved, "a-pat-with-no-json-around-it");
  writeFileSync(join(dir, "gitconfig"), "");
  assert.equal(await findToken(home, REPO_URL), null);
});
