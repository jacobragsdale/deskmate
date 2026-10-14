/** The setup check: what Player Two needs on this machine, one item at a time, each with a plain result and the command that fixes it. It never runs a fix itself. */

import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

import { z } from "zod";

import { quote } from "../core/install.ts";
import { problemOf } from "../core/text.ts";
import { configSchema, MAX_SKEW, PROTOCOL } from "../core/wire.ts";
import type { Config, HubInfo } from "../core/wire.ts";
import type { Check } from "../shared/ipc.ts";
import { splitCommand } from "./agents/oneshot.ts";
import { http, loadClient } from "./client.ts";
import type { Client } from "./client.ts";
import { git, origin, scan } from "./repos.ts";
import type { Checkout } from "./repos.ts";

const LIMIT = 20; // Seconds anything one check does may take. Each call has a shorter limit of its own; this is for what nobody foresaw.
const HUB_TIMEOUT = 10;
const GIT_TIMEOUT = 10;
const GIT_AUTH_TIMEOUT = 15;
const CLOCK_WARN = 60; // Seconds apart at which the clocks are worth a warning. At MAX_SKEW the hub refuses signatures.
const CERTIFICATE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/; // Node's codes for a certificate it does not trust.
const JOIN = "Join from the window, or run: player-two join HUB NAME TOKEN";
const ADD_CA = "sudo cp team-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates";
const SET_CLOCK = "Set this machine's clock. In WSL, run `wsl --shutdown` in PowerShell and open Player Two again: WSL takes Windows' time when it starts";
// How to install the agents the join form offers, by the program each one runs.
const INSTALL = new Map([
  ["agent", "curl https://cursor.com/install -fsS | bash"],
  ["copilot", "npm install -g @github/copilot"]
]);

const healthSchema = z.object({ ok: z.literal(true), now: z.number() });

/** The checks that need no identity: what the desk runs before anyone has joined from this machine. */
export const WITHOUT_IDENTITY: ReadonlySet<string> = new Set(["node", "dev", "git"]);

type Outcome = Pick<Check, "status" | "detail" | "fix">;
type Found<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string; readonly code: string };

function ok(detail: string): Outcome {
  return { status: "ok", detail, fix: "" };
}

function warn(detail: string, fix: string): Outcome {
  return { status: "warn", detail, fix };
}

function fail(detail: string, fix = ""): Outcome {
  return { status: "fail", detail, fix };
}

function skip(detail: string): Outcome {
  return { status: "skip", detail, fix: "" };
}

/** The error at the bottom of a chain of causes: fetch says only "fetch failed", and what failed is underneath. */
function root(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? root(error.cause) : error;
}

/** Do one thing a check needs, within LIMIT seconds. What throws or takes too long is a result like any other, so the list always comes back whole. */
async function attempt<T>(work: () => T | Promise<T>): Promise<Found<T>> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Found<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, problem: `no answer within ${String(LIMIT)} seconds`, code: "" });
    }, LIMIT * 1000);
  });
  const done = (async (): Promise<Found<T>> => ({ ok: true, value: await work() }))().catch((error: unknown): Found<T> => {
    const cause = root(error);
    return { ok: false, problem: problemOf(cause), code: cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : "" };
  });
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}

