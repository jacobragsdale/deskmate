/** A wsl.exe for one test, since a Linux server has none: a shell script with one distribution, Ubuntu, which is this machine with a home folder of the test's own. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

const FIXTURES = join(import.meta.dirname, "fixtures", "wsl");

export interface StandIn {
  readonly windir: string; // What %WINDIR% is set to: wsl.exe is looked for under it.
  readonly home: string; // The user's home folder inside the distribution.
}

/** Put the stand-in where wsl.exe is looked for, under a Windows folder of the test's own. What follows --exec is simply run. It lists the distributions in UTF-16 as old builds do, and refuses a path with a backslash left in it. */
export function standInWsl(t: TestContext): StandIn {
  const windir = mkdtempSync(join(tmpdir(), "player-two-windir-"));
  t.after(() => {
    rmSync(windir, { recursive: true, force: true });
  });
  const home = join(windir, "home");
  mkdirSync(home);
  mkdirSync(join(windir, "System32"));
  writeFileSync(
    join(windir, "System32", "wsl.exe"),
    `#!/bin/sh
[ "$WSL_UTF8" = 1 ] || { echo "the stand-in was not asked for UTF-8"; exit 1; }
if [ "$1" = --list ] && [ "$2" = --verbose ]; then exec cat "${FIXTURES}/list-verbose-utf16.txt"; fi
if [ "$1" = -d ]; then
  [ "$2" = Ubuntu ] || { cat "${FIXTURES}/distro-not-found.txt"; exit 255; }
  shift 2
fi
[ "$1" = --exec ] || { echo "the stand-in was not given --exec"; exit 1; }
shift
export HOME="${home}"
if [ "$1" = wslpath ]; then
  case "$3" in
    *\\\\*) echo "wslpath: $3: Invalid argument" >&2; exit 1 ;;
    C:*) echo "/mnt/c\${3#C:}" ;;
    *) echo "$3" ;;
  esac
  exit 0
fi
exec "$@"
`,
    { mode: 0o755 }
  );
  process.env["WINDIR"] = windir;
  return { windir, home };
}
