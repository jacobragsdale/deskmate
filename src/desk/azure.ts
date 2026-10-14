/**
 * Azure DevOps, called by the desk with the person's own token. The hub never holds a token and never calls Azure.
 * Every call answers with what it found or a problem in words, and neither ever holds the token.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { problemOf } from "../core/text.ts";
import type { RepoRef } from "../core/wire.ts";

export const AZURE = "https://dev.azure.com";
const API_VERSION = "7.1";
const CALL_LIMIT = 10; // Seconds one call may take, its answer read to the end.
const GIT_LIMIT = 10; // Seconds git's credential helper gets to answer.
const TOKEN_FILE = "azure.json"; // In the identity's folder, mode 0600; the setup page saves it.
const NO_TOKEN = "no Azure DevOps token: set AZURE_DEVOPS_EXT_PAT, save one on the setup page, or sign in to dev.azure.com with git's credential helper";
const FROM_GIT = "git's credential helper";

/** What a call found, or why it found nothing, in words for the user. */
export type Answer<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problem: string };

/** A token and where it came from, as the user would name the place. */
export interface Token {
  readonly secret: string;
  readonly source: string;
}

/** How a call is signed in: the Authorization header, and where its token came from. */
interface Credential {
  readonly authorization: string;
  readonly source: string;
}

/** A repo's two REST addresses: its project's, which builds hang off, and its own. */
interface Endpoints {
  readonly project: string;
  readonly repo: string;
}

interface Request {
  readonly route: (at: Endpoints) => string;
  readonly query?: Readonly<Record<string, string>>;
  readonly post?: unknown; // A body to POST as JSON; a GET without it.
  readonly what: string; // What a 404 means was not found.
}

/** An answer as it came: its status, and its body read as JSON, or undefined when it was not JSON. */
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const savedSchema = z.object({ token: z.string().min(1) });
const credentialSchema = z.object({ password: z.string().min(1) });

/** Read a value that holds a branch's full name, "refs/heads/feature/retry", as "feature/retry". */
const branchNameSchema = z.string().transform((name) => name.replace(/^refs\/heads\//, ""));

// Each answer is read with z.object, which keeps the fields named and passes over the rest: an answer has dozens, and Azure adds more.
const repositorySchema = z.object({ id: z.string(), defaultBranch: branchNameSchema.optional() }).transform((repo) => ({ id: repo.id, defaultBranch: repo.defaultBranch ?? null }));

const failureSchema = z.object({ message: z.string() }); // What Azure DevOps answers a request it refuses with, among other fields.

export type Repository = z.output<typeof repositorySchema> & { readonly web: string };

/**
 * The password git's credential helper holds for a URL, asked with `git credential fill`; null when it has none or does not answer in time.
 * Nothing may ask the user: there is no terminal, and no askpass program or Git Credential Manager window may open while the desk waits.
 */
export function gitPassword(url: string, limitSeconds = GIT_LIMIT): Promise<string | null> {
  return new Promise((resolve) => {
    // An empty GIT_ASKPASS also keeps git from core.askPass and SSH_ASKPASS. Its own process group, so a helper that hangs goes when git does.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" };
    const child = spawn("git", ["credential", "fill"], { stdio: ["pipe", "pipe", "ignore"], detached: true, env });
    let printed = "";
    const timer = setTimeout(() => {
      if (child.pid === undefined) {
        return; // It never started; the "error" event has answered.
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // No such group: git has already gone.
      }
    }, limitSeconds * 1000);
    const done = (code: number | null): void => {
      clearTimeout(timer);
      // What git prints is "key=value" lines: protocol, host, username, password.
      const fields = printed.split("\n").map((line): [string, string] => {
        const at = line.indexOf("=");
        return at === -1 ? [line, ""] : [line.slice(0, at), line.slice(at + 1)];
      });
      const found = credentialSchema.safeParse(Object.fromEntries(fields));
      resolve(code === 0 && found.success ? found.data.password : null);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      printed += chunk;
    });
    child.stdin.on("error", () => undefined); // Git went before it read the question; "close" says how it ended.
    child.on("error", () => {
      done(null); // There is no git here.
    });
    child.on("close", done);
    child.stdin.end(`url=${url}\n\n`);
  });
}

function savedToken(home: string): string | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(home, TOKEN_FILE), "utf8"));
    return savedSchema.parse(saved).token;
  } catch {
    return null; // None saved, or not as the setup page writes one.
  }
}

/** The token for a repo, looked for in this order: the environment, the file the setup page saves in `home`, and git's credential helper for the repo's address. */
export async function findToken(home: string, url: string): Promise<Token | null> {
  const fromEnvironment = process.env["AZURE_DEVOPS_EXT_PAT"] ?? "";
  if (fromEnvironment !== "") {
    return { secret: fromEnvironment, source: "AZURE_DEVOPS_EXT_PAT" };
  }
  const saved = savedToken(home);
  if (saved !== null) {
    return { secret: saved, source: join(home, TOKEN_FILE) };
  }
  const fromGit = await gitPassword(url);
  return fromGit === null ? null : { secret: fromGit, source: FROM_GIT };
}

