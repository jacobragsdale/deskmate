/**
 * Applying a patch from the chat to one of the user's checkouts with git apply. The diff is someone else's: it only ever reaches git on its standard input, never a word of it on git's
 * command line, and git is never given --unsafe-paths. Which paths it names is checked before any of this (`unsafePaths` in src/core/diff.ts).
 */

import { git } from "./repos.ts";

const LIMIT = 120; // Seconds one git call may take.

/** git's last line on standard error, which says why it would not. */
function lastWords(stderr: string): string {
  return stderr.trim().split("\n").at(-1) ?? "";
}

/** Whether git, applying three ways, left a file with conflict markers in it for the user to resolve. */
function conflicted(stderr: string): boolean {
  return /^Applied patch to .* with conflicts\.$/m.test(stderr);
}

/**
 * Whether the patch applies to the checkout as it stands, three ways where its context has moved on, as `apply` would apply it: rejects with git's words when it does not, as when a file
 * it changes has changes of the user's that are not committed. Resolves with whether it would leave conflicts.
 */
export async function check(path: string, diff: string): Promise<{ readonly conflicts: boolean }> {
  const done = await git(["-C", path, "apply", "--check", "--3way"], LIMIT, diff);
  if (!done.ok) {
    throw new Error(`it does not apply to ${path}: ${done.timedOut ? `git gave no answer within ${String(LIMIT)} seconds` : lastWords(done.stderr)}`);
  }
  return { conflicts: conflicted(done.stderr) };
}

/** Apply the patch to the checkout's working tree and index, three ways. Resolves with whether it left conflicts to resolve; rejects with git's words when it applied nothing. */
export async function apply(path: string, diff: string): Promise<{ readonly conflicts: boolean }> {
  const done = await git(["-C", path, "apply", "--3way"], LIMIT, diff);
  if (!done.ok && !conflicted(done.stderr)) {
    throw new Error(`git apply failed in ${path}: ${done.timedOut ? `no answer within ${String(LIMIT)} seconds` : lastWords(done.stderr)}`);
  }
  return { conflicts: !done.ok };
}

/** Text from someone else's diff as a dialog may show it: each control or formatting character written as its code, so that a name can neither add a line to the dialog nor turn its text around. */
export function plain(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`);
}
