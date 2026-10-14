/** The desk as the window's main process holds it: a process of its own, started here, told things and heard from one JSON line at a time. No Electron in this file, so a test runs it as it is. */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createInterface } from "node:readline";

import { installScript } from "../../core/install.ts";
import { problemOf } from "../../core/text.ts";
import { PROTOCOL } from "../../core/wire.ts";
import { deskLineSchema, readLine } from "../../shared/ipc.ts";
import type { Arrival, Command, Notice, Outcome, Question, View, WindowLine } from "../../shared/ipc.ts";
import { home, named, runScript, toLinuxPath, wslExe } from "./wsl.ts";
import type { Result } from "./wsl.ts";

const RESTARTS = 3; // Times a desk that went away unasked is started again before the window gives up on it.
const RESTART_DELAY = 1000; // Milliseconds before the first of them; each one after waits twice as long.
const STOP_WAIT = 3000; // Milliseconds a desk gets to stop its agents and tell the chat before it is killed.
const TAIL = 2000; // Characters of the desk's standard error kept, to show if it will not stay up.

/** The program that is the desk on this machine, and what it is started with. */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/** The desk where the window and the repos are on one machine, which is Linux, macOS, and development inside WSL: the built command beside this file, run by Electron itself as plain Node. */
export function localLaunch(): Promise<Result<Launch>> {
  return Promise.resolve({ ok: true, value: { command: process.execPath, args: [joinPath(import.meta.dirname, "player-two.js"), "desk"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } } });
}

