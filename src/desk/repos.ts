/** Local checkouts: which team repos sit under ~/dev, what branch each is on, and how to fetch one that is missing. Mirrors src/deskmate/repos.py. */

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

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function origin(path: string): string | null {
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

function git(args: readonly string[], timeoutSeconds: number): Promise<GitResult> {
  return new Promise((resolve) => {
    // No terminal prompt: there is no terminal to ask on, so git must fail rather than wait for a password.
    const child = execFile("git", args, { timeout: timeoutSeconds * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, timedOut: error?.killed === true, stdout, stderr });
    });
    child.stdin?.end();
  });
}

/** The branch a checkout is on right now, marked ± when it has uncommitted changes. */
export async function describe(checkout: Checkout): Promise<string> {
  const status = await git(["-C", checkout.path, "status", "--porcelain"], STATUS_TIMEOUT);
  return `${branchOf(checkout.path)}${status.stdout.trim() === "" ? "" : " ±"}`;
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