function value<T>(found: Found<T>): T | null {
  return found.ok ? found.value : null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Where `program` is on `path`, or null. A program named with a slash is looked for there and nowhere else, as a shell would. */
function findProgram(program: string, path: string): string | null {
  const candidates = program.includes("/") ? [program] : path.split(delimiter).flatMap((dir) => (dir === "" ? [] : [join(dir, program)]));
  return (
    candidates.find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Whether NO_PROXY's list names `host`: the host itself, a domain it is under, or "*". */
function exempt(host: string, list: readonly string[]): boolean {
  return list.some((entry) => {
    const domain = entry
      .replace(/^\*?\./, "")
      .replace(/:\d+$/, "")
      .toLowerCase();
    return entry === "*" || host === domain || host.endsWith(`.${domain}`);
  });
}

function nodeVersion(): Outcome {
  // On Linux and macOS the window runs the desk with its own Electron, whose Node is older and ships with it. Electron's types say `electron` is always there; under plain Node it is not.
  if (Object.hasOwn(process.versions, "electron")) {
    return ok(`Node ${process.versions.node}, inside Electron ${process.versions.electron}, which comes with the window`);
  }
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 26 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node}, and Player Two needs 26 or newer`, "Install Node 26 or newer from https://nodejs.org");
}

function identity(home: string, config: Config | null, client: Client | null): Outcome {
  const keyFile = join(home, "key");
  if (config === null || client === null) {
    const absent = [join(home, "config.json"), keyFile].filter((file) => !existsSync(file));
    return absent.length > 0
      ? fail(`not joined: there is no ${absent.map((file) => basename(file)).join(" or ")} in ${home}`, JOIN)
      : fail(`${config === null ? "config.json" : "key"} in ${home} cannot be read`, JOIN);
  }
  const mode = statSync(keyFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return fail(`${keyFile} can be read by others: its mode is ${mode.toString(8)}`, `chmod 600 ${quote(keyFile)}`);
  }
  return ok(`${config.name} on ${config.hub}`);
}

function proxy(hub: string, env: NodeJS.ProcessEnv): Outcome {
  const url = new URL(hub);
  const variable = url.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY";
  if ((env[variable] ?? env[variable.toLowerCase()] ?? "") === "") {
    return ok("no proxy is set");
  }
  const list = (env["NO_PROXY"] ?? env["no_proxy"] ?? "").split(",").flatMap((entry) => (entry.trim() === "" ? [] : [entry.trim()]));
  return exempt(url.hostname, list)
    ? ok(`a proxy is set, and NO_PROXY lets ${url.hostname} past it`)
    : warn(
        `${variable} is set and NO_PROXY does not name ${url.hostname}, so the hub is asked through the proxy, which cannot usually reach an internal address`,
        `export NO_PROXY=${[url.hostname, ...list].join(",")}`
      );
}

function clock(hubNow: number): Outcome {
  const skew = Math.round(Date.now() / 1000 - hubNow);
  const words = `this clock is ${String(Math.abs(skew))} seconds ${skew > 0 ? "ahead of" : "behind"} the hub's`;
  if (Math.abs(skew) < CLOCK_WARN) {
    return ok(`within ${String(Math.abs(skew))} seconds of the hub's`);
  }
  return Math.abs(skew) < MAX_SKEW
    ? warn(`${words}; from ${String(MAX_SKEW)} the hub refuses this machine's signatures`, SET_CLOCK)
    : fail(`${words}, so the hub refuses this machine's signatures`, SET_CLOCK);
}

/** The first folder under `dev` with an origin, for an example of what is there. */
function someOrigin(dev: string): string {
  for (const folder of readdirSync(dev)) {
    const url = origin(join(dev, folder));
    if (url !== null) {
      return `; ${folder}'s origin, for one, is ${url}`;
    }
  }
  return "";
}

async function hub(config: Config | null): Promise<{ readonly outcome: Outcome; readonly now: number | null }> {
  if (config === null) {
    return { outcome: skip("not joined, so there is no hub to ask"), now: null };
  }
  const health = await attempt(async () => healthSchema.parse(await (await fetch(`${config.hub}/healthz`, { signal: AbortSignal.timeout(HUB_TIMEOUT * 1000) })).json()));
  return health.ok
    ? { outcome: ok(`${config.hub} answers`), now: health.value.now }
    : { outcome: fail(`cannot reach ${config.hub}: ${health.problem}`, CERTIFICATE.test(health.code) ? ADD_CA : ""), now: null };
}

async function protocol(client: Client | null, hubNow: number | null): Promise<{ readonly outcome: Outcome; readonly info: HubInfo | null }> {
  if (client === null || hubNow === null) {
    return { outcome: skip(client === null ? "not joined" : "the hub does not answer"), info: null };
  }
  if (Math.abs(Date.now() / 1000 - hubNow) >= MAX_SKEW) {
    return { outcome: skip("the hub refuses this machine's signatures until the clocks agree"), info: null };
  }
  const asked = await attempt(() => client.info());
  if (!asked.ok) {
    return { outcome: fail(`the hub would not say: ${asked.problem}`), info: null };
  }
  const theirs = asked.value.protocol;
  return theirs === PROTOCOL
    ? { outcome: ok(`protocol ${String(PROTOCOL)}; the hub is version ${asked.value.version}`), info: asked.value }
    : {
        outcome: fail(`the hub speaks protocol ${String(theirs)} and this app speaks protocol ${String(PROTOCOL)}`, theirs > PROTOCOL ? "Update Player Two on this machine" : "Update the hub"),
        info: asked.value
      };
}

async function repos(dev: string, info: HubInfo | null, joined: boolean): Promise<{ readonly outcome: Outcome; readonly checkout: Checkout | undefined }> {
  if (info === null) {
    return { outcome: skip(joined ? "the hub did not say which repos it shares" : "not joined, so no hub has said which repos it shares"), checkout: undefined };
  }
  const scanned = await attempt(() => ({ found: scan(dev, info.repos), example: someOrigin(dev) }));
  if (!scanned.ok) {
    return { outcome: fail(`${dev} cannot be read: ${scanned.problem}`), checkout: undefined };
  }
  const { found, example } = scanned.value;
  return found.length === 0
    ? { outcome: warn(`no folder in ${dev} has an origin under ${info.repos}${example}`, `Clone one of the team's repos into ${dev}`), checkout: undefined }
    : { outcome: ok(found.map((each) => each.remote.name).join(", ")), checkout: found[0] };
}

async function gitAuth(checkout: Checkout): Promise<Outcome> {
  const reached = await git(["-C", checkout.path, "ls-remote", "origin", "HEAD"], GIT_AUTH_TIMEOUT);
  if (reached.ok) {
    return ok(`git reached ${checkout.remote.name}'s origin`);
  }
  const why = reached.timedOut ? `no answer within ${String(GIT_AUTH_TIMEOUT)} seconds` : (reached.stderr.trim().split("\n").at(-1) ?? "");
  return warn(
    `git could not reach ${checkout.remote.name}'s origin without asking for credentials: ${why}. Run this once by hand and let git keep them`,
    `git -C ${quote(checkout.path)} ls-remote origin`
  );
}

function agent(home: string, config: Config): Outcome {
  const program = splitCommand(config.agent)[0] ?? "";
  const where = findProgram(program, process.env["PATH"] ?? "");
  return where === null
    ? fail(`looked for ${program === "" ? "the agent" : program} on the PATH and did not find it. The agent chosen when joining is "agent" in ${join(home, "config.json")}`, INSTALL.get(program) ?? "")
    : ok(`${program} is ${where}`);
}

/** What a check found, or that it failed while looking. */
function either(found: Found<Outcome>): Outcome {
  return found.ok ? found.value : fail(found.problem);
}

/**
 * Check what Player Two needs here, in order: Node, the identity in `home`, the hub and the way to it, the clocks, the repos under `dev`, git, and the agent.
 * A check that needs what an earlier one could not find is skipped and says why. Nothing here throws, and nothing waits for long.
 */
export async function runChecks(home: string, dev: string): Promise<Check[]> {
  const config = value(await attempt(() => configSchema.parse(JSON.parse(readFileSync(join(home, "config.json"), "utf8")))));
  const client = value(await attempt(() => loadClient(home, http, () => Date.now() / 1000)));
  const reached = await hub(config);
  const asked = await protocol(client, reached.now);
  const devFound = isDirectory(dev);
  const found = devFound ? await repos(dev, asked.info, client !== null) : { outcome: skip("there is no repos folder"), checkout: undefined };
  const version = await git(["--version"], GIT_TIMEOUT);
  const gitWords = version.stderr.trim() === "" ? "it is not installed, or not on the PATH" : version.stderr.trim();
  return [
    { id: "node", title: "Node is 26 or newer", ...nodeVersion() },
    { id: "identity", title: "This machine has joined a hub", ...either(await attempt(() => identity(home, config, client))) },
    { id: "hub", title: "The hub answers", ...reached.outcome },
    {
      id: "proxy",
      title: "No proxy stands between this machine and the hub",
      ...(config === null ? skip("not joined, so there is no hub to reach") : either(await attempt(() => proxy(config.hub, process.env))))
    },
    { id: "protocol", title: "The hub speaks this version's protocol", ...asked.outcome },
    {
      id: "clock",
      title: "This clock agrees with the hub's",
      ...(reached.now === null ? skip(config === null ? "not joined, so there is no hub to compare with" : "the hub does not answer") : clock(reached.now))
    },
    { id: "dev", title: "The repos folder exists", ...(devFound ? ok(dev) : fail(`there is no folder at ${dev}, where your repos are looked for; PLAYER_TWO_DEV moves it`, `mkdir -p ${quote(dev)}`)) },
    { id: "repos", title: "A team repo is checked out", ...found.outcome },
    { id: "git", title: "git runs", ...(version.ok ? ok(version.stdout.trim()) : fail(`git does not run: ${gitWords}`, "sudo apt install git")) },
    {
      id: "git-auth",
      title: "git reaches the team's repos without asking",
      ...(version.ok && found.checkout !== undefined ? await gitAuth(found.checkout) : skip(version.ok ? "no team repo is checked out to try" : "git does not run"))
    },
    { id: "agent", title: "The agent's command is found", ...(config === null ? skip("not joined, so no agent is chosen yet") : either(await attempt(() => agent(home, config)))) }
  ];
}