/** How to send a token: as Basic authentication, and one from git also as a Bearer token, which an OAuth token from Git Credential Manager needs. */
function credentials(token: Token): Credential[] {
  const basic = { authorization: `Basic ${Buffer.from(`:${token.secret}`).toString("base64")}`, source: token.source };
  return token.source === FROM_GIT ? [basic, { authorization: `Bearer ${token.secret}`, source: token.source }] : [basic];
}

/** The REST addresses of a repo whose key is "dev.azure.com/{organisation}/{project}/{repo}", each part already percent-encoded. Null for a repo anywhere else. */
function endpointsOf(ref: RepoRef, base: string): Endpoints | null {
  const [host, organisation, project, repo, ...more] = ref.key.split("/");
  if (host !== "dev.azure.com" || organisation === undefined || project === undefined || repo === undefined || more.length > 0) {
    return null;
  }
  const api = `${base}/${organisation}/${project}/_apis`;
  return { project: api, repo: `${api}/git/repositories/${repo}` };
}

/** Whether an answer is a sign-in page rather than data. Azure DevOps answers a call it will not let in with 203 and a page of HTML, not 401. */
function signInPage(reply: Reply): boolean {
  return reply.status === 203 || reply.status === 401 || (reply.status >= 200 && reply.status < 300 && reply.body === undefined);
}

function read<T>(reply: Reply, schema: z.ZodType<T>, what: string): Answer<T> {
  if (reply.status === 404) {
    return { ok: false, problem: `Azure DevOps has no ${what}, or the token cannot see it` };
  }
  if (reply.status < 200 || reply.status >= 300) {
    const refused = failureSchema.safeParse(reply.body);
    return { ok: false, problem: `Azure DevOps answered ${String(reply.status)}${refused.success ? `: ${refused.data.message}` : ""}` };
  }
  const found = schema.safeParse(reply.body);
  return found.success ? { ok: true, data: found.data } : { ok: false, problem: `Azure DevOps answered for ${what} with something this version cannot read: ${problemOf(found.error)}` };
}

export class Azure {
  private readonly home: string;
  private readonly base: string;
  private readonly limit: number;
  private kept: Credential | null = null; // What got the last call in, used for the rest of the session.

  /** `home` is the identity's folder; `base` is where Azure DevOps is, which only a test changes. */
  constructor(home: string, base = AZURE, limitSeconds = CALL_LIMIT) {
    this.home = home;
    this.base = base;
    this.limit = limitSeconds;
  }

  /** A repository's id, its default branch (null while it has no commits) and its address in the browser. */
  public async repository(ref: RepoRef): Promise<Answer<Repository>> {
    const found = await this.call(ref, { route: (at) => at.repo, what: `repository ${ref.name}` }, repositorySchema);
    return found.ok ? { ok: true, data: { ...found.data, web: ref.url } } : found;
  }

  private async send(url: string, authorization: string, post: unknown): Promise<Reply | string> {
    try {
      const headers = { Authorization: authorization, Accept: "application/json", ...(post === undefined ? {} : { "Content-Type": "application/json" }) };
      const method = post === undefined ? "GET" : "POST";
      const response = await fetch(url, { method, headers, body: post === undefined ? null : JSON.stringify(post), signal: AbortSignal.timeout(this.limit * 1000) });
      const text = await response.text();
      try {
        const body: unknown = JSON.parse(text);
        return { status: response.status, body };
      } catch {
        return { status: response.status, body: undefined };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return `Azure DevOps did not answer within ${String(this.limit)} seconds`;
      }
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
      return `cannot reach Azure DevOps at ${this.base}: ${problemOf(error)}${cause}`;
    }
  }

  /** Make one call with the credential that got in last, or else with the token found, which for one from git is tried once more as a Bearer token. */
  private async call<T>(ref: RepoRef, request: Request, schema: z.ZodType<T>): Promise<Answer<T>> {
    const at = endpointsOf(ref, this.base);
    if (at === null) {
      return { ok: false, problem: `${ref.name} is not on Azure DevOps` };
    }
    const url = `${request.route(at)}?${new URLSearchParams({ ...request.query, "api-version": API_VERSION }).toString()}`;
    const kept = this.kept;
    const token = kept === null ? await findToken(this.home, ref.url) : null;
    const tries = kept === null ? (token === null ? [] : credentials(token)) : [kept];
    for (const credential of tries) {
      const reply = await this.send(url, credential.authorization, request.post);
      if (typeof reply === "string") {
        return { ok: false, problem: reply };
      }
      if (!signInPage(reply)) {
        this.kept = credential;
        return read(reply, schema, request.what);
      }
    }
    this.kept = null; // Look again next time: the token may have expired, or another been saved.
    const source = tries[0]?.source;
    return { ok: false, problem: source === undefined ? NO_TOKEN : `not signed in to Azure DevOps: the token from ${source} was not accepted` };
  }
}
