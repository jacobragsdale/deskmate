/** The PATH the user's tools are really on. The desk is started without a terminal, and Ubuntu's .bashrc stops early for a shell that is not interactive, so what nvm or `npm -g` installed would otherwise not be found. */

import { spawn } from "node:child_process";

const LIMIT = 5; // Seconds the shell gets to start and answer.
const BEFORE = "__PLAYER_TWO_PATH__";
const AFTER = "__PLAYER_TWO_END__";

/** The PATH between the two markers in what the shell printed, whatever its start-up files wrote before and after. Null when it is not there. */
export function pathIn(output: string): string | null {
  const found = new RegExp(`${BEFORE}(.+?)${AFTER}`, "s").exec(output)?.[1];
  return found ?? null;
}

/** The shell's PATH, then each folder of this process's own PATH it left out, in their order: a login shell that sets PATH afresh, as Debian's /etc/profile does, would otherwise lose what this process was started with. */
export function joinPaths(shell: string, own: string): string {
  const folders = shell.split(":");
  return [...folders, ...own.split(":").filter((each) => each !== "" && !folders.includes(each))].join(":");
}

/** The PATH an interactive login shell has, asked of one once; this process's own PATH when the shell does not say in time. */
export function shellPath(limitSeconds = LIMIT): Promise<string> {
  return new Promise((resolve) => {
    // ponytail: asks bash whatever the user's shell is. Someone on macOS with their tools set up in .zshrc is not covered; ask $SHELL if that matters.
    // Its own process group, so when the time is up whatever a start-up file left running goes with the shell.
    const child = spawn("bash", ["-lic", `printf '%s%s%s' '${BEFORE}' "$PATH" '${AFTER}'`], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    let printed = "";
    const timer = setTimeout(() => {
      if (child.pid === undefined) {
        return; // It never started; the "error" event has answered.
      }
      try {
        process.kill(-child.pid, "SIGKILL"); // Not a polite request: an interactive bash ignores one.
      } catch {
        // No such group: the shell has already gone.
      }
    }, limitSeconds * 1000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      printed += chunk;
    });
    const done = (): void => {
      clearTimeout(timer);
      resolve(pathIn(printed) ?? process.env["PATH"] ?? "");
    };
    child.on("error", done); // There is no bash here.
    child.on("close", done);
  });
}
