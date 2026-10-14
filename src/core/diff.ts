/**
 * Reading a unified diff as `git diff` writes one: its files and hunks, to draw as text, and the paths in it that must never be applied or that an agent would read as instructions.
 * Text in, text out. A diff comes from someone else's machine, so a path is read wherever `git apply` would read one, and a hunk's lines are counted as git counts them,
 * so that a changed line which looks like a header is never taken for one, and a header is never hidden in what looks like a hunk.
 */

const DEV_NULL = "/dev/null"; // The name a diff gives the side of a file that does not exist.
const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
// Files an agent reads as instructions, matched without regard to case: by name in any folder, by a folder anywhere in the path, and from the top of the repo.
const INSTRUCTION_NAMES = ["agents.md", "claude.md", ".cursorrules"];
const INSTRUCTION_FOLDERS = [".cursor", ".player-two"];
const INSTRUCTION_PATHS = [".github/copilot-instructions.md", ".github/instructions/"];

/** One stretch of changed lines and the "@@ -a,b +c,d @@" line that places it. */
export interface Hunk {
  readonly header: string;
  readonly lines: readonly string[]; // Each as written, starting with " ", "-", "+" or "\" (git's "\ No newline at end of file").
}

export interface DiffFile {
  readonly path: string; // The file after the change, or before it for a file deleted, without git's "a/" or "b/".
  readonly from: string | null; // The path it had before, when it was renamed or copied.
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
  readonly hunks: readonly Hunk[];
  readonly names: readonly string[]; // Every name its headers give, as written: what `git apply` would act on.
}

interface Draft {
  names: string[];
  before: string | null;
  after: string | null;
  from: string | null;
  binary: boolean;
  minus: boolean; // Whether a "--- " line has been read for it.
  hunks: Hunk[];
  added: number;
  removed: number;
}

/** What one header line says: the names it gives, and what they mean for the file. */
type Header = Partial<Pick<Draft, "before" | "after" | "from" | "binary" | "minus">> & { readonly names: readonly string[] };

/** Undo git's quoting of a name: "\303\251" is the bytes of "é", "\t" a tab. Null when the quoting is not git's. */
function unquote(text: string): { readonly name: string; readonly end: number } | null {
  const quoted = /^"((?:[^"\\]|\\.)*)"/su.exec(text);
  if (quoted?.[1] === undefined) {
    return null;
  }
  const bytes: number[] = [];
  for (const [, escape, plain] of quoted[1].matchAll(/\\([0-3][0-7]{2}|.)|([^\\]+)/gsu)) {
    const code = escape === undefined ? undefined : /^[0-7]{3}$/.test(escape) ? parseInt(escape, 8) : ESCAPES[escape];
    if (plain !== undefined) {
      bytes.push(...new TextEncoder().encode(plain));
    } else if (code === undefined) {
      return null;
    } else {
      bytes.push(code);
    }
  }
  return { name: new TextDecoder().decode(new Uint8Array(bytes)), end: quoted[0].length };
}

/** The name at the start of a header's text: quoted, or up to the tab git puts after a name with a space in it. */
function nameIn(text: string): string {
  const quoted = text.startsWith('"') ? unquote(text) : null;
  return quoted?.name ?? text.split("\t")[0] ?? "";
}

/** A name without its first part, as `git apply` takes it: "a/src/x.ts" is "src/x.ts". */
function strip(name: string): string {
  return name.slice(name.indexOf("/") + 1);
}

/**
 * The two names on a "diff --git" line, the way git reads them: both quoted, or the split at which both are the same path once their first part is gone.
 * Null when there is no such split, as for a rename; git then takes the names from the lines that follow.
 */
function gitNames(text: string): readonly [string, string] | null {
  const first = text.startsWith('"') ? unquote(text) : null;
  if (first !== null) {
    return [first.name, nameIn(text.slice(first.end).trimStart())];
  }
  for (let space = text.indexOf(" "); space !== -1; space = text.indexOf(" ", space + 1)) {
    const before = text.slice(0, space);
    const after = nameIn(text.slice(space + 1));
    if (before.includes("/") && after.includes("/") && strip(before) === strip(after)) {
      return [before, after];
    }
  }
  return null;
}

