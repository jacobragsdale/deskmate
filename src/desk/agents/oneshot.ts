/** An agent as a one-shot command: split the configured command into words, run it with the prompt as its last argument, and take what it prints as the answer. */

import { spawn } from "node:child_process";
import { join as joinPath } from "node:path";

import { AgentCancelledError, defaultHome, PlayerTwoError } from "../client.ts";
import type { Runner } from "../client.ts";

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

/** Run the agent command and resolve with what it printed. Aborting `cancel` stops it and everything it started. */
export const runAgent: Runner = (argv, cwd, cancel) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new PlayerTwoError('the agent command is empty. Set "agent" in config.json'));
      return;
    }
    // Its own process group, so stopping it takes the agent's child processes with it.
    // ponytail: process groups are POSIX; on Windows this stops only the agent itself. Use `taskkill /T` there if it matters.
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let ended: "finished" | "cancelled" | "timed out" = "finished";
    const stop = (why: "cancelled" | "timed out"): void => {
      ended = why;
      if (child.pid === undefined) {
        return; // It never started; the "error" event reports why.
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // No such group: the agent has already gone.
      }
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
        reject(new PlayerTwoError(`could not start the agent command ${JSON.stringify(command)}: ${error.message}. Set "agent" in ${joinPath(defaultHome(), "config.json")}`));
      });
    });
    child.on("close", (code) => {
      settle(() => {
        if (ended === "timed out") {
          reject(new PlayerTwoError(`the agent did not finish within ${String(AGENT_TIMEOUT)} seconds`));
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
