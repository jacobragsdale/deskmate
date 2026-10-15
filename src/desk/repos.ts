/** Local checkouts: which team repos sit under ~/dev, what branch each is on, and how to fetch one that is missing. */

import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isUnder, parseRemote } from "../core/remotes.ts";
import type { Remote } from "../core/remotes.ts";
import { byCodeUnit } from "../core/text.ts";

const CLONE_TIMEOUT = 600; // Seconds a clone may take.
const STATUS_TIMEOUT = 20;
const REMOTE_TIMEOUT = 60; // Seconds git may take to ask a remote which branches it has.
const PUSH_TIMEOUT = 600; // Seconds a push may take.
const WORKFLOWS = [".player-two", "workflows"]; // Where a repo keeps the workflows its channel's members publish from.
export const MOST_WORKFLOW = 64_000; // Bytes of a workflow's file read: more than one event can carry.
const MOST_WORKFLOWS = 100; // Workflow files listed from one folder.

export interface Checkout {
  readonly remote: Remote;
  readonly path: string;
  readonly branch: string;
  readonly defaultBranch: string | null; // The branch its origin calls the default, as git clone notes it; null when nothing does, as after git init.
}

/** Where a checkout stands: its branch, the commit it is at, and whether it has changes nobody has committed. */
export interface Head {
  readonly branch: string;
  readonly commit: string;
  readonly dirty: boolean;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The URL of a checkout's `origin` remote, read from its .git/config; null when it has none. */
export function origin(path: string): string | null {
  // ponytail: reads the file directly, so `include` files and `insteadOf` rewrites are not followed. Ask git if that bites.
  let section = "";
  for (const raw of (readOrNull(join(path, ".git", "config")) ?? "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const found = /^url\s*=\s*(.+)/.exec(line);
    if (line.startsWith("[")) {
      section = line.replaceAll(" ", "").toLowerCase();
    } else if (section === '[remote"origin"]' && found?.[1] !== undefined) {
      return found[1].trim();
    }
  }
  return null;
}

/**
 * What a checkout's HEAD, or another ref of its own, holds: "ref: " and the ref it points to, or a commit; undefined when it has none. Read from its file, except in a repository whose refs
 * are in a reftable, which only git reads: its .git/HEAD holds only "ref: refs/heads/.invalid", so that a git too old to read them takes it for no repository, and git is asked.
 */
async function refIn(path: string, ref: string): Promise<string | undefined> {
  if (readOrNull(join(path, ".git", "HEAD"))?.trim() !== "ref: refs/heads/.invalid") {
    return readOrNull(join(path, ".git", ref))?.trim();
  }
  const to = await git(["-C", path, "symbolic-ref", "-q", ref], STATUS_TIMEOUT);
  if (to.ok) {
    return `ref: ${to.stdout.trim()}`;
  }
  const commit = await git(["-C", path, "rev-parse", "-q", "--verify", ref], STATUS_TIMEOUT); // A detached head points to no ref.
  return commit.ok ? commit.stdout.trim() : undefined;
}

/** The branch a checkout is on as it is now: "detached at a1b2c3d" for a detached head, and "unknown" when there is none to read. */
export async function branchOf(path: string): Promise<string> {
  const head = await refIn(path, "HEAD");
  if (head === undefined) {
    return "unknown";
  }
  return head.startsWith("ref: ") ? head.replace(/^ref: refs\/heads\//, "") : `detached at ${head.slice(0, 7)}`;
}

async function defaultBranchOf(path: string): Promise<string | null> {
  const head = (await refIn(path, "refs/remotes/origin/HEAD")) ?? "";
  return head.startsWith("ref: refs/remotes/origin/") ? head.slice("ref: refs/remotes/origin/".length) : null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `path` is a folder itself, and not a link to one. */
function isOwnFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folder a checkout keeps its workflows in, when it has one and neither it nor .player-two is a link, which would let a repo lead the desk to read files outside it; null otherwise. */
export function workflowFolder(checkout: string): string | null {
  const folder = join(checkout, ...WORKFLOWS);
  return isOwnFolder(join(checkout, ".player-two")) && isOwnFolder(folder) ? folder : null;
}

/**
 * The text of the file `name` in a checkout's workflow folder, when it is a file itself, not a link, of at most MOST_WORKFLOW bytes; null otherwise. The name comes from a repo, so one that
 * is not a plain file name, as "../x" is not, reads nothing.
 */
export function workflowFile(checkout: string, name: string): string | null {
  const folder = workflowFolder(checkout);
  if (folder === null || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    return null;
  }
  let fd: number;
  try {
    fd = openSync(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW); // A link, even one put there since the folder was listed, is not opened.
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= MOST_WORKFLOW ? readFileSync(fd, "utf8") : null;
  } finally {
    closeSync(fd);
  }
}

/** The workflow files a checkout keeps: each file in its workflow folder named .yml or .yaml, by name, never a link, at most MOST_WORKFLOWS, with its text (see `workflowFile`). */
export function workflowFiles(checkout: string): { readonly name: string; readonly text: string | null }[] {
  const folder = workflowFolder(checkout);
  let names: string[] = [];
  try {
    names = folder === null ? [] : readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isFile() && /\.ya?ml$/i.test(entry.name) ? [entry.name] : []));
  } catch {
    // A folder that cannot be read lists nothing.
  }
  return names
    .sort(byCodeUnit)
    .slice(0, MOST_WORKFLOWS)
    .map((name) => ({ name, text: workflowFile(checkout, name) }));
}

/** The team's repos checked out directly under `dev`, by name. With two clones of one repo, the folder named like the repo wins. */
export async function scan(dev: string, prefix: string): Promise<Checkout[]> {
  const found = new Map<string, Checkout>();
  const folders = isDirectory(dev) ? readdirSync(dev).sort(byCodeUnit) : [];
  for (const folder of folders) {
    const path = join(dev, folder);
    const remote = isDirectory(join(path, ".git")) ? parseRemote(origin(path) ?? "") : null;
    if (remote !== null && isUnder(remote.key, prefix) && (!found.has(remote.name) || folder.toLowerCase() === remote.name)) {
      found.set(remote.name, { remote, path, branch: await branchOf(path), defaultBranch: await defaultBranchOf(path) });
    }
  }
  return [...found.values()].sort((a, b) => byCodeUnit(a.remote.name, b.remote.name));
}

interface GitResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

// What a git that started this process, from a hook say, leaves set to send git to its own repository, as `git rev-parse --local-env-vars` lists them; and GIT_DIFF_OPTS,
// which overrides the context lines a diff is asked for. Not passed on: every call here names the repository it means.
const NOT_PASSED = new Set([
  ...["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE"],
  ...["GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR", "GIT_DIFF_OPTS"]
]);

/**
 * Run git with no terminal to prompt on, within a time limit, with `input` on its standard input. Resolves however it ends. `own` is set over what is passed on, for a call that names
 * a variable of git's itself, as one that gives git an index of its own does.
 */
export function git(args: readonly string[], timeoutSeconds: number, input = "", own: Readonly<Record<string, string>> = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    // No terminal prompt: there is no terminal to ask on, so git must fail rather than wait for a password.
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !NOT_PASSED.has(name))), GIT_TERMINAL_PROMPT: "0", ...own };
    const child = execFile("git", args, { timeout: timeoutSeconds * 1000, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, timedOut: error?.killed === true, stdout, stderr });
    });
    child.stdin?.on("error", () => undefined); // git may go before it has read it all, as when it refuses a patch: how it ended says why.
    child.stdin?.end(input);
  });
}

