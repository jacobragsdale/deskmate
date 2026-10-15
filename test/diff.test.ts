/** Reading a diff: one git wrote, the paths that must never reach `git apply` wherever a diff hides them, and the files an agent reads as instructions. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { makesExecutable, modeOf, parseDiff, touchesInstructions, unsafePaths } from "../src/core/diff.ts";

// What `git diff --cached --binary HEAD` wrote for a rename with a change, a new file whose name git quotes, a binary file, a file with two hunks
// (one removing a line that starts "--", the other ending without a newline), a deleted file, and a file whose name has a space, after which git puts a tab.
const FROM_GIT = [
  "diff --git a/before.md b/after.md",
  "similarity index 73%",
  "rename from before.md",
  "rename to after.md",
  "index 7a28df3..adc7e54 100644",
  "--- a/before.md",
  "+++ b/after.md",
  "@@ -1,4 +1,4 @@",
  " alpha",
  " beta",
  " gamma",
  "-delta",
  "+DELTA",
  'diff --git "a/dir/caf\\303\\251.txt" "b/dir/caf\\303\\251.txt"',
  "new file mode 100644",
  "index 0000000..3e75765",
  "--- /dev/null",
  '+++ "b/dir/caf\\303\\251.txt"',
  "@@ -0,0 +1 @@",
  "+new",
  "diff --git a/logo.bin b/logo.bin",
  "index 8352675d67aed6625ece79af41c27fdb4ee2e867..ef2caffcda6e1bd757164a29c6f81be03d172fd5 100644",
  "GIT binary patch",
  "literal 4",
  "LcmZQzWM%;X01*HQ",
  "",
  "literal 3",
  "KcmZQzWC8#H2LJ>B",
  "",
  "diff --git a/notes.sql b/notes.sql",
  "index a2335ac..fbc3a05 100644",
  "--- a/notes.sql",
  "+++ b/notes.sql",
  "@@ -1,6 +1,5 @@",
  " one",
  "-two",
  "--- a comment",
  "+TWO",
  " three",
  " four",
  " five",
  "@@ -10,4 +9,5 @@ eight",
  " nine",
  " ten",
  " eleven",
  "-twelve",
  "+TWELVE",
  "+thirteen",
  "\\ No newline at end of file",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "index 286c5f5..0000000",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/with space.txt b/with space.txt",
  "index c1b0730..975fbec 100644",
  "--- a/with space.txt\t",
  "+++ b/with space.txt\t",
  "@@ -1 +1 @@",
  "-x",
  "\\ No newline at end of file",
  "+y",
  ""
].join("\n");

/** A diff that changes one line of the file git names `path`, written as git writes one. */
function changing(path: string): string {
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

await test("a diff git wrote is read into its files, each with its path, its counts and its hunks", () => {
  const files = parseDiff(FROM_GIT);
  assert.deepEqual(
    files.map((file) => [file.path, file.from, file.added, file.removed, file.binary, file.hunks.length]),
    [
      ["after.md", "before.md", 1, 1, false, 1],
      ["dir/café.txt", null, 1, 0, false, 1],
      ["logo.bin", null, 0, 0, true, 0],
      ["notes.sql", null, 3, 3, false, 2],
      ["old.txt", null, 0, 1, false, 1],
      ["with space.txt", null, 1, 1, false, 1]
    ]
  );
  const notes = files[3];
  assert.equal(notes?.hunks[0]?.header, "@@ -1,6 +1,5 @@");
  assert.deepEqual(notes.hunks[0].lines, [" one", "-two", "--- a comment", "+TWO", " three", " four", " five"]);
  assert.equal(notes.hunks[1]?.header, "@@ -10,4 +9,5 @@ eight");
  assert.equal(notes.hunks[1].lines.at(-1), "\\ No newline at end of file");
  assert.deepEqual(files[5]?.hunks[0]?.lines, ["-x", "\\ No newline at end of file", "+y"]);
  assert.deepEqual(unsafePaths(FROM_GIT), []);
  assert.deepEqual(touchesInstructions(FROM_GIT), []);
  assert.deepEqual(parseDiff("Fix the retry\n\nNothing to see here.\n"), []);
});

await test("a path that is absolute, climbs out with '..', or reaches into .git is found wherever git would read it", () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    [changing("../outside.txt"), ["a/../outside.txt", "b/../outside.txt"]],
    [changing("/etc/passwd"), ["a//etc/passwd", "b//etc/passwd"]],
    [changing(".git/hooks/post-checkout"), ["a/.git/hooks/post-checkout", "b/.git/hooks/post-checkout"]],
    [changing("vendor/lib/.GIT/config"), ["a/vendor/lib/.GIT/config", "b/vendor/lib/.GIT/config"]],
    // Quoted the way git quotes a name, with each "." written in octal.
    ['diff --git "a/\\056\\056/x" "b/\\056\\056/x"\nnew file mode 100644\n--- /dev/null\n+++ "b/\\056\\056/x"\n@@ -0,0 +1 @@\n+x\n', ["a/../x", "b/../x"]],
    // A rename, whose names the "diff --git" line cannot give, so git reads them from the lines after it.
    ["diff --git a/notes.txt b/../notes.txt\nsimilarity index 100%\nrename from notes.txt\nrename to ../notes.txt\n", ["../notes.txt"]],
    // A diff not written by git, with no "diff --git" line at all.
    ["--- /dev/null\n+++ /etc/cron.d/evil\n@@ -0,0 +1 @@\n+* * * * * root sh\n", ["/etc/cron.d/evil"]],
    // A header after a hunk whose counts end before it, so git reads it as the next file's.
    [`${changing("ok.txt")}--- a/../../x\n+++ b/../../x\n@@ -0,0 +1 @@\n+evil\n`, ["a/../../x", "b/../../x"]],
    [changing("docs/..md") + changing("a.git/x") + changing("src/.gitignore"), []]
  ];
  for (const [diff, expected] of cases) {
    assert.deepEqual(unsafePaths(diff), expected, diff);
  }
});

