/** Standing grants: what a grant and its revocation say, and when a grant lets a request run without its owner. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Entry } from "../src/core/chat.ts";
import { peopleInvolved } from "../src/core/delegation.ts";
import { DAY, liveGrant } from "../src/core/grants.ts";
import { MAX_GRANT, PUBLIC_KINDS, readContent } from "../src/core/kinds.ts";
import { loadKey, signEvent } from "../src/core/sign.ts";

const NOW = 1_800_000_000;
const key = loadKey("11".repeat(32));
const GRANT = { agent: "jacob/uploader", askers: ["bob"], mode: "read-only", delivery: "review", expires: NOW + 86_400, runsPerDay: 20 };

await test("a grant is read when it lasts at most 30 days from its own time and names an agent, askers, a mode and a daily limit of 1 to 1000; a revocation holds nothing", () => {
  const read = (kind: string, content: unknown, ts = NOW): string => {
    const found = readContent(signEvent(key, { author: "jacob", to: "*", kind, content: JSON.stringify(content), ts, refs: [] }));
    return found.kind === "unknown" ? "unknown" : `${found.kind} ${JSON.stringify(found.content)}`;
  };
  const fits = (changed: Readonly<Record<string, unknown>>, ts = NOW): boolean => read("grant", { ...GRANT, ...changed }, ts) !== "unknown";

  assert.equal(read("grant", GRANT), `grant ${JSON.stringify(GRANT)}`);
  assert.equal(read("grant.revoke", {}), "grant.revoke {}");
  assert.ok(fits({ askers: ["*"], mode: "full", delivery: "post", runsPerDay: 1000 }));
  assert.ok(fits({ expires: NOW + MAX_GRANT, runsPerDay: 1 }));
  assert.ok(!fits({ expires: NOW + MAX_GRANT + 1 })); // Longer than 30 days after the event was signed.
  assert.ok(fits({ expires: NOW + MAX_GRANT + 1 }, NOW + 1)); // The same expiry, signed a second later.
  assert.ok(!fits({ runsPerDay: 0 }));
  assert.ok(!fits({ runsPerDay: 1001 }));
  assert.ok(!fits({ mode: "admin" }));
  assert.ok(!fits({ agent: "uploader" })); // Whose agent it is is part of its name.
  assert.ok(!fits({ askers: ["Bob"] }));
  assert.ok(!fits({ delivery: "email" }));
  assert.deepEqual(PUBLIC_KINDS, new Set(["agent.register", "grant", "grant.revoke"])); // What may be sent to everyone.

  // An acceptance says who let the run go: its owner, or a grant of theirs by its event's id.
  const accepted = { repo: "uploader", branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: "read-only" };
  for (const by of ["owner", { grant: "b".repeat(64) }]) {
    assert.notEqual(read("job.accepted", { ...accepted, by }), "unknown");
  }
  for (const by of ["grant", { grant: "not an id" }, {}]) {
    assert.equal(read("job.accepted", { ...accepted, by }), "unknown");
  }
});

let lastSeq = 0;

/** An event as the hub would deliver it, the next in its log. */
function entry(author: string, kind: string, content: unknown, more: { readonly refs?: readonly string[]; readonly ts?: number; readonly trusted?: boolean } = {}): Entry {
  lastSeq += 1;
  return { seq: lastSeq, event: signEvent(key, { author, to: "*", kind, content: JSON.stringify(content), ts: more.ts ?? NOW, refs: more.refs ?? [] }), trusted: more.trusted ?? true };
}

/** jacob's acceptance of a run under a grant, or as its owner when `grant` is null. */
function run(grant: Entry | null, more: { readonly author?: string; readonly ts?: number; readonly trusted?: boolean } = {}): Entry {
  const by = grant === null ? "owner" : { grant: grant.event.id };
  return entry(more.author ?? "jacob", "job.accepted", { repo: "uploader", branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: "read-only", by }, more);
}

