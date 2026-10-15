/** Throwaway worktrees against real repositories in a folder of the test's own, which stands in for the home folder, with a git configuration of its own. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { byCodeUnit } from "../src/core/text.ts";
import { close, collect, lock, open, sweep } from "../src/desk/worktree.ts";

const dir = mkdtempSync(join(tmpdir(), "player-two-worktree-"));
const plain = join(dir, "gitconfig");
writeFileSync(plain, "[user]\n\tname = Test\n\temail = test@example.com\n");
process.env["HOME"] = join(dir, "home"); // Where ~/.player-two/worktrees is.
process.env["GIT_CONFIG_GLOBAL"] = plain;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_DIFF_OPTS"]) {
  Reflect.deleteProperty(process.env, variable);
}
process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[], input = ""): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] });
}

function jobId(): string {
  return randomBytes(32).toString("hex");
}

/** A checkout with a commit of a few files: lines with an empty one among them, a file to delete, and a binary file. */
function checkout(): { readonly dev: string; readonly repo: string } {
  const dev = mkdtempSync(join(dir, "dev-"));
  const repo = join(dev, "uploader");
  git(dev, ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "notes.txt"), "one\ntwo\n\nthree\nfour\nfive\n");
  writeFileSync(join(repo, "old.txt"), "going\n");
  writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, "readme.md"), "# uploader\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "first"]);
  return { dev, repo };
}

function worktrees(repo: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []))
    .sort(byCodeUnit);
}

await test("a run's worktree is a clean copy of the checkout's commit, what it changed comes back as a diff the checkout takes, and closing it leaves nothing", async () => {
  const { repo } = checkout();
  writeFileSync(join(repo, "readme.md"), "# uploader\nmy own work, not committed\n");
  const id = jobId();
  const worktree = await open(repo, id);
  assert.equal(worktree.path, join(dir, "home", ".player-two", "worktrees", id.slice(0, 12)));
  assert.equal(worktree.base, git(repo, ["rev-parse", "HEAD"]).trim());
  assert.equal(readFileSync(join(worktree.path, "readme.md"), "utf8"), "# uploader\n");

  // The run commits one change and leaves the rest as it is.
  writeFileSync(join(worktree.path, "notes.txt"), "one\ntwo\n\nthree\nFOUR\nfive\n");
  git(worktree.path, ["commit", "-qam", "by the agent"]);
  writeFileSync(join(worktree.path, "café.txt"), "new\n");
  writeFileSync(join(worktree.path, "logo.bin"), Buffer.from([0, 9, 9]));
  rmSync(join(worktree.path, "old.txt"));
  assert.equal(git(repo, ["status", "--porcelain"]), " M readme.md\n");

  const diff = await collect(worktree);
  assert.match(diff, /^diff --git "?a\//);
  git(repo, ["apply", "--index"], diff);
  assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "one\ntwo\n\nthree\nFOUR\nfive\n");
  assert.equal(readFileSync(join(repo, "café.txt"), "utf8"), "new\n");
  assert.deepEqual(readFileSync(join(repo, "logo.bin")), Buffer.from([0, 9, 9]));
  assert.equal(existsSync(join(repo, "old.txt")), false);
  assert.equal(readFileSync(join(repo, "readme.md"), "utf8"), "# uploader\nmy own work, not committed\n");

  await close(worktree);
  assert.equal(existsSync(worktree.path), false);
  assert.deepEqual(worktrees(repo), [repo]);
  await assert.rejects(open(repo, "../../elsewhere"), /64 hex digits/);
});

