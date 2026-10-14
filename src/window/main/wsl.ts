/** WSL as the window sees it: reading what wsl.exe prints. The window is a Windows program and the desk runs in the user's Linux distribution, so this is how one finds the other. */

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