await test("changed lines that look like a file's header are counted as the hunk's, as git counts them, and never read as a path", () => {
  // Removing "-- ../../etc/passwd" and adding "++ ../../etc/passwd" writes a "---" and "+++" pair inside the hunk.
  const diff = "diff --git a/notes.sql b/notes.sql\n--- a/notes.sql\n+++ b/notes.sql\n@@ -1,2 +1,2 @@\n select 1;\n--- ../../etc/passwd\n+++ ../../etc/passwd\n";
  const files = parseDiff(diff);
  assert.equal(files.length, 1);
  assert.deepEqual([files[0]?.added, files[0]?.removed], [1, 1]);
  assert.deepEqual(unsafePaths(diff), []);
});

await test("a file's mode is read from the lines git writes it on: a change is shown as one, a new file that is not a plain one as what it is, and the files made executable are listed", () => {
  // What git diff wrote for a file made executable, a new script, a new link, a new submodule, a script deleted, a new plain file, and a script made plain again.
  const diff = [
    "diff --git a/build.sh b/build.sh",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/run.sh b/run.sh",
    "new file mode 100755",
    "index 0000000..4b44b7a",
    "--- /dev/null",
    "+++ b/run.sh",
    "@@ -0,0 +1 @@",
    "+echo hi",
    "diff --git a/key b/key",
    "new file mode 120000",
    "index 0000000..1d9c7a1",
    "--- /dev/null",
    "+++ b/key",
    "@@ -0,0 +1 @@",
    "+/home/bob/.ssh/id_ed25519",
    "\\ No newline at end of file",
    "diff --git a/lib b/lib",
    "new file mode 160000",
    "index 0000000..a1d6e4a",
    "--- /dev/null",
    "+++ b/lib",
    "@@ -0,0 +1 @@",
    "+Subproject commit a1d6e4aaadd5708c728f3b947fae1172ac1c83bf",
    "diff --git a/old.sh b/old.sh",
    "deleted file mode 100755",
    "index 4b44b7a..0000000",
    "--- a/old.sh",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-echo hi",
    "diff --git a/notes.txt b/notes.txt",
    "new file mode 100644",
    "index 0000000..5626abf",
    "--- /dev/null",
    "+++ b/notes.txt",
    "@@ -0,0 +1 @@",
    "+one",
    "diff --git a/tame.sh b/tame.sh",
    "old mode 100755",
    "new mode 100644",
    ""
  ].join("\n");
  assert.deepEqual(
    parseDiff(diff).map((file) => [file.path, file.added, file.removed, modeOf(file)]),
    [
      ["build.sh", 0, 0, "mode 100644 → 100755"],
      ["run.sh", 1, 0, "executable"],
      ["key", 1, 0, "symbolic link"],
      ["lib", 1, 0, "submodule"],
      ["old.sh", 0, 1, ""],
      ["notes.txt", 1, 0, ""],
      ["tame.sh", 0, 0, "mode 100755 → 100644"]
    ]
  );
  assert.deepEqual(makesExecutable(diff), ["build.sh", "run.sh"]);
  // A line in a hunk that reads like one is the hunk's.
  assert.deepEqual(makesExecutable("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new mode 100755\n"), []);
});

await test("files an agent reads as instructions are listed, wherever the folder they are in and whatever the case of their name", () => {
  const diff = [
    "AGENTS.md",
    "services/api/CLAUDE.md",
    ".cursor/rules/style.mdc",
    ".cursorrules",
    ".github/copilot-instructions.md",
    ".github/instructions/typescript.instructions.md",
    ".player-two/workflows.yaml",
    "src/main.ts",
    "docs/.github/copilot-instructions.md",
    "docs/agents.md.txt"
  ]
    .map(changing)
    .join("");
  assert.deepEqual(touchesInstructions(diff), [
    "AGENTS.md",
    "services/api/CLAUDE.md",
    ".cursor/rules/style.mdc",
    ".cursorrules",
    ".github/copilot-instructions.md",
    ".github/instructions/typescript.instructions.md",
    ".player-two/workflows.yaml"
  ]);
  // Renaming one away, or deleting it, changes what the agent reads as much as editing it does.
  assert.deepEqual(touchesInstructions("diff --git a/Agents.md b/README.md\nsimilarity index 100%\nrename from Agents.md\nrename to README.md\n"), ["Agents.md"]);
  assert.deepEqual(touchesInstructions("diff --git a/CLAUDE.md b/CLAUDE.md\ndeleted file mode 100644\n--- a/CLAUDE.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-Be terse.\n"), ["CLAUDE.md"]);
});