await test("collect writes the same diff whatever the user's git configuration says about prefixes, colour, external diffs, textconv, context, quoting and empty lines", async (t) => {
  const { repo } = checkout();
  const worktree = await open(repo, jobId());
  writeFileSync(join(worktree.path, "notes.txt"), "one\ntwo\n\nthree\nfour\nFIVE\n");
  writeFileSync(join(worktree.path, "café.txt"), "new\n");
  const expected = await collect(worktree);
  assert.match(expected, /^diff --git a\/notes\.txt b\/notes\.txt\n/m);
  assert.match(expected, /^diff --git "a\/caf\\303\\251\.txt" "b\/caf\\303\\251\.txt"\n/m);
  assert.match(expected, /\n \n three\n four\n-five\n\+FIVE\n/);

  const shout = join(dir, "shout");
  writeFileSync(shout, '#!/bin/sh\necho SHOUTED\ntr a-z A-Z < "$1"\n', { mode: 0o755 });
  writeFileSync(join(dir, "attributes"), "* diff=shout\n");
  const hostile = join(dir, "hostile-gitconfig");
  writeFileSync(
    hostile,
    [
      "[diff]",
      "\tnoprefix = true",
      "\tmnemonicPrefix = true",
      "\tsrcPrefix = x/",
      "\tdstPrefix = y/",
      `\texternal = ${shout}`,
      "\tcontext = 0",
      "\tsuppressBlankEmpty = true",
      "\tsubmodule = log",
      "[color]\n\tui = always\n\tdiff = always",
      `[core]\n\tquotePath = false\n\tattributesFile = ${join(dir, "attributes")}`,
      `[diff "shout"]\n\ttextconv = ${shout}`,
      ""
    ].join("\n")
  );
  process.env["GIT_CONFIG_GLOBAL"] = hostile;
  process.env["GIT_DIFF_OPTS"] = "--unified=0"; // Which git takes over a context given on the command line.
  t.after(() => {
    process.env["GIT_CONFIG_GLOBAL"] = plain;
    Reflect.deleteProperty(process.env, "GIT_DIFF_OPTS");
  });
  assert.equal(await collect(worktree), expected);
  await close(worktree);
});

await test("git reads the worktree's folder in the checkout's .git and never a .git the run put in the worktree, and a change that is not UTF-8 is refused", async () => {
  const { repo } = checkout();
  const worktree = await open(repo, jobId());
  writeFileSync(join(worktree.path, "notes.txt"), "changed\n");

  // A repository of the run's own in place of the worktree's .git file, set to run a command whenever git looks at its files.
  const ran = join(dir, "ran");
  const monitor = join(dir, "monitor");
  writeFileSync(monitor, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, { mode: 0o755 });
  const planted = mkdtempSync(join(dir, "planted-"));
  git(planted, ["init", "-q"]);
  git(planted, ["config", "core.fsmonitor", monitor]);
  rmSync(join(worktree.path, ".git"));
  renameSync(join(planted, ".git"), join(worktree.path, ".git"));

  const diff = await collect(worktree);
  assert.match(diff, /^-one\n/m);
  assert.match(diff, /^\+changed\n/m);
  assert.equal(existsSync(ran), false);
  git(worktree.path, ["status", "--porcelain"]); // What git would have done had collect followed it.
  assert.equal(existsSync(ran), true);

  writeFileSync(join(worktree.path, "latin1.txt"), Buffer.from("caf\xe9\n", "latin1"));
  await assert.rejects(collect(worktree), /not UTF-8/);

  await close(worktree);
  assert.equal(existsSync(worktree.path), false);
  assert.deepEqual(worktrees(repo), [repo]);
});

await test("git run on a clean copy after its run starts no fsmonitor and no hook that the checkout's .git, which the copy shares, names, whatever put them there", async () => {
  const { repo } = checkout();
  const kept = await open(repo, jobId());
  const worktree = await open(repo, jobId());
  writeFileSync(join(worktree.path, "notes.txt"), "changed\n");
  // As a run that could write to the checkout's .git would leave it: a command for git to start when it looks at files, and each hook git add, git diff or git worktree might run.
  const ran = join(dir, "ran-shared");
  const command = `#!/bin/sh\necho "$0" >> '${ran}'\nexit 1\n`;
  writeFileSync(join(dir, "shared-monitor"), command, { mode: 0o755 });
  git(repo, ["config", "core.fsmonitor", join(dir, "shared-monitor")]);
  for (const hook of ["post-index-change", "reference-transaction", "post-checkout", "pre-auto-gc"]) {
    writeFileSync(join(repo, ".git", "hooks", hook), command, { mode: 0o755 });
  }

  assert.match(await collect(worktree), /^\+changed$/m);
  await lock(kept);
  await close(worktree);
  assert.equal(existsSync(ran), false);
  git(repo, ["status", "--porcelain"]); // What git does, told nothing.
  assert.equal(existsSync(ran), true);
});

