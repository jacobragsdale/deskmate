/**
 * Delegation: whether an agent's request of another agent may run, judged from the log alone. The target's desk asks this before a request is offered to its owner or run under a grant.
 * Every function takes entries that already carry their trust verdict, as src/core/grants.ts does: one whose signature does not hold counts for nothing. No IO and no clock.
 */

import { mayCome, mentions } from "./chat.ts";
import type { Accepted, Entry } from "./chat.ts";
import { readContent } from "./kinds.ts";
import { isChannel, MODES, nameSchema, ownerOf } from "./wire.ts";
import type { Event, PermissionMode } from "./wire.ts";

export const MAX_DEPTH = 2; // Most agents a request may come through: the root's agent, and one it asked.
export const MAX_CHILDREN = 4; // Most agents one job may ask.
export const MAX_TREE = 8; // Most jobs that may be asked under one root request, the root's own not counted.
export const ROOT_TIME = 3_600; // Seconds from its owner letting the root's agent run after which nothing more may be asked under it.

/** One job: the request that asked it, the root's message or a job.request, the agent asked ("owner/repo"), and the jobs it asked in turn, oldest first. */
export interface Node {
  readonly request: Entry;
  readonly agent: string;
  readonly children: readonly Node[];
}

/** Whether a request may run, and if so the most its run may be let do: the lowest mode any job above it was let run at. */
export type Verdict = { readonly ok: true; readonly mode: PermissionMode } | { readonly ok: false; readonly reason: string };

/** The root request by its id with its text: a message a person wrote, whose signature holds. Null when the log holds no such event, as for a root made up. */
function rootOf(log: readonly Entry[], id: string): { readonly entry: Entry; readonly text: string } | null {
  const entry = log.find((each) => each.event.id === id);
  const said = entry === undefined ? null : readContent(entry.event);
  // A tag counts only in a message a person wrote, so an agent's message, should one ever be in the log, starts nothing.
  return entry?.trusted === true && said?.kind === "message" && nameSchema.safeParse(entry.event.author).success ? { entry, text: said.content.text } : null;
}

/** The jobs under a root request: one for each agent its message tags, each with the jobs it asked below it. None when the root is not a person's message in the log. */
export function tree(log: readonly Entry[], root: string): Node[] {
  const found = rootOf(log, root);
  // Only a request the chat counts: one whose signature holds, from an agent, as the last agent its chain names.
  const asked = log.filter((entry) => entry.trusted && entry.event.kind === "job.request" && entry.event.refs[0] === root && mayCome(entry.event)).toSorted((a, b) => a.seq - b.seq);
  // A job's children are the requests its agent made under the request it was asked: an event names its parent by id, which is the hash of what it signs, so no request can be its own ancestor.
  const under = (request: Entry, agent: string): Node => ({
    request,
    agent,
    children: asked.flatMap((child) => {
      const said = readContent(child.event);
      return said.kind === "job.request" && child.event.author === agent && child.event.refs[1] === request.event.id ? [under(child, said.content.target)] : [];
    })
  });
  return found === null ? [] : mentions(found.text).map(([owner, repo]) => under(found.entry, `${owner}/${repo}`));
}

/** The jobs from a root down to the one `asker` was asked by the request `parent`, or null when there is no such job under these roots. */
function path(nodes: readonly Node[], parent: string, asker: string): Node[] | null {
  for (const node of nodes) {
    if (node.request.event.id === parent && node.agent === asker) {
      return [node];
    }
    const deeper = path(node.children, parent, asker);
    if (deeper !== null) {
      return [node, ...deeper];
    }
  }
  return null;
}

/** The job `agent` was asked by the request `request`, under these roots; null when there is none. */
export function jobIn(nodes: readonly Node[], request: string, agent: string): Node | null {
  return path(nodes, request, agent)?.at(-1) ?? null;
}

/** A run of a job: what its owner let it do, and when. */
interface Run {
  readonly accepted: Accepted;
  readonly ts: number;
}

/**
 * What one event does to a job: starts a run of it, ends the run, ends it for good, or nothing. Only the owner's acceptance starts one. An end counts from the owner or from the agent itself, and a withdrawal only
 * from whoever asked; an answer or a withdrawal is for good. It follows the moves the chat's fold makes, erring towards ended: a withdrawal ends a job here whenever it comes.
 */
function move(job: Node, event: Event): Accepted | "end" | "over" | null {
  const [owner, repo] = job.agent.split("/");
  const said = readContent(event);
  if (said.kind === "job.withdrawn") {
    return said.content.agent === job.agent && event.author === job.request.event.author ? "over" : null;
  }
  if (said.kind === "job.accepted") {
    return event.author === owner && said.content.repo === repo ? said.content : null;
  }
  const ends = said.kind === "job.declined" || said.kind === "job.result" || said.kind === "job.error" || said.kind === "job.cancelled";
  if (!ends || said.content.repo !== repo || (event.author !== owner && event.author !== job.agent)) {
    return null;
  }
  return said.kind === "job.result" ? "over" : "end";
}