/** Git's last words on a failed run. */
function lastWords(result: GitResult): string {
  return result.timedOut ? `no answer within ${String(STATUS_TIMEOUT)} seconds` : (result.stderr.trim().split("\n").at(-1) ?? "");
}

/**
 * Where a checkout stands right now. Rejects when git cannot say which commit it is at, as in a repository with no commits yet,
 * or whether anything is uncommitted, as with a corrupt index: what is recorded about a run must be what git said, not a guess.
 */
export async function describe(checkout: Checkout): Promise<Head> {
  const [head, status] = await Promise.all([git(["-C", checkout.path, "rev-parse", "HEAD"], STATUS_TIMEOUT), git(["-C", checkout.path, "status", "--porcelain"], STATUS_TIMEOUT)]);
  const commit = head.stdout.trim();
  if (!head.ok || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
    throw new Error(`git cannot say which commit ${checkout.path} is at: ${lastWords(head)}`);
  }
  if (!status.ok) {
    throw new Error(`git cannot say whether ${checkout.path} has uncommitted changes: ${lastWords(status)}`);
  }
  return { branch: await branchOf(checkout.path), commit, dirty: status.stdout.trim() !== "" };
}

/** The commit a checkout is on, which a run on a clean copy of it starts from; "" when git cannot say, as in a repository with no commits yet. */
export async function commitOf(path: string): Promise<string> {
  const head = await git(["-C", path, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], STATUS_TIMEOUT);
  return head.ok ? head.stdout.trim() : "";
}