await test("a change that records another repository's commit, a new submodule or a new commit of one, is refused: a folder the run made a repository, or gave a .git file naming one", async () => {
  const { repo: secret } = checkout(); // Another repository on the same machine, at a commit of its own.
  git(secret, ["commit", "-q", "--allow-empty", "-m", "secret"]);
  const { repo } = checkout();
  git(repo, ["update-index", "--add", "--cacheinfo", `160000,${git(repo, ["rev-parse", "HEAD"]).trim()},lib`]); // A submodule, at a commit of its own.
  git(repo, ["commit", "-qm", "a submodule"]);
  const gitlink = /another repository's commit, as a submodule does, which is not sent as a patch/;
  for (const plant of [
    (path: string): void => {
      mkdirSync(join(path, "vendor"));
      writeFileSync(join(path, "vendor", ".git"), `gitdir: ${join(secret, ".git")}\n`);
    },
    (path: string): void => {
      git(path, ["init", "-q", "nested"]);
      writeFileSync(join(path, "nested", "x"), "x\n");
      git(join(path, "nested"), ["add", "x"]);
      git(join(path, "nested"), ["commit", "-qm", "x"]);
    },
    (path: string): void => {
      writeFileSync(join(path, "lib", ".git"), `gitdir: ${join(secret, ".git")}\n`); // The submodule, as git left it unfilled, now at the other repository's commit.
    }
  ]) {
    const worktree = await open(repo, jobId());
    writeFileSync(join(worktree.path, "notes.txt"), "changed\n");
    plant(worktree.path);
    await assert.rejects(collect(worktree), gitlink);
    await close(worktree);
  }
  // Taking the submodule away records no commit.
  const worktree = await open(repo, jobId());
  rmSync(join(worktree.path, "lib"), { recursive: true });
  assert.match(await collect(worktree), /^deleted file mode 160000$/m);
  await close(worktree);
});

await test("on start, the worktrees left in ~/.player-two/worktrees are removed and git forgets one whose folder is gone; one kept, locked with its .git git's own again, and the checkout's own stay", async () => {
  const { dev, repo } = checkout();
  const left = await open(repo, jobId());
  const deleted = await open(repo, jobId());
  const kept = await open(repo, jobId());
  rmSync(deleted.path, { recursive: true });
  rmSync(join(kept.path, ".git"));
  mkdirSync(join(kept.path, ".git")); // As a run may leave one, which git run there by hand would follow.
  await lock(kept);
  assert.equal(readFileSync(join(kept.path, ".git"), "utf8"), `gitdir: ${kept.gitDir}\n`);
  const own = join(dir, "own-worktree");
  git(repo, ["worktree", "add", "-q", "--detach", own]);
  mkdirSync(join(dir, "not-a-checkout"), { recursive: true });

  await sweep(dev);
  assert.equal(existsSync(left.path), false);
  assert.deepEqual(worktrees(repo), [repo, kept.path, own].sort(byCodeUnit));
  await sweep(join(dir, "no-such-folder"));
});

await test("an inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE sends none of git's calls to another repository", async (t) => {
  const { repo } = checkout();
  const { repo: decoy } = checkout();
  const index = readFileSync(join(decoy, ".git", "index"));
  process.env["GIT_DIR"] = join(decoy, ".git");
  process.env["GIT_WORK_TREE"] = decoy;
  process.env["GIT_INDEX_FILE"] = join(decoy, ".git", "index");
  const restore = (): void => {
    for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      Reflect.deleteProperty(process.env, variable);
    }
  };
  t.after(restore);
  const worktree = await open(repo, jobId());
  writeFileSync(join(worktree.path, "notes.txt"), "changed\n");
  const diff = await collect(worktree);
  await close(worktree);
  await sweep(join(repo, ".."));
  restore();

  assert.match(diff, /^\+changed\n/m);
  assert.equal(worktree.base, git(repo, ["rev-parse", "HEAD"]).trim());
  assert.deepEqual(worktrees(repo), [repo]);
  assert.deepEqual(worktrees(decoy), [decoy]);
  assert.deepEqual(readFileSync(join(decoy, ".git", "index")), index);
  assert.equal(git(decoy, ["status", "--porcelain"]), "");
});
