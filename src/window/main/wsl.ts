/** WSL as the window sees it: calling wsl.exe and reading what it prints. The window is a Windows program and the desk runs in the user's Linux distribution, so this is how one reaches the other. */

import { execFile } from "node:child_process";
import { join as joinPath } from "node:path";

const LIST_TIMEOUT = 15; // Seconds. Listing starts nothing.
const START_TIMEOUT = 60; // Seconds for a call that may have to start the distribution first, which after a reboot is slow.
const SCRIPT_TIMEOUT = 300; // Seconds a script gets unless its caller says otherwise.

/** How a call into WSL ended: with what was asked for, or with why not, in words for the user. */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/** One installed distribution, as `wsl.exe --list --verbose` shows it. */
export interface Distro {
  readonly name: string;
  readonly state: string; // "Running" or "Stopped", or "Installing" and the like while WSL is busy with it. wsl.exe prints these in English whatever the system's language.
  readonly version: number; // 1 or 2. The desk needs 2.
  readonly isDefault: boolean; // The one wsl.exe uses when it is given no name.
}

// One row of the table: a star or a space, then the name, the state and the version in columns. The heading has no number in its last column, and so is not one.
const ROW = /^([* ]) (\S+)\s+(\S+)\s+(\d+)\s*$/;

// What wsl.exe says when it fails, and what that means to someone who has never opened a terminal on Windows. The first that fits wins.
const FAILURES: readonly (readonly [RegExp, string])[] = [
  [
    /Windows Subsystem for Linux is not installed|Windows Subsystem for Linux Optional Component|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|ENOENT/i,
    "WSL is not installed on this machine. In PowerShell, run: wsl --install"
  ],
  [/no installed distributions|WSL_E_DEFAULT_DISTRO_NOT_FOUND/i, "WSL has no Linux distribution installed. In PowerShell, run: wsl --install -d Ubuntu"],
  [/no distribution with the supplied name|WSL_E_DISTRO_NOT_FOUND/i, "WSL has no distribution of that name. In PowerShell, `wsl --list --verbose` shows the ones it has"],
  [/WSL1 is not supported|WSL_E_WSL1_NOT_SUPPORTED/i, "the distribution is WSL 1, and Player Two needs WSL 2. In PowerShell, convert it with: wsl --set-version NAME 2"],
  [
    /virtualization|HCS_E_|Wsl\/Service\/CreateInstance/i,
    "the distribution will not start. In PowerShell, `wsl --status` says what WSL is missing, and `wsl --shutdown` before trying again clears a stuck one"
  ]
];

/** What wsl.exe wrote, as text: older builds answer in UTF-16 even when asked for UTF-8, which read as UTF-8 leaves a NUL after every character. */
function clean(text: string): string {
  return text.replaceAll("\0", "").replace(/^\uFEFF/, "");
}

/** The distributions in what `wsl.exe --list --verbose` printed. None when it printed something else, such as that there are none. */
export function parseDistros(text: string): Distro[] {
  const distros: Distro[] = [];
  for (const line of clean(text).split(/\r?\n/)) {
    const [, star, name, state, version] = ROW.exec(line) ?? [];
    if (name !== undefined && state !== undefined) {
      distros.push({ name, state, version: Number(version), isDefault: star === "*" });
    }
  }
  return distros;
}

/** Why a call to wsl.exe failed, in words the user can act on. `code` is its exit status and `said` whatever it printed: wsl.exe puts its own complaints on standard output as often as on standard error, so pass both. */
export function explainFailure(code: number | null, said: string): string {
  const text = clean(said);
  const known = FAILURES.find(([pattern]) => pattern.test(text));
  if (known !== undefined) {
    return known[1];
  }
  const last = text.trim().split(/\r?\n/).at(-1) ?? "";
  return `wsl.exe failed${code === null ? "" : ` with status ${String(code)}`}${last === "" ? "" : `: ${last}`}`;
}

/** wsl.exe by its full path. A PATH may hold another program of that name, or none. */
export function wslExe(): string {
  return joinPath(process.env["WINDIR"] ?? "C:\\Windows", "System32", "wsl.exe");
}

/** Run wsl.exe with plain arguments and `input` on its standard input, and resolve with what it printed. Never rejects. */
function wsl(args: readonly string[], input: string, timeoutSeconds: number): Promise<Result<string>> {
  return new Promise((resolve) => {
    // WSL_UTF8 asks for UTF-8 where wsl.exe would write UTF-16, and windowsHide keeps a console window from flashing up.
    const options = { timeout: timeoutSeconds * 1000, env: { ...process.env, WSL_UTF8: "1" }, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
    const child = execFile(wslExe(), args, options, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true, value: clean(stdout) });
      } else if (error.killed === true) {
        resolve({ ok: false, problem: `WSL did not answer within ${String(timeoutSeconds)} seconds` });
      } else if (typeof error.code === "number") {
        resolve({ ok: false, problem: explainFailure(error.code, `${stdout}\n${stderr}`) });
      } else {
        resolve({ ok: false, problem: explainFailure(null, error.message) }); // wsl.exe itself could not be run, and the error says why.
      }
    });
    child.stdin?.on("error", () => undefined); // A wsl.exe that went without reading its input has already failed, and that is reported above.
    child.stdin?.end(input);
  });
}

/** The arguments that name a distribution. With no name wsl.exe uses the default one. */
export function named(distro: string | null): string[] {
  return distro === null ? [] : ["-d", distro];
}

function trimmed(result: Result<string>): Result<string> {
  return result.ok ? { ok: true, value: result.value.trim() } : result;
}

export async function listDistros(): Promise<Result<Distro[]>> {
  const listed = await wsl(["--list", "--verbose"], "", LIST_TIMEOUT);
  return listed.ok ? { ok: true, value: parseDistros(listed.value) } : listed;
}

/** The user's home folder inside a distribution, such as "/home/jacob". */
export async function home(distro: string | null): Promise<Result<string>> {
  return trimmed(await wsl([...named(distro), "--exec", "printenv", "HOME"], "", START_TIMEOUT));
}

/** A Windows path as a distribution sees it: "C:\Users\jacob\a.txt" becomes "/mnt/c/Users/jacob/a.txt". It is passed with forward slashes, because wsl.exe eats backslashes. */
export async function toLinuxPath(distro: string | null, windowsPath: string): Promise<Result<string>> {
  return trimmed(await wsl([...named(distro), "--exec", "wslpath", "-u", windowsPath.replaceAll("\\", "/")], "", START_TIMEOUT));
}

/** Run a script in a distribution with `sh`, and resolve with what it printed. The script goes in on standard input: as an argument, wsl.exe would requote it and break it. */
export function runScript(distro: string | null, script: string, timeoutSeconds = SCRIPT_TIMEOUT): Promise<Result<string>> {
  return wsl([...named(distro), "--exec", "sh", "-s"], script, timeoutSeconds);
}