/** Clone a repo with the user's own git credentials. Rejects with git's last words when it fails. */
export async function clone(url: string, destination: string): Promise<void> {
  if (!url.startsWith("https://")) {
    throw new Error(`refusing to clone ${JSON.stringify(url)}: not an https URL`);
  }
  if (existsSync(destination)) {
    throw new Error(`${destination} already exists`);
  }
  const done = await git(["clone", "--", url, destination], CLONE_TIMEOUT);
  if (done.timedOut) {
    throw new Error(`git clone did not finish within ${String(CLONE_TIMEOUT)} seconds`);
  }
  if (!done.ok) {
    const lastWords = done.stderr.trim().split("\n").at(-1) ?? "";
    throw new Error(`${lastWords === "" ? "git clone failed" : lastWords}. Try it yourself: git clone ${url} ${destination}`);
  }
}

/**
 * Whether git may be given `branch` to push: a name git would read as an option, or that a refspec would read as more than a branch, "+x" as forcing x and "a:b" as pushing a to b,
 * ":main" as deleting main, never is. A branch the desk is told of is a teammate's text.
 */
export function pushable(branch: string): boolean {
  return !/^[-+]/.test(branch) && !branch.includes(":");
}

/**
 * The subjects of the commits `rev` has that origin's `target` lacks, as git last fetched it, oldest first: what a pull request from it into `target` holds. Only `rev`'s own, when
 * git has no copy of origin's `target` to tell them by.
 */
export async function subjects(path: string, rev: string, target: string): Promise<string[]> {
  const lines = (result: GitResult): string[] => result.stdout.split("\n").filter((line) => line !== "");
  const since = await git(["-C", path, "log", "--no-show-signature", "--reverse", "--format=%s", `refs/remotes/origin/${target}..${rev}`, "--"], STATUS_TIMEOUT);
  if (since.ok) {
    return lines(since);
  }
  const last = await git(["-C", path, "log", "--no-show-signature", "-1", "--format=%s", rev, "--"], STATUS_TIMEOUT);
  if (!last.ok) {
    throw new Error(`git cannot read ${rev} in ${path}: ${lastWords(last)}`);
  }
  return lines(last);
}

/**
 * How origin's `branch` stands beside `rev` in the checkout, as git ls-remote says now: "absent" when origin has no such branch, "ahead" when `rev` holds commits origin's branch
 * lacks, and null when origin has all of them, ahead of it or not. The branch is never put on git's command line: every branch origin has is listed, and it is looked for among them.
 */
export async function aheadOfOrigin(path: string, rev: string, branch: string): Promise<"absent" | "ahead" | null> {
  const ours = await git(["-C", path, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], STATUS_TIMEOUT);
  if (!ours.ok) {
    throw new Error(`git cannot say which commit ${rev} is in ${path}`);
  }
  const heads = await git(["-C", path, "ls-remote", "--heads", "origin"], REMOTE_TIMEOUT);
  if (!heads.ok) {
    throw new Error(`git could not ask origin which branches it has: ${heads.timedOut ? `no answer within ${String(REMOTE_TIMEOUT)} seconds` : (heads.stderr.trim().split("\n").at(-1) ?? "")}`);
  }
  const theirs = heads.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
  if (theirs === undefined) {
    return "absent";
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(theirs) || theirs === ours.stdout.trim()) {
    return null;
  }
  // Ahead when origin's commit is one of ours: one git does not have, or that has commits ours lacks, is not, and pushing would be refused.
  return (await git(["-C", path, "merge-base", "--is-ancestor", theirs, ours.stdout.trim()], STATUS_TIMEOUT)).ok ? "ahead" : null;
}

/** Where git pushes the checkout's origin to, as its configuration says, rewrites and all. */
export async function pushUrl(path: string): Promise<string> {
  const url = await git(["-C", path, "remote", "get-url", "--push", "origin"], STATUS_TIMEOUT);
  if (!url.ok) {
    throw new Error(`git cannot say where ${path}'s origin is: ${lastWords(url)}`);
  }
  return url.stdout.trim();
}

/** Push `branch` to origin and have it track origin's, with the user's own git credentials: `git push -u origin -- <branch>`. A branch that is not `pushable` is refused. */
export async function push(path: string, branch: string): Promise<void> {
  if (!pushable(branch)) {
    throw new Error(`refusing to push ${JSON.stringify(branch)}: git would read it as more than a branch`);
  }
  const done = await git(["-C", path, "push", "-u", "origin", "--", branch], PUSH_TIMEOUT);
  if (!done.ok) {
    throw new Error(`git push failed: ${done.timedOut ? `no answer within ${String(PUSH_TIMEOUT)} seconds` : (done.stderr.trim().split("\n").at(-1) ?? "")}`);
  }
}
