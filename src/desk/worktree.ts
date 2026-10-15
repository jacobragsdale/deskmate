/**
 * Throwaway git worktrees: a run of a teammate's request that may change files happens in one, so the owner's own working tree is never touched by it.
 * Each is made at the commit the checkout is on, in ~/.player-two/worktrees/, and what the run changed comes back as a diff that `git apply` takes.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { git } from "./repos.ts";

const LIMIT = 120; // Seconds one git call may take: making a worktree checks out every file.
const JOB_ID = /^[0-9a-f]{64}$/;

// What collect asks git diff for, whatever the user's configuration says: a/ and b/ for the prefixes diff.ts and git apply take off, no colour, no external diff or textconv,
// whose output git apply cannot take, three lines of context, since git apply refuses a patch with none, and a submodule as its commit ids.
const DIFF = ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * A worktree made for a run: where it is, the commit it was made at, and its folder inside the checkout's .git. git is pointed at that folder by name, never through the worktree's
 * own .git file, which the run could have replaced with a repository whose configuration runs a command.
 */
export interface Worktree {
  readonly path: string;
  readonly base: string;
  readonly gitDir: string;
}

function root(): string {
  return join(homedir(), ".player-two", "worktrees");
}

/** What git printed, or a rejection with its last words. */
async function run(args: readonly string[], what: string): Promise<string> {
  const done = await git(args, LIMIT);
  if (!done.ok) {
    throw new Error(`${what} failed: ${done.timedOut ? `no answer within ${String(LIMIT)} seconds` : (done.stderr.trim().split("\n").at(-1) ?? "")}`);
  }
  return done.stdout;
}

/** Make a worktree of `checkout` at the commit it is on, named for the job, with no branch checked out. What the checkout has not committed is not in it. */
export async function open(checkout: string, jobId: string): Promise<Worktree> {
  if (!JOB_ID.test(jobId)) {
    throw new Error("a worktree is named for a job's id, 64 hex digits");
  }
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  const path = join(root(), jobId.slice(0, 12));
  const base = (await run(["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"], `git rev-parse in ${checkout}`)).trim();
  await run(["-C", checkout, "worktree", "add", "--detach", path, base], `git worktree add ${path}`);
  const gitDir = (await run(["-C", path, "rev-parse", "--absolute-git-dir"], `git rev-parse in ${path}`)).trim(); // Read before the run has had the worktree.
  return { path, base, gitDir };
}

/** Everything changed in the worktree since it was made, committed by the run or not, as a diff from that commit; "" when nothing changed. */
export async function collect(worktree: Worktree): Promise<string> {
  // A user's core.quotePath or diff.suppressBlankEmpty changes how names and empty lines are written, and neither has a flag of its own.
  const at = ["-C", worktree.path, `--git-dir=${worktree.gitDir}`, `--work-tree=${worktree.path}`, "-c", "core.quotePath=true", "-c", "diff.suppressBlankEmpty=false"];
  await run([...at, "add", "-A"], `git add in ${worktree.path}`);
  const diff = await run([...at, ...DIFF, worktree.base, "--"], `git diff in ${worktree.path}`);
  if (diff.includes("�")) {
    // ponytail: what git printed is read as UTF-8, and a byte that is not becomes U+FFFD; a file that holds U+FFFD itself is refused too. Read git's output as bytes if that bites.
    throw new Error(`the change in ${worktree.path} has text that is not UTF-8, which a patch cannot carry as it is`);
  }
  return diff;
}

/** Put back the .git file git wrote, in place of whatever the run left there. Removing the run's does not follow a link. */
function restore(worktree: Worktree): void {
  if (existsSync(worktree.path)) {
    rmSync(join(worktree.path, ".git"), { recursive: true, force: true });
    writeFileSync(join(worktree.path, ".git"), `gitdir: ${worktree.gitDir}\n`);
  }
}

/** Remove the worktree, its files and git's record of it. */
export async function close(worktree: Worktree): Promise<void> {
  restore(worktree); // git removes no worktree whose .git file is not the one it wrote, and the run may have replaced it.
  await run([`--git-dir=${worktree.gitDir}`, "worktree", "remove", "--force", worktree.path], `git worktree remove ${worktree.path}`);
}

/**
 * Keep the worktree for its owner to look at, as when what the run changed could not be sent: locked, so that neither `sweep` nor `close` removes it, with its .git file git's own again,
 * so that git run in it by hand works on the checkout's repository and not on one the run wrote.
 */
export async function lock(worktree: Worktree): Promise<void> {
  restore(worktree);
  await run([`--git-dir=${worktree.gitDir}`, "worktree", "lock", "--reason", "kept by Player Two for its owner to look at", worktree.path], `git worktree lock ${worktree.path}`);
}

/**
 * Remove the worktrees a desk that stopped without closing them left behind, in the checkouts under `dev`, and git's record of one whose folder is gone already.
 * One its owner locked (`git worktree lock`) is kept: neither command touches it. The checkouts' other worktrees are left alone. Nothing here throws.
 */
export async function sweep(dev: string): Promise<void> {
  const ours = `${existsSync(root()) ? realpathSync(root()) : root()}/`; // git writes a worktree's path with every link in it followed.
  let folders: string[];
  try {
    folders = readdirSync(dev);
  } catch {
    return; // No repos folder, so no checkout with a worktree in it.
  }
  for (const repo of folders.map((folder) => join(dev, folder)).filter((path) => existsSync(join(path, ".git", "worktrees")))) {
    const listed = await git(["-C", repo, "worktree", "list", "--porcelain", "-z"], LIMIT);
    const paths = listed.stdout.split("\0").flatMap((field) => (field.startsWith(`worktree ${ours}`) ? [field.slice("worktree ".length)] : []));
    const gone = paths.filter((path) => !existsSync(path));
    for (const path of paths.filter((each) => !gone.includes(each))) {
      await git(["-C", repo, "worktree", "remove", "--force", path], LIMIT);
    }
    if (gone.length > 0) {
      await git(["-C", repo, "worktree", "prune"], LIMIT); // It also forgets any other worktree of the repo's whose folder is gone and that is not locked, as `git gc` would.
    }
  }
}
