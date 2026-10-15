/**
 * Applying a patch from the chat to one of the user's checkouts with git apply. The diff is someone else's: it only ever reaches git on its standard input, never a word of it on git's
 * command line, and git is never given --unsafe-paths. Which paths it names is checked before any of this (`unsafePaths` in src/core/diff.ts).
 */

import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { parseDiff } from "../core/diff.ts";
import { git } from "./repos.ts";

const LIMIT = 120; // Seconds one git call may take.

/** git's last line on standard error, which says why it would not. */
function lastWords(stderr: string): string {
  return stderr.trim().split("\n").at(-1) ?? "";
}

/** Whether git, applying three ways, left a file with conflict markers in it for the user to resolve. */
function conflicted(stderr: string): boolean {
  return /^Applied patch to .* with conflicts\.$/m.test(stderr);
}

/**
 * Whether the patch applies to the checkout as it stands, three ways where its context has moved on, as `apply` would apply it: rejects with git's words when it does not, as when a file
 * it changes has changes of the user's that are not committed. Resolves with whether it would leave conflicts.
 */
export async function check(path: string, diff: string): Promise<{ readonly conflicts: boolean }> {
  const done = await git(["-C", path, "apply", "--check", "--3way"], LIMIT, diff);
  if (!done.ok) {
    throw new Error(`it does not apply to ${path}: ${done.timedOut ? `git gave no answer within ${String(LIMIT)} seconds` : lastWords(done.stderr)}`);
  }
  return { conflicts: conflicted(done.stderr) };
}

/** Apply the patch to the checkout's working tree and index, three ways. Resolves with whether it left conflicts to resolve; rejects with git's words when it applied nothing. */
export async function apply(path: string, diff: string): Promise<{ readonly conflicts: boolean }> {
  const done = await git(["-C", path, "apply", "--3way"], LIMIT, diff);
  if (!done.ok && !conflicted(done.stderr)) {
    throw new Error(`git apply failed in ${path}: ${done.timedOut ? `no answer within ${String(LIMIT)} seconds` : lastWords(done.stderr)}`);
  }
  return { conflicts: !done.ok };
}

/** What git printed, or a rejection that says `what` failed, with git's words. */
async function run(args: readonly string[], what: string, input = "", own: Readonly<Record<string, string>> = {}): Promise<string> {
  const done = await git(args, LIMIT, input, own);
  if (!done.ok) {
    throw new Error(`${what}: ${done.timedOut ? `git gave no answer within ${String(LIMIT)} seconds` : lastWords(done.stderr)}`);
  }
  return done.stdout;
}

/** Hand `use` an index of its own, holding the tree of `base` in the checkout's repository, in a folder of its own that is removed afterwards. */
async function onIndex<T>(path: string, base: string, use: (own: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), "player-two-index-"));
  const own = { GIT_INDEX_FILE: join(folder, "index") };
  try {
    await run(["-C", path, "read-tree", base], `git read-tree in ${path}`, "", own);
    return await use(own);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Whether the patch applies to `base`, as a new branch `branch` would hold it: rejects when the checkout's repository lacks that commit, as when it has not been fetched, when it has a
 * branch of that name already, or when the patch does not apply to it as it is. Nothing is written but a scratch index.
 */
export async function checkBranch(path: string, base: string, branch: string, diff: string): Promise<void> {
  if (!(await git(["-C", path, "cat-file", "-e", `${base}^{commit}`], LIMIT)).ok) {
    throw new Error(`the commit it was made on, ${base.slice(0, 7)}, is not in ${path}: fetch it, or apply the patch to your branch`);
  }
  if ((await git(["-C", path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], LIMIT)).ok) {
    throw new Error(`${path} has a branch ${branch} already`);
  }
  await onIndex(path, base, (own) => run(["-C", path, "apply", "--cached", "--check"], `it does not apply to ${base.slice(0, 7)}`, diff, own));
}

/**
 * Make the branch `branch` at one commit on `base` that holds the patch, with `title` as its message, by the user as git knows them: in an index of its own, so that neither the branch
 * the checkout is on, nor its working tree, nor its index is touched, and nothing the patch wrote is ever checked out. The title, someone else's, goes to git on standard input too.
 */
export async function commitBranch(path: string, base: string, branch: string, diff: string, title: string): Promise<void> {
  const tree = await onIndex(path, base, async (own) => {
    await run(["-C", path, "apply", "--cached"], `git apply failed in ${path}`, diff, own);
    return (await run(["-C", path, "write-tree"], `git write-tree in ${path}`, "", own)).trim();
  });
  const commit = (await run(["-C", path, "commit-tree", tree, "-p", base], `git commit-tree in ${path}`, `${title}\n`)).trim();
  await run(["-C", path, "update-ref", `refs/heads/${branch}`, commit, ""], `git update-ref in ${path}`); // "" as the old value: only while there is no such branch.
}

/**
 * Refuse a patch, before git sees it, that would write through a symbolic link in the checkout: git apply looks for one only in its index, so a folder the user has as a link git does not
 * track would take the patch's files wherever it points. Each folder leading to each path in the diff is looked at as it is, not followed: a link, or one that is somewhere other than
 * inside the checkout, refuses it. One that is not there is made by git, inside the one before it. The paths have been read already (`unsafePaths`): none is absolute or has a "..".
 */
export function refuseLinks(path: string, diff: string): void {
  const root = realpathSync(path);
  for (const name of new Set(parseDiff(diff).flatMap((file) => file.paths))) {
    const parts = name.split("/").slice(0, -1);
    for (let at = 1; at <= parts.length; at += 1) {
      const folder = join(path, ...parts.slice(0, at));
      let link: boolean;
      try {
        link = lstatSync(folder).isSymbolicLink();
      } catch {
        break; // Not there.
      }
      const inside = relative(root, realpathSync(folder));
      if (link || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) {
        throw new Error(`not applied: ${plain(name)} is in ${plain(parts.slice(0, at).join("/"))}, which in ${path} is a link to elsewhere, so git would write where it points`);
      }
    }
  }
}

/** Text from someone else's diff as a dialog may show it: each control or formatting character written as its code, so that a name can neither add a line to the dialog nor turn its text around. */
export function plain(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`);
}

const NAME = 200; // Characters of a file's name a dialog shows.

/** A file's name from someone else's diff as a dialog shows it: plain, and when that is longer than NAME characters, its end, which says which file it is, after an ellipsis. */
export function named(name: string): string {
  const characters = Array.from(plain(name));
  return characters.length <= NAME ? characters.join("") : `…${characters.slice(1 - NAME).join("")}`;
}

/** Files' names for one line of a dialog, each `named`: the first five, and how many more. */
export function listed(names: readonly string[]): string {
  return `${names.slice(0, 5).map(named).join(", ")}${names.length > 5 ? ` and ${String(names.length - 5)} more` : ""}`;
}
