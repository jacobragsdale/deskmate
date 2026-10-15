/** Standing grants: whether one an agent's owner made lets a request run with nobody at their keyboard. The owner's desk decides with this; the hub never enforces a grant. No IO and no clock. */

import type { Entry } from "./chat.ts";
import { readContent } from "./kinds.ts";
import type { ContentOf } from "./kinds.ts";
import { MODES } from "./wire.ts";
import type { Event } from "./wire.ts";

export const DAY = 86_400; // Seconds over which the runs a grant has let go are counted.

/** A grant as its owner made it, with its event's id, which a run accepted under it names. */
export type Grant = ContentOf<"grant"> & { readonly id: string };

/** The grant a job.accepted says it ran under, `by: { grant: id }`, or null. */
function grantOf(event: Event): string | null {
  const said = readContent(event);
  return said.kind === "job.accepted" && said.content.by !== "owner" ? said.content.by.grant : null;
}

/** Whether a grant's author has revoked it, with a revocation whose signature holds: anyone else's counts for nothing. */
export function revoked(grant: Entry, revocations: readonly Entry[]): boolean {
  const { id, author } = grant.event;
  return revocations.some((entry) => entry.trusted && entry.event.author === author && entry.event.refs[0] === id && readContent(entry.event).kind === "grant.revoke");
}

/** Whether a grant's askers include `person`. */
function covers(askers: readonly string[], person: string): boolean {
  return askers.includes("*") || askers.includes(person);
}

/** How much a grant allows, to compare two: its mode's place in MODES, the order src/desk/permissions.ts's atMost uses, which the core cannot import from the desk; and at one mode, posting directly above review. */
function reach(grant: Grant): number {
  return MODES.indexOf(grant.mode) * 2 + Number(grant.delivery === "post");
}

/** A grant from the log that stands, with how many runs it let go in the 24 hours before the time it was looked at. */
export type Standing = Grant & { readonly runsToday: number };

/** A grant from the log as it stands at `now`, or null when it does not: see `standing`. */
function stands(grant: Entry, revocations: readonly Entry[], accepted: readonly Entry[], now: number, unlogged: readonly string[]): Standing | null {
  const said = readContent(grant.event);
  const { id, author } = grant.event;
  if (!grant.trusted || said.kind !== "grant" || !said.content.agent.startsWith(`${author}/`) || revoked(grant, revocations) || now >= said.content.expires) {
    return null;
  }
  const logged = accepted.filter((entry) => entry.trusted && entry.event.author === author && now - entry.event.ts < DAY && grantOf(entry.event) === id).length;
  return { id, ...said.content, runsToday: logged + unlogged.filter((each) => each === id).length };
}

/**
 * The grants that stand at `now`, first in the log first: each made by the owner of the agent it names, not revoked by its author, and not expired. An entry whose signature does not hold counts for nothing.
 * Each comes with how many jobs its author accepted under it in the 24 hours before `now`, and the runs `unlogged` names: the grant of each run its owner's desk has let go under one
 * and not told the log of yet, as it does once git has said where the checkout stands. Counting from job.accepted in the log, rather than in memory, is what lets the count survive a restart.
 */
export function standing(grants: readonly Entry[], revocations: readonly Entry[], accepted: readonly Entry[], now: number, unlogged: readonly string[] = []): Standing[] {
  return grants.toSorted((a, b) => a.seq - b.seq).flatMap((grant) => stands(grant, revocations, accepted, now, unlogged) ?? []);
}

/**
 * A request of an agent ("owner/repo"), on whose say it runs, and when, in Unix seconds; and, as `standing` takes them, the runs let go under a grant that the log does not hold yet.
 * `people` is the asker alone for a request in a message, and for an agent's request of another what src/core/delegation.ts's `peopleInvolved` gives: whoever asked first and the owner of each agent it came through.
 */
interface Asked {
  readonly agent: string;
  readonly people: readonly string[];
  readonly now: number;
  readonly unlogged?: readonly string[];
}

/**
 * Whether a grant covers everyone a request runs on the say of: each is among its askers, or is the grant's own author, the agent's owner, who agrees to their own part of a chain
 * as they need no grant to ask their own agent. Nobody at all is covered by no grant.
 */
function coversAll(grant: Standing, author: string, people: readonly string[]): boolean {
  return people.length > 0 && people.every((person) => person === author || covers(grant.askers, person));
}

/**
 * The grant that lets a request of `agent` on the say of `people` run at `now`, or null when none does: one that stands, names the agent, covers every one of them, and let go fewer than
 * its `runsPerDay` jobs in the 24 hours before `now`. When several apply, the one that allows least wins: the lowest mode, then review before posting directly, then the first in the log.
 */
export function liveGrant(grants: readonly Entry[], revocations: readonly Entry[], accepted: readonly Entry[], { agent, people, now, unlogged = [] }: Asked): Standing | null {
  const owner = agent.slice(0, agent.indexOf("/")); // A grant that stands was made by the owner of the agent it names.
  const live = standing(grants, revocations, accepted, now, unlogged).filter((grant) => grant.agent === agent && coversAll(grant, owner, people) && grant.runsToday < grant.runsPerDay);
  return live.toSorted((a, b) => reach(a) - reach(b))[0] ?? null;
}
