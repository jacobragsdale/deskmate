/** Local checkouts: which team repos sit under ~/dev, what branch each is on, and how to fetch one that is missing. */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isUnder, parseRemote } from "../core/remotes.ts";
import type { Remote } from "../core/remotes.ts";
import { byCodeUnit } from "../core/text.ts";

const CLONE_TIMEOUT = 600; // Seconds a clone may take.
const STATUS_TIMEOUT = 20;

export interface Checkout {
  readonly remote: Remote;
  readonly path: string;
  readonly branch: string;
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

function branchOf(path: string): string {
  const head = readOrNull(join(path, ".git", "HEAD"))?.trim();
  if (head === undefined) {
    return "unknown";
  }
  return head.startsWith("ref: ") ? head.replace(/^ref: refs\/heads\//, "") : `detached at ${head.slice(0, 7)}`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The team's repos checked out directly under `dev`, by name. With two clones of one repo, the folder named like the repo wins. */
export function scan(dev: string, prefix: string): Checkout[] {
  const found = new Map<string, Checkout>();
  const folders = isDirectory(dev) ? readdirSync(dev).sort(byCodeUnit) : [];
  for (const folder of folders) {
    const path = join(dev, folder);
    const remote = isDirectory(join(path, ".git")) ? parseRemote(origin(path) ?? "") : null;
    if (remote !== null && isUnder(remote.key, prefix) && (!found.has(remote.name) || folder.toLowerCase() === remote.name)) {
      found.set(remote.name, { remote, path, branch: branchOf(path) });
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

/** Run git with no terminal to prompt on, within a time limit. Resolves however it ends. */
export function git(args: readonly string[], timeoutSeconds: number): Promise<GitResult> {
  return new Promise((resolve) => {
    // No terminal prompt: there is no terminal to ask on, so git must fail rather than wait for a password.
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !NOT_PASSED.has(name))), GIT_TERMINAL_PROMPT: "0" };
    const child = execFile("git", args, { timeout: timeoutSeconds * 1000, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, timedOut: error?.killed === true, stdout, stderr });
    });
    child.stdin?.end();
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
  return { branch: branchOf(checkout.path), commit, dirty: status.stdout.trim() !== "" };
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
