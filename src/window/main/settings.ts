/**
 * The window's own settings, in settings.json in Electron's user-data folder. Everything else lives with the desk; this is only what the window needs before there is a desk to ask, which WSL
 * distribution to run it in, and what is the window's alone: whether it starts at login, and whether it has said that closing it hides it to the tray.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { z } from "zod";

/** A distribution's name as WSL allows one, or null for whichever WSL uses by default. It becomes an argument to wsl.exe, so nothing else is taken. */
export const distroSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .nullable();

const settingsSchema = z
  .strictObject({
    distro: distroSchema,
    atLogin: z.boolean().optional(), // Start at login, hidden. Unset until the first grant turns it on or the user sets it.
    toldHidden: z.boolean().optional() // Whether the user has been told, once, that closing the window hid it to the tray.
  })
  .readonly();

export type Settings = z.infer<typeof settingsSchema>;

/** What was saved; the default distribution when nothing was, or what was saved cannot be read. */
export function loadSettings(folder: string): Settings {
  try {
    return settingsSchema.parse(JSON.parse(readFileSync(joinPath(folder, "settings.json"), "utf8")));
  } catch {
    return { distro: null };
  }
}

/** Change some of the settings, keeping the rest as saved. */
export function saveSettings(folder: string, changed: Partial<Settings>): void {
  writeFileSync(joinPath(folder, "settings.json"), JSON.stringify(settingsSchema.parse({ ...loadSettings(folder), ...changed }), null, 1));
}
