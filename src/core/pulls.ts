/**
 * Azure DevOps pull requests and builds as a chat shows them: the references to a pull request in a message's text, the words for its votes and a build's state, a repo on Azure
 * DevOps by its key alone, and which web addresses the window opens. No IO.
 */

import { parseRemote } from "./remotes.ts";
import type { RepoRef } from "./wire.ts";

const AZURE = "dev.azure.com";
// "!123" where no letter, digit, "_" or "!" stands just before it or a letter, digit or "_" just after; or a pasted pull request's address, https on dev.azure.com exactly, whose
// organisation, project and repo are whatever stands between its slashes, up to its number, which a letter, digit, "_" or "/" may not follow.
const IN_TEXT = /(?<![\w!])!([1-9][0-9]{0,8})(?!\w)|https:\/\/dev\.azure\.com\/([^\s/?#]+)\/([^\s/?#]+)\/_git\/([^\s/?#]+)\/pullrequest\/([1-9][0-9]{0,8})(?![\w/])/gu;
// What each vote means, in the order a summary lists them. Azure DevOps votes 10 for approved, 5 with suggestions, 0 for none yet, -5 waiting for the author, -10 rejected.
const VOTES: readonly (readonly [number, string])[] = [
  [10, "approved"],
  [5, "approved with suggestions"],
  [0, "waiting"],
  [-5, "waiting for the author"],
  [-10, "rejected"]
];

/** A pull request a message refers to: in `repo`, or with `repo` null in the repo its chat is pinned to, which "!123" means. */
export interface PullRef {
  readonly repo: RepoRef | null;
  readonly id: number;
}

/** A stretch of a message's text: plain, or a reference to a pull request. */
export interface PullPiece {
  readonly text: string;
  readonly pull: PullRef | null;
}

/** A repo on Azure DevOps by its key, "dev.azure.com/{organisation}/{project}/{repo}", its address made from the key rather than taken from whoever named it; null for a key anywhere else. */
export function onAzure(key: string): RepoRef | null {
  const [host, organisation, project, repo, ...more] = key.split("/");
  return host === AZURE && organisation !== undefined && project !== undefined && repo !== undefined && more.length === 0
    ? parseRemote(`https://${AZURE}/${organisation}/${project}/_git/${repo}`)
    : null;
}

/** A text cut into plain stretches and the references to pull requests in it, in order. A pasted address whose repo cannot be read is plain text. */
export function pullsIn(text: string): PullPiece[] {
  const pieces: PullPiece[] = [];
  let end = 0;
  for (const match of text.matchAll(IN_TEXT)) {
    const [whole, short, organisation, project, repo, id] = match;
    const ref = short === undefined ? onAzure(parseRemote(`https://${AZURE}/${organisation ?? ""}/${project ?? ""}/_git/${repo ?? ""}`)?.key ?? "") : null;
    if (short === undefined && ref === null) {
      continue;
    }
    pieces.push({ text: text.slice(end, match.index), pull: null }, { text: whole, pull: { repo: ref, id: Number(short ?? id) } });
    end = match.index + whole.length;
  }
  return [...pieces, { text: text.slice(end), pull: null }].filter((piece) => piece.text !== "");
}

/** How a pull request's reviewers have voted, as "2 approved, 1 waiting"; "" when it has none. A vote Azure DevOps has added since is counted by its number. */
export function votes(reviewers: readonly { readonly vote: number }[]): string {
  const counts = new Map<number, number>();
  for (const { vote } of reviewers) {
    counts.set(vote, (counts.get(vote) ?? 0) + 1);
  }
  const known = VOTES.flatMap(([vote, words]) => (counts.has(vote) ? [`${String(counts.get(vote))} ${words}`] : []));
  const other = [...counts].filter(([vote]) => !VOTES.some(([each]) => each === vote)).map(([vote, count]) => `${String(count)} voted ${String(vote)}`);
  return [...known, ...other].join(", ");
}

/** A build in words: its pipeline's name, then its result, or while it has none its status, as Azure gives either, "inProgress" read as "in progress". */
export function buildWords(build: { readonly name: string; readonly status: string; readonly result: string | null }): string {
  return `${build.name}: ${(build.result ?? build.status).replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`;
}

/** A web address from Azure DevOps that the window may open: https on dev.azure.com and nowhere else, with nobody's name in it; null for any other. */
export function azureWeb(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === AZURE && parsed.username === "" && parsed.password === "" ? parsed.href : null;
  } catch {
    return null; // Not an address at all.
  }
}
