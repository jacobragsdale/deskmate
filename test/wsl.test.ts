/** What the window makes of wsl.exe. There is no wsl.exe on a Linux server, so the reading is done over samples in test/fixtures/wsl, the table as WSL lays it out and WSL's own messages in English, and the calls are made to a stand-in that runs each command on this machine. */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { explainFailure, home, listDistros, parseDistros, runScript, toLinuxPath } from "../src/window/main/wsl.ts";
import { standInWsl } from "./standInWsl.ts";

function sample(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", "wsl", name), "utf8");
}

await test("the list of distributions is read whether it came as UTF-8 or as UTF-16 with a NUL after every character", () => {
  const distros = [
    { name: "Ubuntu", state: "Running", version: 2, isDefault: true },
    { name: "Ubuntu-22.04", state: "Stopped", version: 2, isDefault: false },
    { name: "Legacy", state: "Stopped", version: 1, isDefault: false },
    { name: "docker-desktop", state: "Running", version: 2, isDefault: false }
  ];

  assert.ok(sample("list-verbose-utf16.txt").includes("\0"));
  assert.deepEqual(parseDistros(sample("list-verbose.txt")), distros);
  assert.deepEqual(parseDistros(sample("list-verbose-utf16.txt")), distros);
  assert.deepEqual(parseDistros(`\uFEFF${sample("list-verbose.txt").replaceAll("\r\n", "\n")}`), distros);
  assert.deepEqual(parseDistros(sample("no-distributions.txt")), []);
  assert.deepEqual(parseDistros(""), []);
});

await test("the common ways wsl.exe fails are put in words that say what to do", () => {
  const cases: readonly (readonly [string, RegExp])[] = [
    ["not-installed.txt", /^WSL is not installed on this machine\. .* wsl --install$/],
    ["component-missing.txt", /^WSL is not installed on this machine\./],
    ["no-distributions.txt", /^WSL has no Linux distribution installed\. .* wsl --install -d Ubuntu$/],
    ["distro-not-found.txt", /^WSL has no distribution of that name\./],
    ["wsl1-not-supported.txt", /^the distribution is WSL 1, and Player Two needs WSL 2\. .* wsl --set-version NAME 2$/],
    ["virtualization-off.txt", /^the distribution will not start\./]
  ];
  for (const [name, words] of cases) {
    assert.match(explainFailure(4294967295, sample(name)), words, name);
    assert.match(explainFailure(4294967295, Buffer.from(sample(name), "utf16le").toString("latin1")), words, `${name} as UTF-16`);
  }

  assert.match(explainFailure(null, "spawn C:\\Windows\\System32\\wsl.exe ENOENT"), /^WSL is not installed on this machine\./);
  assert.equal(explainFailure(1, "sha256sum: /mnt/c/a.tar.gz: No such file or directory\nthe runtime archive is damaged\n"), "wsl.exe failed with status 1: the runtime archive is damaged");
  assert.equal(explainFailure(127, ""), "wsl.exe failed with status 127");
});

await test("the calls into WSL go to wsl.exe under the Windows folder with plain arguments, and each answers with a result", { timeout: 30_000 }, async (t) => {
  const wsl = standInWsl(t);

  const listed = await listDistros();
  assert.deepEqual(listed.ok && listed.value.map((distro) => [distro.name, distro.version, distro.isDefault]), [
    ["Ubuntu", 2, true],
    ["Ubuntu-22.04", 2, false],
    ["Legacy", 1, false],
    ["docker-desktop", 2, false]
  ]);
  assert.deepEqual(await home("Ubuntu"), { ok: true, value: wsl.home });
  assert.deepEqual(await home(null), { ok: true, value: wsl.home }); // With no name it is left to wsl.exe, which uses the default distribution.
  assert.deepEqual(await home("Fedora"), { ok: false, problem: "WSL has no distribution of that name. In PowerShell, `wsl --list --verbose` shows the ones it has" });
  assert.deepEqual(await toLinuxPath("Ubuntu", String.raw`C:\Users\O'Brien\AppData\Local\Programs\Player Two\resources\wsl-runtime.tar.gz`), {
    ok: true,
    value: "/mnt/c/Users/O'Brien/AppData/Local/Programs/Player Two/resources/wsl-runtime.tar.gz"
  });

  // A script arrives as it was written, quotes and all, because it never passes through an argument.
  assert.deepEqual(await runScript("Ubuntu", `printf '%s\\n' "it's \\"quoted\\" and $((6 * 7))"\n`), { ok: true, value: `it's "quoted" and 42\n` });
  assert.deepEqual(await runScript("Ubuntu", "echo the archive is damaged >&2\nexit 3\n"), { ok: false, problem: "wsl.exe failed with status 3: the archive is damaged" });
  const began = Date.now();
  assert.deepEqual(await runScript("Ubuntu", "exec sleep 20\n", 0.2), { ok: false, problem: "WSL did not answer within 0.2 seconds" });
  assert.ok(Date.now() - began < 5000);

  // With no wsl.exe there at all, the call still answers.
  rmSync(join(wsl.windir, "System32", "wsl.exe"));
  assert.deepEqual(await listDistros(), { ok: false, problem: "WSL is not installed on this machine. In PowerShell, run: wsl --install" });
});