/** The SHA-256 the app was shipped with for its runtime archive, from the file beside it; "" when that file is missing or holds something else. */
function shippedDigest(archive: string): string {
  try {
    return /^[0-9a-f]{64}(?=\s|$)/.exec(readFileSync(`${archive}.sha256`, "utf8"))?.[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * The desk on Windows, where the repos and the agents are inside WSL: install the runtime the app carries in `resources` into the distribution, then start its launcher through wsl.exe.
 * The launcher is a login shell's script, so the desk gets the user's own environment and nothing has to be quoted on this side. `distro` null is whichever distribution WSL uses by default.
 */
export async function wslLaunch(distro: string | null, resources: string): Promise<Result<Launch>> {
  const archive = joinPath(resources, "wsl-runtime.tar.gz");
  const digest = shippedDigest(archive);
  if (digest === "") {
    return { ok: false, problem: `this copy of Player Two has no Linux runtime to install: ${archive}.sha256 is missing or damaged. Install Player Two again` };
  }
  const linuxHome = await home(distro);
  if (!linuxHome.ok) {
    return linuxHome;
  }
  const linuxArchive = await toLinuxPath(distro, archive);
  if (!linuxArchive.ok) {
    return linuxArchive;
  }
  const installed = await runScript(distro, installScript(linuxArchive.value, digest));
  if (!installed.ok) {
    return installed;
  }
  // WSL_UTF8 is for what wsl.exe itself may say if it cannot start the launcher; what the desk writes passes through as it is.
  return { ok: true, value: { command: wslExe(), args: [...named(distro), "--exec", `${linuxHome.value}/.player-two/current/bin/player-two-desk`], env: { ...process.env, WSL_UTF8: "1" } } };
}

/** What the desk says that is not the answer to a command. */
export interface Handlers {
  readonly view: (view: View) => void;
  readonly notice: (notice: Notice) => void;
  readonly arrival: (arrival: Arrival) => void;
  readonly ask: (id: number, question: Question) => void; // Answered with `answer(id, ok)`.
}

export class DeskProcess {
  private readonly prepare: () => Promise<Result<Launch>>;
  private readonly handlers: Handlers;
  private readonly restartDelay: number;
  private readonly waiting = new Map<number, (outcome: Outcome) => void>(); // Commands the desk has not answered yet, by id.
  private child: ChildProcessWithoutNullStreams | null = null;
  private restart: NodeJS.Timeout | undefined;
  private wanted = true; // False once the window has stopped the desk or refused it: a desk that goes after that is not started again.
  private restarts = 0;
  private commands = 0;
  private attentive: boolean | null = null; // What the desk was last told, so one started again is told too.
  private tail = "";

  /** `prepare` does whatever the desk needs before it can be started, each time it is, and says how to start it: `localLaunch`, or `wslLaunch` on Windows. */
  constructor(prepare: () => Promise<Result<Launch>>, handlers: Handlers, restartDelay = RESTART_DELAY) {
    this.prepare = prepare;
    this.handlers = handlers;
    this.restartDelay = restartDelay;
  }

  /** Get the desk ready and start it. If it cannot be made ready there is nothing to start again, so the window says why at once. */
  public start(): void {
    this.prepare().then(
      (launch) => {
        if (!this.wanted) {
          return; // Stopped while it was being made ready.
        }
        if (launch.ok) {
          this.spawn(launch.value);
        } else {
          this.handlers.view({ kind: "stopped", problem: launch.problem });
        }
      },
      (error: unknown) => {
        this.handlers.view({ kind: "stopped", problem: problemOf(error) });
      }
    );
  }

  /** Have the desk do something. Resolves with its reply, or with a problem when the desk went before it gave one. */
  public send(command: Command): Promise<Outcome> {
    return new Promise((resolve) => {
      if (this.child === null) {
        resolve({ ok: false, problem: "the desk is not running" });
        return;
      }
      this.commands += 1;
      this.waiting.set(this.commands, resolve);
      this.write({ t: "command", id: this.commands, command });
    });
  }

  /** Give the user's yes or no to a question the desk asked. */
  public answer(id: number, ok: boolean): void {
    this.write({ t: "answer", id, ok });
  }

  /** Say whether the user is looking at the window. */
  public attend(attentive: boolean): void {
    this.attentive = attentive;
    this.write({ t: "attend", attentive });
  }

  /** Close the desk's input, which tells it to quit, and wait for it to go. One that has not gone in three seconds is killed. */
  public async stop(): Promise<void> {
    this.wanted = false;
    clearTimeout(this.restart);
    const child = this.child;
    if (child === null) {
      return;
    }
    const closed = once(child, "close");
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
    }, STOP_WAIT);
    child.stdin.end();
    await closed;
    clearTimeout(kill);
  }

  private spawn(launch: Launch): void {
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "pipe", windowsHide: true });
    this.child = child;
    this.tail = "";
    child.stdin.on("error", () => undefined); // A desk that has gone cannot be written to. Its going is what gets handled, in `gone`.
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.keep(chunk);
    });
    child.on("error", (error) => {
      this.keep(error.message); // It could not be started at all. "close" follows, as it does an exit.
    });
    createInterface({ input: child.stdout }).on("line", (text) => {
      this.accept(text);
    });
    child.on("close", (code) => {
      this.gone(code);
    });
    if (this.attentive !== null) {
      this.attend(this.attentive);
    }
  }

  /** Keep the end of what the desk says that is not the protocol, to show if it will not stay up. wsl.exe may say it in UTF-16, which read as UTF-8 has a NUL after every character. */
  private keep(said: string): void {
    this.tail = (this.tail + said.replaceAll("\0", "")).slice(-TAIL);
  }

  private write(line: WindowLine): void {
    this.child?.stdin.write(`${JSON.stringify(line)}\n`);
  }

  private accept(text: string): void {
    if (!this.wanted) {
      return; // A desk that was refused or told to quit has nothing more to say here.
    }
    const line = readLine(deskLineSchema, text);
    if (line === null) {
      this.keep(`${text}\n`); // On Windows this may be wsl.exe saying why it could not start the desk.
      this.handlers.notice({ title: "the window ignored a line from the desk it could not read", body: text.slice(0, 200), severity: "error" });
      return;
    }
    switch (line.t) {
      case "hello":
        if (line.protocol !== PROTOCOL) {
          this.wanted = false;
          this.child?.kill();
          const stale = line.protocol > PROTOCOL ? "window" : "desk";
          this.handlers.view({ kind: "stopped", problem: `the desk speaks protocol ${String(line.protocol)} and this window speaks protocol ${String(PROTOCOL)}: update the ${stale}` });
        }
        break;
      case "view":
        this.restarts = 0; // A desk that got as far as showing something has started: if it goes later, that is a new failure and is counted afresh.
        this.handlers.view(line.view);
        break;
      case "notice":
        this.handlers.notice(line.notice);
        break;
      case "arrival":
        this.handlers.arrival(line.arrival);
        break;
      case "ask":
        this.handlers.ask(line.id, line.question);
        break;
      case "reply":
        this.waiting.get(line.id)?.(line.outcome);
        this.waiting.delete(line.id);
        break;
    }
  }

  /** The desk's process has ended. Unless the window ended it, start it again a few times, each after a longer wait, and then say why it will not stay up. */
  private gone(code: number | null): void {
    this.child = null;
    for (const settle of this.waiting.values()) {
      settle({ ok: false, problem: "the desk stopped before it answered" });
    }
    this.waiting.clear();
    if (!this.wanted) {
      return;
    }
    if (this.restarts < RESTARTS) {
      this.restart = setTimeout(
        () => {
          this.start();
        },
        this.restartDelay * 2 ** this.restarts
      );
      this.restarts += 1;
      return;
    }
    const said = this.tail.trim();
    this.handlers.view({ kind: "stopped", problem: `the desk keeps stopping${code === null ? "" : ` with status ${String(code)}`}${said === "" ? "" : `. The last it said:\n${said}`}` });
  }
}