/** What a header line says about its file; null for a line that is not one. */
function headerOf(line: string): Header | null {
  if (line.startsWith("diff --git ")) {
    const pair = gitNames(line.slice("diff --git ".length));
    return pair === null ? { names: [] } : { names: pair, before: strip(pair[0]), after: strip(pair[1]) };
  }
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    const name = nameIn(line.slice(4));
    const side = name === DEV_NULL ? null : strip(name);
    return { names: name === DEV_NULL ? [] : [name], ...(line.startsWith("-") ? { before: side, minus: true } : { after: side }) };
  }
  const moved = /^(rename from|rename old|copy from|rename to|rename new|copy to) (.*)$/u.exec(line);
  if (moved?.[1] !== undefined && moved[2] !== undefined) {
    const name = nameIn(moved[2]);
    return /from|old/u.test(moved[1]) ? { names: [name], before: name, from: name } : { names: [name], after: name };
  }
  return line.startsWith("GIT binary patch") || line.startsWith("Binary files ") ? { names: [], binary: true } : null;
}

/** The hunk whose "@@" line is at `at`, its lines counted as its header says, as git counts them. Null when the line is not a hunk's header. */
function hunkAt(lines: readonly string[], at: number): { readonly hunk: Hunk; readonly added: number; readonly removed: number; readonly next: number } | null {
  const header = lines[at] ?? "";
  const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(header);
  if (counts === null) {
    return null;
  }
  let old = Number(counts[1] ?? "1");
  let now = Number(counts[2] ?? "1");
  let added = 0;
  let removed = 0;
  let next = at + 1;
  for (let line = lines[next]; line !== undefined && (old > 0 || now > 0 || line.startsWith("\\")); line = lines[next]) {
    const mark = line[0] ?? " "; // An empty line is a context line whose space was trimmed, which git takes too.
    if (mark === " ") {
      old -= 1;
      now -= 1;
    } else if (mark === "-") {
      old -= 1;
      removed += 1;
    } else if (mark === "+") {
      now -= 1;
      added += 1;
    } else if (mark !== "\\") {
      break; // Git calls the patch corrupt here and applies none of it.
    }
    next += 1;
  }
  return { hunk: { header, lines: lines.slice(at + 1, next) }, added, removed, next };
}

/** Whether a file starts at line `at`: at "diff --git", or at a "---" and "+++" pair that does not belong to the file before, as in a diff written by something other than git. */
function startsFile(lines: readonly string[], at: number, file: Draft | null): boolean {
  const line = lines[at] ?? "";
  const pair = line.startsWith("--- ") && (lines[at + 1] ?? "").startsWith("+++ ");
  return line.startsWith("diff --git ") || (pair && (file === null || file.minus || file.hunks.length > 0));
}

/** The files in a unified diff, with their hunks, in the order the diff gives them. Text before the first file, such as a commit message, is passed over. */
export function parseDiff(diff: string): DiffFile[] {
  const lines = diff.split("\n");
  const files: Draft[] = [];
  let file: Draft | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    if (startsFile(lines, at, file)) {
      file = { names: [], before: null, after: null, from: null, binary: false, minus: false, hunks: [], added: 0, removed: 0 };
      files.push(file);
    }
    if (file === null) {
      continue;
    }
    const found = hunkAt(lines, at);
    if (found !== null) {
      file.hunks.push(found.hunk);
      file.added += found.added;
      file.removed += found.removed;
      at = found.next - 1; // The loop's step takes it to the line after the hunk.
      continue;
    }
    const header = headerOf(lines[at] ?? "");
    if (header !== null) {
      Object.assign(file, header, { names: [...file.names, ...header.names] });
    }
  }
  return files.map((draft) => {
    const path = draft.after ?? draft.before ?? "";
    return { path, from: draft.from !== null && draft.from !== path ? draft.from : null, added: draft.added, removed: draft.removed, binary: draft.binary, hunks: draft.hunks, names: draft.names };
  });
}

function isUnsafe(name: string): boolean {
  return name.startsWith("/") || strip(name).startsWith("/") || name.split("/").some((part) => part === ".." || part.toLowerCase() === ".git");
}

/** Every path in a diff that is absolute, has a ".." part, or is in a ".git" folder, as the diff writes it. A patch with any is refused before git sees it. */
export function unsafePaths(diff: string): string[] {
  return [...new Set(parseDiff(diff).flatMap((file) => file.names.filter(isUnsafe)))];
}

function isInstructions(path: string): boolean {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  return (
    INSTRUCTION_NAMES.includes(parts.at(-1) ?? "") ||
    parts.slice(0, -1).some((part) => INSTRUCTION_FOLDERS.includes(part)) ||
    INSTRUCTION_PATHS.some((start) => lower === start || (start.endsWith("/") && lower.startsWith(start)))
  );
}

/** The files a diff changes, renames or deletes that an agent would read as instructions, such as AGENTS.md or anything under .cursor/. Applying one gets a warning of its own. */
export function touchesInstructions(diff: string): string[] {
  return [
    ...new Set(
      parseDiff(diff)
        .flatMap((file) => (file.from === null ? [file.path] : [file.from, file.path]))
        .filter(isInstructions)
    )
  ];
}
