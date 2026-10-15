/** The window's settings file: the default until something is saved, what was saved after, written whole or not at all, and one that cannot be read kept aside. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadSettings, saveSettings } from "../src/window/main/settings.ts";

await test("with no distribution saved the default one is used, a saved one is kept, a name WSL would not allow is refused, and saving one setting keeps the others", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "player-two-settings-"));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  assert.deepEqual(loadSettings(folder), { distro: null });
  assert.deepEqual(readdirSync(folder), []); // Reading writes nothing.
  saveSettings(folder, { distro: "Ubuntu-24.04" });
  assert.deepEqual(loadSettings(folder), { distro: "Ubuntu-24.04" });
  assert.throws(() => {
    saveSettings(folder, { distro: "--unregister" });
  });
  assert.deepEqual(loadSettings(folder), { distro: "Ubuntu-24.04" });
  // Each change keeps what else was saved.
  saveSettings(folder, { atLogin: true });
  saveSettings(folder, { toldHidden: true });
  saveSettings(folder, { distro: null });
  assert.deepEqual(loadSettings(folder), { distro: null, atLogin: true, toldHidden: true });
  assert.deepEqual(readdirSync(folder), ["settings.json"]);
});

await test("a write that fails leaves the settings saved before whole, and a file that cannot be read is kept aside and replaced by settings that do not start the app at login by themselves", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "player-two-settings-"));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  const file = join(folder, "settings.json");

  // The new settings go to a file beside, then into place: where that file cannot be written, nothing of settings.json is lost.
  saveSettings(folder, { distro: "Ubuntu-24.04", atLogin: true });
  const saved = readFileSync(file, "utf8");
  mkdirSync(`${file}.new`);
  assert.throws(() => {
    saveSettings(folder, { toldHidden: true });
  });
  assert.equal(readFileSync(file, "utf8"), saved);
  rmSync(`${file}.new`, { recursive: true });

  // Unreadable, as a write cut short by an older version could leave it: kept aside, and start at login set off, which the first grant then leaves alone.
  writeFileSync(file, '{ "distro": "Ubuntu-24.04", "atLo');
  assert.deepEqual(loadSettings(folder), { distro: null, atLogin: false });
  assert.equal(readFileSync(`${file}.unreadable`, "utf8"), '{ "distro": "Ubuntu-24.04", "atLo');
  assert.deepEqual(loadSettings(folder), { distro: null, atLogin: false }); // And so it stays, rather than unset the next time.
  // Settings it does not know are as unreadable: a key this version does not have.
  writeFileSync(file, JSON.stringify({ distro: null, later: true }));
  assert.deepEqual(loadSettings(folder), { distro: null, atLogin: false });
  assert.equal(existsSync(`${file}.new`), false);
});
