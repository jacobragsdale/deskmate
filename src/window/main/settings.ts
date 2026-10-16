/**
 * The window's own settings, in settings.json in Electron's user-data folder. Everything else lives with the desk; this is only what the window needs before there is a desk to ask, which WSL
 * distribution to run it in, and what is the window's alone: whether it starts at login, and whether it has said that closing it hides it to the tray.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * What was saved; the default distribution when nothing was. A file that cannot be read is kept aside, as settings.json.unreadable, for a person to look at, and replaced by settings that
 * turn nothing on by themselves: start at login is set off, so that the first grant does not turn it on when the user may have turned it off, and the system's own setting is left as it is.
 */
export function loadSettings(folder: string): Settings {
  const file = joinPath(folder, "settings.json");
  try {
    return settingsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { distro: null }; // Nothing saved yet.
    }
  }
  const replaced: Settings = { distro: null, atLogin: false };
  try {
    renameSync(file, `${file}.unreadable`);
    write(folder, replaced);
  } catch {
    // Neither could be done: the same is read, and the same returned, next time.
  }
  return replaced;
}

/**
 * The folder the window keeps as its own, Electron's user-data folder, given the PLAYER_TWO_HOME it was started with and Electron's default, `fallback`. A second identity on one machine has its
 * files moved by PLAYER_TWO_HOME, for the window as for the command, and its window's folder goes beside them: that folder holds the lock that keeps one copy of the app running, so with one
 * of its own the second identity's window opens, rather than handing its arguments to the first identity's and quitting.
 */
export function windowFolder(home: string, fallback: string): string {
  return home === "" ? fallback : joinPath(home, "window");
}

/** Change some of the settings, keeping the rest as saved. */
export function saveSettings(folder: string, changed: Partial<Settings>): void {
  write(folder, settingsSchema.parse({ ...loadSettings(folder), ...changed }));
}

/** Write settings.json whole or not at all: to a file beside it, then put in its place, so that a write cut short leaves the one before. */
function write(folder: string, settings: Settings): void {
  const file = joinPath(folder, "settings.json");
  writeFileSync(`${file}.new`, JSON.stringify(settings, null, 1));
  renameSync(`${file}.new`, file);
}