/** The run a job is working in: its owner's newest acceptance, when nothing has ended the job since; null when it is not working. */
function working(log: readonly Entry[], job: Node): Run | null {
  let live: Run | null = null;
  let over = false;
  for (const { event } of log.filter((entry) => entry.trusted && entry.event.refs[0] === job.request.event.id).toSorted((a, b) => a.seq - b.seq)) {
    const moved = move(job, event);
    if (moved === "end" || moved === "over") {
      live = null;
      over ||= moved === "over";
    } else if (moved !== null && !over) {
      live = { accepted: moved, ts: event.ts };
    }
  }
  return live;
}

/** Whether a request was sent to the chat its root is in: the same channel, or between the same two people, which is where everyone the root's chat holds can read it. */
function sameChat(root: Event, request: Event): boolean {
  const [a, b, c, d] = [ownerOf(root.author), root.to, ownerOf(request.author), request.to];
  return isChannel(b) ? d === b : !isChannel(d) && ((a === c && b === d) || (a === d && b === c));
}

/** The runs of the jobs a request came through, from the root's down, or why its chain does not hold: each of its agents must have been asked in turn, and be working, let ask other agents. */
function runsOf(log: readonly Entry[], hops: readonly Node[] | null, asker: string, chain: readonly string[]): Run[] | string {
  if (hops === null) {
    return `nothing here asked ${asker} the request it names`;
  }
  if (hops.map((hop) => hop.agent).join(" ") !== chain.join(" ")) {
    return "its chain is not the agents that asked";
  }
  const runs: Run[] = [];
  for (const hop of hops) {
    const run = working(log, hop);
    if (run === null) {
      return `${hop.agent} is not working on what it was asked`;
    }
    if (!run.accepted.delegate) {
      return `${hop.agent} was not let ask other agents`;
    }
    runs.push(run);
  }
  return runs;
}

/** Every job under a forest's roots, not counting the roots themselves. */
function below(nodes: readonly Node[]): Node[] {
  return nodes.flatMap((node) => [...node.children, ...below(node.children)]);
}

/** Why one more job asked by a request's asker, or under its root, would be too many; null when it would not. Only the requests before it in the log count, so its verdict never changes because of those after it. */
function crowded(forest: readonly Node[], asker: Node | undefined, request: Entry): string | null {
  const before = (node: Node): boolean => node.request.seq < request.seq;
  if ((asker?.children ?? []).filter(before).length >= MAX_CHILDREN) {
    return `${request.event.author} has already asked ${String(MAX_CHILDREN)} agents`;
  }
  return below(forest).filter(before).length >= MAX_TREE ? `${String(MAX_TREE)} agents have already been asked under its root` : null;
}

/**
 * Whether a job.request may go to its target, from what the log shows: it trusts nothing the request says that the log does not.
 * The request must come through at most MAX_DEPTH agents, not ask one of them again, and be sent to the chat its root is in. Each agent in its chain must have been asked, in turn, under a person's message tagging the first,
 * and each must be working on that, its owner having let it ask other agents. Its root must have been running for less than ROOT_TIME, and its asker and its root may not have asked
 * MAX_CHILDREN and MAX_TREE jobs before it. Whether a job is working is read from the whole log, so a request whose parent has since ended no longer may.
 */
export function checkRequest(log: readonly Entry[], request: Entry): Verdict {
  const said = readContent(request.event);
  if (!request.trusted || said.kind !== "job.request") {
    return { ok: false, reason: "it is not a request whose signature holds" };
  }
  const { target, chain } = said.content;
  const [root = "", parent = ""] = request.event.refs;
  const asker = request.event.author;
  if (chain.length > MAX_DEPTH) {
    return { ok: false, reason: `it has come through ${String(chain.length)} agents, and may come through at most ${String(MAX_DEPTH)}` };
  }
  if (chain.includes(target)) {
    return { ok: false, reason: `${target} is already in its chain` };
  }
  const rooted = rootOf(log, root);
  if (rooted !== null && !sameChat(rooted.entry.event, request.event)) {
    return { ok: false, reason: "it was not sent to the chat its root request is in" };
  }
  const forest = tree(log, root);
  const hops = path(forest, parent, asker);
  const runs = runsOf(log, hops, asker, chain);
  if (typeof runs === "string") {
    return { ok: false, reason: runs };
  }
  if (request.event.ts - (runs[0]?.ts ?? 0) >= ROOT_TIME) {
    return { ok: false, reason: `its root has been running for ${String(ROOT_TIME / 60)} minutes` };
  }
  const crowd = crowded(forest, hops?.at(-1), request);
  if (crowd !== null) {
    return { ok: false, reason: crowd };
  }
  // A child runs at most at its parent's mode. The lowest in the chain is taken, not the parent's alone, so a desk above that let its run go further than its own parent's does not lift the ceiling.
  return { ok: true, mode: runs.reduce<PermissionMode>((low, { accepted }) => (MODES.indexOf(accepted.mode) < MODES.indexOf(low) ? accepted.mode : low), "full") };
}

/** Everyone a request runs on the say of: whoever made the root request, and the owner of each agent it came through, each once. Null when it is not a job.request whose signature holds, or its root is not a person's message in the log. */
export function peopleInvolved(log: readonly Entry[], request: Entry): string[] | null {
  const said = readContent(request.event);
  const root = rootOf(log, request.event.refs[0] ?? "");
  return request.trusted && said.kind === "job.request" && root !== null ? [...new Set([root.entry.event.author, ...said.content.chain.map((agent) => agent.slice(0, agent.indexOf("/")))])] : null;
}
