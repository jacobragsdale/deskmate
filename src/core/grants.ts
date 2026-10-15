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

/** A request of an agent ("owner/repo"), by whom, and when, in Unix seconds. */
interface Asked {
  readonly agent: string;
  readonly asker: string;
  readonly now: number;
  // The grant of each run the owner's desk has let go under one and not told the log of yet, as it does once git has said where the checkout stands: counted as the runs they are.
  readonly unlogged?: readonly string[];
}

/** A grant from the log as it applies to a request, or null when it does not: see `liveGrant`. */
function applying(grant: Entry, revocations: readonly Entry[], accepted: readonly Entry[], { agent, asker, now, unlogged = [] }: Asked): Grant | null {
  const said = readContent(grant.event);
  const { id, author } = grant.event;
  if (!grant.trusted || said.kind !== "grant" || said.content.agent !== agent || !agent.startsWith(`${author}/`)) {
    return null;
  }
  const logged = accepted.filter((entry) => entry.trusted && entry.event.author === author && now - entry.event.ts < DAY && grantOf(entry.event) === id).length;
  const runs = logged + unlogged.filter((each) => each === id).length;
  return covers(said.content.askers, asker) && !revoked(grant, revocations) && now < said.content.expires && runs < said.content.runsPerDay ? { id, ...said.content } : null;
}

/**
 * The grant that lets `asker`'s request of `agent` run at `now`, or null when none does. An entry whose signature does not hold counts for nothing.
 * A grant applies when its author owns the agent, it names the asker or "*", its author has not revoked it, `now` is before it expires, and its author accepted fewer than its `runsPerDay` jobs under it in the 24 hours before `now`,
 * counting the runs `unlogged` names. Counting from job.accepted in the log, rather than in memory, is what lets the limit survive a restart.
 * When several apply, the one that allows least wins: the lowest mode, then review before posting directly, then the first in the log.
 */
export function liveGrant(grants: readonly Entry[], revocations: readonly Entry[], accepted: readonly Entry[], request: Asked): Grant | null {
  const live = grants.toSorted((a, b) => a.seq - b.seq).flatMap((grant) => applying(grant, revocations, accepted, request) ?? []);
  return live.toSorted((a, b) => reach(a) - reach(b))[0] ?? null;
}
