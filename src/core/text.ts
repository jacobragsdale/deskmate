/** Small text helpers with no dependencies, safe to use in the main process and the window alike. */

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
