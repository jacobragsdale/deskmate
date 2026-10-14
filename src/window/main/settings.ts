/** The window's own settings, in settings.json in Electron's user-data folder. Everything else lives with the desk; this is only what the window needs before there is a desk to ask: which WSL distribution to run it in. */

import { readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { z } from "zod";

/** A distribution's name as WSL allows one, or null for whichever WSL uses by default. It becomes an argument to wsl.exe, so nothing else is taken. */
export const distroSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .nullable();

const settingsSchema = z.strictObject({ distro: distroSchema }).readonly();

export type Settings = z.infer<typeof settingsSchema>;

/** What was saved; the default distribution when nothing was, or what was saved cannot be read. */
export function loadSettings(folder: string): Settings {
  try {
    return settingsSchema.parse(JSON.parse(readFileSync(joinPath(folder, "settings.json"), "utf8")));
  } catch {
    return { distro: null };
  }
}

export function saveSettings(folder: string, settings: Settings): void {
  writeFileSync(joinPath(folder, "settings.json"), JSON.stringify(settingsSchema.parse(settings), null, 1));
}
