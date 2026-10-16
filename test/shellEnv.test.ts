/** Finding the PATH an interactive shell has: over a sample of what one prints, and by asking a real bash whose start-up files are the test's own. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { joinPaths, pathIn, shellPath } from "../src/desk/shellEnv.ts";

await test("the PATH is taken from between the markers, whatever a start-up file printed around them", () => {
  const printed = "Welcome to Ubuntu 24.04\n\x1b[32mnvm\x1b[0m is ready\n__PLAYER_TWO_PATH__/home/jacob/.nvm/versions/node/v26.1.0/bin:/usr/local/bin:/usr/bin__PLAYER_TWO_END__\nlogout\n";

  assert.equal(pathIn(printed), "/home/jacob/.nvm/versions/node/v26.1.0/bin:/usr/local/bin:/usr/bin");
  assert.equal(pathIn("Welcome to Ubuntu 24.04\n"), null);
  assert.equal(pathIn("__PLAYER_TWO_PATH____PLAYER_TWO_END__"), null);
});

await test("the folders of this process's own PATH that the shell's leaves out come after the shell's, once each", () => {
  // Debian's /etc/profile sets PATH afresh, so a folder only the desk was started with, as the window's, is not in what the shell says.
  assert.equal(joinPaths("/usr/local/bin:/usr/bin:/bin", "/home/e/bin:/usr/bin::/opt/x/bin"), "/usr/local/bin:/usr/bin:/bin:/home/e/bin:/opt/x/bin");
  assert.equal(joinPaths("/usr/bin", ""), "/usr/bin");
});

await test("a real bash is asked as an interactive login shell, and one that does not answer in time is ended and this process's own PATH used", { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "player-two-shell-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  process.env["HOME"] = home;

  // What Ubuntu's own files do: the profile reads .bashrc, which goes no further unless the shell is interactive.
  writeFileSync(join(home, ".profile"), 'echo "a line from the profile"\n. "$HOME/.bashrc"\n');
  writeFileSync(join(home, ".bashrc"), 'case $- in *i*) ;; *) return ;; esac\nexport PATH="/opt/only an interactive shell/bin:$PATH"\necho "a line from .bashrc"\n');
  assert.match(await shellPath(), /^\/opt\/only an interactive shell\/bin:.*\/bin/);

  // A start-up file that hangs, in something it started: the shell and what it started are both ended, or this would wait for the sleep.
  writeFileSync(join(home, ".profile"), "sleep 20\n");
  const began = Date.now();
  assert.equal(await shellPath(0.3), process.env["PATH"]);
  assert.ok(Date.now() - began < 5000, `took ${String(Date.now() - began)} ms`);
});
