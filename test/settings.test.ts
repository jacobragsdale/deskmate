/** The window's settings file: the default until something is saved, and what was saved after. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(folder, "settings.json"), "{ not json");
  assert.deepEqual(loadSettings(folder), { distro: null });
});
