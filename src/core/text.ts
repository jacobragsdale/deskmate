/** Small text helpers, safe to use in the desk, the main process and the window alike. */

import { z } from "zod";

/** Orders strings by code unit, the same on every machine whatever its locale. */
export function byCodeUnit(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The first `count` characters of a text, never half of one. */
export function head(text: string, count: number): string {
  return text.length <= count ? text : Array.from(text).slice(0, count).join("");
}

/** A text on one line, cut short with an ellipsis when it runs past `width`. */
export function oneLine(text: string, width = 60): string {
  const flat = text.trim().split(/\s+/).join(" ");
  return flat.length <= width ? flat : `${head(flat, width - 1)}…`;
}

/** A failure in words the user can act on. */
export function problemOf(error: unknown): string {
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return first === undefined ? "invalid input" : `invalid ${first.path.length === 0 ? "input" : first.path.join(".")}: ${first.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