await test("a grant lets a request run when its author owns the agent, it names the asker or everyone, it is not revoked or expired, and its runs in the last 24 hours are under its daily limit", () => {
  const grant = entry("jacob", "grant", { ...GRANT, runsPerDay: 2 });
  const live = (grants: readonly Entry[], revocations: readonly Entry[], accepted: readonly Entry[], asker = "bob", now = NOW, agent = "jacob/uploader"): string | null =>
    liveGrant(grants, revocations, accepted, { agent, people: [asker], now })?.id ?? null;
  const id = grant.event.id;

  assert.deepEqual(liveGrant([grant], [], [], { agent: "jacob/uploader", people: ["bob"], now: NOW }), { id, ...GRANT, runsPerDay: 2, runsToday: 0 });
  assert.equal(live([grant], [], [], "carol"), null); // Not named.
  const everyone = entry("jacob", "grant", { ...GRANT, askers: ["*"] });
  assert.equal(live([everyone], [], [], "carol"), everyone.event.id);
  assert.equal(live([grant], [], [], "bob", NOW, "jacob/billing"), null); // Another agent.
  assert.equal(live([entry("bob", "grant", GRANT)], [], []), null); // Not bob's agent to grant.
  assert.equal(live([entry("jacob", "grant", GRANT, { trusted: false })], [], []), null);
  assert.equal(live([entry("jacob", "grant", { ...GRANT, expires: NOW + MAX_GRANT + 1 })], [], []), null); // Too long to be read as a grant.

  // Revoked, only by its author, and only by a revocation whose signature holds.
  assert.equal(live([grant], [entry("jacob", "grant.revoke", {}, { refs: [id] })], []), null);
  assert.equal(live([grant], [entry("bob", "grant.revoke", {}, { refs: [id] }), entry("jacob", "grant.revoke", {}, { refs: [id], trusted: false })], []), id);
  assert.equal(live([grant], [entry("jacob", "grant.revoke", {}, { refs: [everyone.event.id] })], []), id); // A revocation of another grant.

  // Live until the second it expires.
  assert.equal(live([grant], [], [], "bob", GRANT.expires - 1), id);
  assert.equal(live([grant], [], [], "bob", GRANT.expires), null);

  // Two runs a day: counted from its author's acceptances under it, and freed 24 hours after each.
  assert.equal(live([grant], [], [run(grant)]), id);
  assert.equal(live([grant], [], [run(grant), run(grant, { ts: NOW - DAY + 1 })]), null);
  assert.equal(live([grant], [], [run(grant), run(grant, { ts: NOW - DAY })]), id);
  assert.equal(live([grant], [], [run(grant), run(grant, { author: "bob" }), run(grant, { trusted: false }), run(null), run(entry("jacob", "grant", GRANT))]), id); // None of these is a run under it.
  // A run its owner's desk has let go and not yet told the log of counts as one.
  assert.equal(liveGrant([grant], [], [run(grant)], { agent: "jacob/uploader", people: ["bob"], now: NOW, unlogged: [id] }), null);
  assert.equal(liveGrant([grant], [], [run(grant)], { agent: "jacob/uploader", people: ["bob"], now: NOW, unlogged: [everyone.event.id] })?.id, id);
});

await test("a grant covers an agent's request of another only when it names everyone the request runs on the say of, but its own author: whoever asked first and the owner of each agent it came through", () => {
  const billing = { ...GRANT, agent: "jacob/billing" };
  const root = entry("bob", "message", { text: "@jacob/uploader @carol/api does removing `retries` break anything?", via: "window" });
  /** `asker`'s request of jacob's billing agent, having come through `chain`, under bob's message. */
  const through = (asker: string, chain: readonly string[]): readonly string[] =>
    peopleInvolved([root], entry(asker, "job.request", { target: "jacob/billing", text: "does it?", chain }, { refs: [root.event.id, root.event.id] })) ?? assert.fail();
  const covering = (askers: readonly string[], people: readonly string[]): boolean =>
    liveGrant([entry("jacob", "grant", { ...billing, askers })], [], [], { agent: "jacob/billing", people, now: NOW }) !== null;
  const viaCarol = through("carol/api", ["carol/api"]);
  const viaJacob = through("jacob/uploader", ["jacob/uploader"]);

  assert.deepEqual(
    [viaCarol, viaJacob],
    [
      ["bob", "carol"],
      ["bob", "jacob"]
    ]
  );
  assert.ok(!covering(["bob"], viaCarol)); // carol never said her agent's say was enough.
  assert.ok(!covering(["carol"], viaCarol));
  assert.ok(covering(["bob", "carol"], viaCarol));
  assert.ok(covering(["*"], viaCarol));
  assert.ok(covering(["bob"], viaJacob)); // jacob's own agent asking: he agrees to his own part of the chain.
  assert.ok(!covering(["carol"], viaJacob));
  assert.ok(!covering(["*"], [])); // Nobody at all is covered by no grant.
  assert.ok(covering(["carol"], ["jacob"])); // A request on its author's say alone: the session never asks a grant for one (see P4-B4's note).
});

await test("when several grants apply, the one that allows least wins: the lowest mode, then review before posting, then the first in the log", () => {
  const full = entry("jacob", "grant", { ...GRANT, mode: "full" });
  const posts = entry("jacob", "grant", { ...GRANT, delivery: "post" });
  const first = entry("jacob", "grant", { ...GRANT, runsPerDay: 1 });
  const second = entry("jacob", "grant", GRANT);
  const names = new Map([full, posts, first, second].map((grant, at) => [grant.event.id, ["full", "posts", "first", "second"][at]]));
  const winner = (grants: readonly Entry[], accepted: readonly Entry[] = []): string | undefined =>
    names.get(liveGrant(grants, [], accepted, { agent: "jacob/uploader", people: ["bob"], now: NOW })?.id ?? "");

  assert.equal(winner([full]), "full");
  assert.equal(winner([full, posts]), "posts");
  assert.equal(winner([full, posts, first, second]), "first");
  assert.equal(winner([second, first, posts, full]), "first"); // Whatever order they are given in.
  assert.equal(winner([full, posts, first, second], [run(first)]), "second"); // The first has had its one run today: the next that applies.
});
