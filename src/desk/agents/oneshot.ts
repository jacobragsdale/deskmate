/** An agent as a one-shot command: run its program and arguments with the prompt as the last argument, and take what it prints as the answer. */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import type { Agent, PermissionMode } from "../../core/wire.ts";
import { AgentCancelledError, AgentTimedOutError, defaultHome, PlayerTwoError } from "../client.ts";
import type { Runner } from "../client.ts";
import { CURSOR_ONESHOT } from "./presets.ts";
import type { AgentRunner } from "./runner.ts";

export const AGENT_TIMEOUT = 900; // Seconds an approved agent run may take.

// The pieces of a command line: a run of spaces, a quoted stretch of either kind, an escaped character, a quote that never closes, or plain text.
const PIECE = /(\s+)|'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|(['"])|([^\s'"\\]+|\\)/g;

/** Split a command into words the way a shell would, with quotes grouping words. No shell runs it. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (const [, space, single, double, escaped, unclosed, plain] of command.matchAll(PIECE)) {
    if (unclosed !== undefined) {
      throw new PlayerTwoError("no closing quotation");
    }
    if (space === undefined) {
      word = (word ?? "") + (single ?? double?.replace(/\\(["\\])/g, "$1") ?? escaped ?? plain ?? "");
    } else if (word !== null) {
      words.push(word);
      word = null;
    }
  }
  return word === null ? words : [...words, word];
}

/** Every process under `pid`, its children's children too, as /proc has them now; none where there is no /proc to read. */
function descendants(pid: number): number[] {
  let names: string[];
  try {
    names = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const name of names) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // Gone since the folder was listed.
    }
    // The parent's pid follows the state, after the command's name in parentheses, which may itself hold spaces and parentheses.
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
  }
  const found: number[] = [];
  const walk = (parent: number): void => {
    for (const child of children.get(parent) ?? []) {
      found.push(child);
      walk(child);
    }
  };
  walk(pid);
  return found;
}

/**
 * Kill an agent started in a process group of its own, and everything it started: the group, and each process under it with the group it leads, as a command the agent ran in the
 * background in a session of its own has left the agent's group, and would otherwise outlive the run once the agent has gone. Those under it are found before anything is killed.
 * ponytail: where there is no /proc, as on macOS, only the group is killed; walk `ps` there if agents run there.
 */
export function killAgent(pid: number): void {
  const under = descendants(pid);
  for (const each of [pid, ...under]) {
    try {
      process.kill(-each, "SIGKILL");
    } catch {
      // Not a group's leader, or gone: its own group goes with its leader.
    }
  }
  for (const each of under) {
    try {
      process.kill(each, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Run the agent command, with `env` added to this process's environment, and resolve with what it printed. Aborting `cancel` stops it and everything it started. */
export const runAgent: Runner = (argv, cwd, cancel, env = {}) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new PlayerTwoError('the agent command is empty. Set it in "agents" in config.json'));
      return;
    }
    // Its own process group, so stopping it takes the agent's child processes with it.
    // ponytail: process groups are POSIX; on Windows this stops only the agent itself. Use `taskkill /T` there if it matters.
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let ended: "finished" | "cancelled" | "timed out" = "finished";
    const stop = (why: "cancelled" | "timed out"): void => {
      ended = why;
      if (child.pid === undefined) {
        return; // It never started; the "error" event reports why.
      }
      killAgent(child.pid);
    };
    const onCancel = (): void => {
      stop("cancelled");
    };
    const timer = setTimeout(() => {
      stop("timed out");
    }, AGENT_TIMEOUT * 1000);
    cancel.addEventListener("abort", onCancel, { once: true });
    if (cancel.aborted) {
      onCancel();
    }
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      cancel.removeEventListener("abort", onCancel);
      finish();
    };
    child.on("error", (error) => {
      settle(() => {
        reject(new PlayerTwoError(`could not start the agent command ${JSON.stringify(command)}: ${error.message}. Check "agents" in ${joinPath(defaultHome(), "config.json")}`));
      });
    });
    child.on("close", (code) => {
      settle(() => {
        if (ended === "timed out") {
          reject(new AgentTimedOutError(`the agent did not finish within ${String(AGENT_TIMEOUT)} seconds`));
        } else if (ended === "cancelled") {
          reject(new AgentCancelledError("the agent was stopped"));
        } else if (code !== 0) {
          reject(new PlayerTwoError(`the agent exited with status ${String(code)}: ${(err === "" ? out : err).trim().slice(-500)}`));
        } else {
          resolve(out.trim());
        }
      });
    });
  });

/**
 * A one-shot command as an agent runner: the agent's program and arguments with the prompt added as the last argument. It takes no questions, so it cannot be held to a mode,
 * with one exception: Cursor's command as the preset has it only proposes changes, so it runs read-only as it is, and with --force at full. Any other one-shot command runs only at full.
 */
export function oneshotRunner(agent: Agent, exec: Runner = runAgent): AgentRunner {
  const cursor = JSON.stringify([agent.command, ...agent.args]) === JSON.stringify([CURSOR_ONESHOT.command, ...CURSOR_ONESHOT.args]);
  const cannotHonour = (mode: PermissionMode): string => {
    if (mode === "full" || (cursor && mode === "read-only")) {
      return "";
    }
    return cursor
      ? `${agent.label} runs either read-only, when it only proposes changes, or with full access, and nothing between`
      : `${agent.label} runs as a single command and cannot be limited: it runs only with full access`;
  };
  return {
    cannotHonour,
    run: (prompt, cwd, mode, _handlers, cancel, _followUp, env = {}) => {
      const why = cannotHonour(mode);
      if (why !== "") {
        return Promise.reject(new PlayerTwoError(why));
      }
      return exec([agent.command, ...agent.args, ...(cursor && mode === "full" ? ["--force"] : []), prompt], cwd, cancel, env);
    },
    close: () => Promise.resolve() // A one-shot command keeps nothing open.
  };
}
