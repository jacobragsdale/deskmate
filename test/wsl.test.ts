/** What the window makes of wsl.exe. Nothing here can run on a Linux server, so the reading is done over samples in test/fixtures/wsl: the table as WSL lays it out, and WSL's own messages in English. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { explainFailure, parseDistros } from "../src/window/main/wsl.ts";

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
