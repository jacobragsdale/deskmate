/** Branch rooms: channels pinned to one branch of a repo. Which are worth starting, and what to call one. No IO. */

import { branchNameSchema } from "./wire.ts";
import type { ChannelInfo, TeamRepo } from "./wire.ts";

const LONGEST = 32; // Most characters of a channel's name after its "#", as NAME in wire.ts allows.
const FALLBACK_DEFAULTS: ReadonlySet<string> = new Set(["main", "master"]); // Taken for a repo's default branch where its checkout's origin names none.

/** One branch of one repo, by the repo's name. */
export interface Room {
  readonly repo: string;
  readonly branch: string;
}

/** A room worth starting, with the teammates on its branch too. */
export interface Suggestion extends Room {
  readonly others: readonly string[];
}

/**
 * Whether a checkout's branch, as a desk advertises it, is one a room can be about, as a pin takes it: not a detached head, which reads "detached at a1b2c3d", nor ".invalid", which a reftable
 * repository's .git/HEAD holds and a desk that reads only that file takes for its branch.
 */
export function isBranch(branch: string): boolean {
  return branchNameSchema.safeParse(branch).success;
}

/**
 * The rooms worth suggesting to `me`: for each repo they share, the branch they are on, when it is not the repo's default, a teammate advertises the same branch of the same repo,
 * no channel is pinned to it, and they have not dismissed it. `defaults` has the default branch of each of their repos, by name, as its checkout's origin names it, null when it names none:
 * main and master are taken for it then.
 */
export function suggestions(team: readonly TeamRepo[], me: string, channels: readonly ChannelInfo[], defaults: ReadonlyMap<string, string | null>, dismissed: readonly Room[]): Suggestion[] {
  return team.flatMap(({ user, name, key, branch }) => {
    const known = defaults.get(name) ?? null;
    if (user !== me || !isBranch(branch) || (known === null ? FALLBACK_DEFAULTS.has(branch) : branch === known)) {
      return [];
    }
    const others = team.filter((theirs) => theirs.user !== me && theirs.key === key && theirs.branch === branch).map((theirs) => theirs.user);
    const started = channels.some((channel) => channel.repo?.key === key && channel.branch === branch);
    const gone = dismissed.some((room) => room.repo === name && room.branch === branch);
    return others.length === 0 || started || gone ? [] : [{ repo: name, branch, others }];
  });
}

/** Text as a channel's name may hold it: lowercase, each run of anything else one "-", and none at either end. */
function cleaned(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * A channel's name for a room about `branch` of `repo`, as "#uploader-feature-retry": both cleaned, the repo cut to leave the branch room, at least half the name, and the whole cut
 * to fit; then, while that is one of `taken`, with "-2", "-3" and so on in place of its end.
 */
export function roomName(repo: string, branch: string, taken: readonly string[]): string {
  const ofBranch = cleaned(branch);
  const ofRepo = cleaned(repo).slice(0, Math.max(LONGEST - 1 - ofBranch.length, LONGEST / 2));
  const base = [ofRepo, ofBranch].filter((part) => part !== "").join("-");
  for (let count = 1; ; count += 1) {
    const end = count === 1 ? "" : `-${String(count)}`;
    const name = `#${cleaned(base.slice(0, LONGEST - end.length))}${end}`;
    if (!taken.includes(name)) {
      return name;
    }
  }
}
