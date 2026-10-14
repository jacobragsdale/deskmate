/** Local checkouts: which team repos sit under ~/dev, what branch each is on, and how to fetch one that is missing. Mirrors src/deskmate/repos.py. */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { byCodeUnit } from "./text.ts";
import { REPO_NAME } from "./wire.ts";

const CLONE_TIMEOUT = 600; // Seconds a clone may take.
const STATUS_TIMEOUT = 20;
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/; // git@host:path
const URL_LIKE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/; // scheme://[user@]host[:port]/path
const AZURE = "dev.azure.com";
const WHOLE_REPO_NAME = new RegExp(`^${REPO_NAME}$`);

/** A repo as everyone can refer to it, whatever form their own remote URL takes. */
export interface Remote {
  readonly key: string; // Lowercase "host/path", the same for the https and ssh forms of one repo.
  readonly name: string; // What people type to tag it: the last part of the path, lowercase.
  readonly url: string; // An https URL to clone it from, with no credentials in it.
}

export interface Checkout {
  readonly remote: Remote;
  readonly path: string;
  readonly branch: string;
}

interface Located {
  readonly host: string;
  readonly segments: readonly string[];
}

/** Percent-decode what can be decoded and leave the rest alone, as Python's unquote does with a stray "%". */
function unquote(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Percent-encode one path segment exactly as Python's quote does, so every client arrives at the same key for one repo. */
function quote(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The host of a URL's "user:password@host:port" part, lowercase; "" when there is none. */
function hostOf(netloc: string): string {
  const hostPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const bracketed = /^\[([^\]]*)\]/.exec(hostPort);
  return (bracketed?.[1] ?? hostPort.split(":")[0] ?? "").toLowerCase();
}

/** The host and path of a remote in either form git accepts: "git@host:path" or "scheme://[user@]host[:port]/path". */
function hostAndPath(text: string): readonly [string, string] | null {
  const scp = SCP_LIKE.exec(text);
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return [scp[1].toLowerCase(), scp[2]];
  }
  const url = URL_LIKE.exec(text);
  const host = hostOf(url?.[2] ?? "");
  return ["https", "http", "ssh", "git"].includes((url?.[1] ?? "").toLowerCase()) && host !== "" ? [host, url?.[3] ?? ""] : null;
}

/** Split a remote URL into host and path parts, folding every Azure DevOps form onto dev.azure.com/org/… */
function locate(remote: string): Located | null {
  const found = hostAndPath(unquote(remote.trim()));
  if (found === null) {
    return null;
  }
  const [host, path] = found;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = (trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed).split("/").filter((segment) => segment !== "");
  if (["ssh.dev.azure.com", "vs-ssh.visualstudio.com"].includes(host) && segments[0] === "v3") {
    return { host: AZURE, segments: segments.slice(1) };
  }
  if (host.endsWith(".visualstudio.com")) {
    // The older address: org.visualstudio.com/[DefaultCollection/]project/_git/repo
    return { host: AZURE, segments: [host.slice(0, -".visualstudio.com".length), ...segments.filter((segment) => segment.toLowerCase() !== "defaultcollection")] };
  }
  return { host, segments };
}

/** The key every repo under an organisation's URL starts with, such as "dev.azure.com/acme". */
export function prefixKey(url: string): string {
  const located = locate(url);
  if (located === null) {
    throw new Error(`not a repository host URL: ${JSON.stringify(url)}`);
  }
  return [located.host, ...located.segments.map(quote)].join("/").toLowerCase();
}

export function isUnder(key: string, prefix: string): boolean {
  return key.startsWith(`${prefix.replace(/\/+$/, "")}/`);
}

/** Work out which repo a remote URL points at. Null when it is not a URL or its name cannot be used as a tag. */
export function parseRemote(remote: string): Remote | null {
  const located = locate(remote);
  if (located === null) {
    return null;
  }
  const { host } = located;
  let segments = located.segments;
  let url: string;
  if (host === AZURE) {
    segments = segments.filter((segment) => segment !== "_git");
    const [org, project, repo = project] = segments; // org/_git/repo: the short address of a repo named after its project.
    if (org === undefined || project === undefined || repo === undefined || segments.length > 3) {
      return null;
    }
    segments = [org, project, repo];
    url = `https://${AZURE}/${quote(org)}/${quote(project)}/_git/${quote(repo)}`;
  } else if (segments.length >= 2) {
    url = `https://${host}/${segments.map(quote).join("/")}`;
  } else {
    return null;
  }
  const name = (segments.at(-1) ?? "").toLowerCase();
  if (!WHOLE_REPO_NAME.test(name)) {
    return null;
  }
  return { key: [host, ...segments.map(quote)].join("/").toLowerCase(), name, url };
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
