/** Delegation: what an agent's request of another agent says, whether an acceptance lets its agent ask others, and whether the log lets a request go to its target. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Entry } from "../src/core/chat.ts";
import { checkRequest, MAX_CHILDREN, MAX_TREE, peopleInvolved, ROOT_TIME, tree } from "../src/core/delegation.ts";
import type { Node } from "../src/core/delegation.ts";
import { readContent } from "../src/core/kinds.ts";
import { loadKey, signEvent } from "../src/core/sign.ts";

const NOW = 1_800_000_000;
const key = loadKey("11".repeat(32));

/** What an event of `kind` holding `content` is read as: its kind and content, or "unknown". */
function read(kind: string, content: unknown): string {
  const found = readContent(signEvent(key, { author: "jacob", to: "#backend", kind, content: JSON.stringify(content), ts: NOW, refs: [] }));
  return found.kind === "unknown" ? "unknown" : `${found.kind} ${JSON.stringify(found.content)}`;
}

await test("a job.request names an agent to ask, the text, and the agents it came through; an acceptance says whether its agent may ask others, and one that does not say lets it ask none", () => {
  const request = { target: "bob/billing", text: "Does removing `retries` break your caller?", chain: ["jacob/uploader"] };
  const accepted = { repo: "uploader", branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: "read-only" };

  assert.equal(read("job.request", request), `job.request ${JSON.stringify(request)}`);
  assert.equal(read("job.request", { ...request, chain: ["jacob/uploader", "bob/client"] }), `job.request ${JSON.stringify({ ...request, chain: ["jacob/uploader", "bob/client"] })}`);
  assert.equal(read("job.request", { ...request, chain: [] }), "unknown"); // Every request comes through the agent that sent it.
  assert.equal(read("job.request", { ...request, target: "billing" }), "unknown"); // Whose agent it is is part of its name.
  assert.equal(read("job.request", { ...request, chain: ["uploader"] }), "unknown");
  assert.equal(read("job.request", { ...request, text: "" }), "unknown");

  assert.equal(read("job.accepted", { ...accepted, delegate: true, by: "owner" }), `job.accepted ${JSON.stringify({ ...accepted, delegate: true, by: "owner" })}`);
  assert.equal(read("job.accepted", { ...accepted, by: "owner" }), `job.accepted ${JSON.stringify({ ...accepted, delegate: false, by: "owner" })}`); // As every acceptance from before phase 5 is.
  assert.equal(read("job.accepted", { ...accepted, delegate: "yes", by: "owner" }), "unknown");
});

let lastSeq = 0;

/**
 * An event as the hub would deliver it, the next in its log, with whether its signature holds. What is tested here reads that verdict and never a signature, so an agent's event is signed
 * with jacob's key and then given the agent as its author: the envelope takes an agent as an author only from phase 4.
 */
function entry(author: string, kind: string, content: unknown, refs: readonly (Entry | string)[] = [], more: { readonly ts?: number; readonly trusted?: boolean } = {}): Entry {
  lastSeq += 1;
  const ids = refs.map((each) => (typeof each === "string" ? each : each.event.id));
  const event = signEvent(key, { author: "jacob", to: "#backend", kind, content: JSON.stringify(content), ts: more.ts ?? NOW, refs: ids });
  return { seq: lastSeq, event: { ...event, author }, trusted: more.trusted ?? true };
}

/** A message someone typed in #backend. */
function say(author: string, text: string, trusted = true): Entry {
  return entry(author, "message", { text, via: "window" }, [], { trusted });
}

/** The owner of `agent` letting it run on `request`, at full and letting it ask others unless told otherwise. */
function accept(agent: string, request: Entry, more: { readonly delegate?: boolean; readonly mode?: string; readonly author?: string; readonly ts?: number; readonly trusted?: boolean } = {}): Entry {
  const [owner = "", repo = ""] = agent.split("/");
  const content = { repo, branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: more.mode ?? "full", delegate: more.delegate ?? true, by: "owner" };
  return entry(more.author ?? owner, "job.accepted", content, [request], more);
}

/** `asker`, at work on `parent` under `root`, asking `target`, having come through `chain`. */
function ask(asker: string, root: Entry | string, parent: Entry | string, target: string, chain: readonly string[], more: { readonly ts?: number; readonly trusted?: boolean } = {}): Entry {
  return entry(asker, "job.request", { target, text: "Does removing `retries` from UploadOptions break your caller?", chain }, [root, parent], more);
}

/** A job's end, said by `author` about `agent`'s job on `request`. */
function end(author: string, kind: string, agent: string, request: Entry): Entry {
  const repo = agent.slice(agent.indexOf("/") + 1);
  const content = { "job.result": { repo, branch: "main", text: "no", reviewed: false }, "job.declined": { repo, reason: "" }, "job.withdrawn": { agent } }[kind] ?? { repo };
  return entry(author, kind, content, [request]);
}

/** What checkRequest says of `request`: "ok" and the mode its run is held to, or why not. */
function verdict(log: readonly Entry[], request: Entry): string {
  const said = checkRequest(log, request);
  return said.ok ? `ok ${said.mode}` : said.reason;
}

/** bob asks jacob's uploader agent, which asks carol's client agent, which asks dave's billing agent; jacob and carol let theirs run at full and ask others. */
function scenario(): { readonly root: Entry; readonly first: Entry; readonly second: Entry; readonly log: readonly Entry[] } {
  const root = say("bob", "@jacob/uploader does removing `retries` from UploadOptions break anything?");
  const first = ask("jacob/uploader", root, root, "carol/client", ["jacob/uploader"]);
  const second = ask("carol/client", root, first, "dave/billing", ["jacob/uploader", "carol/client"]);
  return { root, first, second, log: [root, accept("jacob/uploader", root), first, accept("carol/client", first), second] };
}

/** A tree as one line: each agent, with the agents it asked in brackets after it. */
function shape(nodes: readonly Node[]): string {
  return nodes.map((node) => (node.children.length === 0 ? node.agent : `${node.agent} [${shape(node.children)}]`)).join(", ");
}

await test("a request may go to its target when each agent it came through was asked in turn under a person's message and is working, let ask others; the tree and the people involved are read from the log", () => {
  const { root, first, second, log } = scenario();

  assert.equal(verdict(log, first), "ok full");
  assert.equal(verdict(log, second), "ok full");
  assert.equal(verdict(log, { ...second, trusted: false }), "it is not a request whose signature holds");
  assert.equal(verdict(log, root), "it is not a request whose signature holds");
  assert.equal(shape(tree(log, root.event.id)), "jacob/uploader [carol/client [dave/billing]]");
  // A message that tags two agents is the root of a tree for each; a request whose signature does not hold is in none, and one under another root is in that root's.
  const both = say("bob", "@jacob/uploader and @carol/client, where do we retry?");
  const more = [...log, both, ask("carol/client", both, both, "dave/billing", ["carol/client"]), ask("jacob/uploader", both, both, "erin/api", ["jacob/uploader"], { trusted: false })];
  assert.equal(shape(tree(more, both.event.id)), "jacob/uploader, carol/client [dave/billing]");
  assert.equal(shape(tree([...more, ask("jacob/uploader", root, root, "erin/api", ["jacob/uploader"])], root.event.id)), "jacob/uploader [carol/client [dave/billing], erin/api]");
  assert.deepEqual(tree(log, first.event.id), []); // Only a person's message is a root.
  assert.deepEqual(peopleInvolved(log, first), ["bob", "jacob"]);
  assert.deepEqual(peopleInvolved(log, second), ["bob", "jacob", "carol"]);
  assert.deepEqual(peopleInvolved(log, ask("bob/client", root, root, "carol/billing", ["bob/client"])), ["bob"]); // Each person once.
  assert.equal(peopleInvolved(log, { ...second, trusted: false }), null);
  assert.equal(peopleInvolved(log.slice(1), second), null); // Without its root nobody can say who asked first.
});

await test("depth: a request may come through at most two agents", () => {
  const { root, second, log } = scenario();
  const third = ask("dave/billing", root, second, "erin/api", ["jacob/uploader", "carol/client", "dave/billing"]);

  assert.equal(verdict([...log, accept("dave/billing", second), third], third), "it has come through 3 agents, and may come through at most 2");
});

await test("no repeats: an agent may not ask itself or an agent its request came through", () => {
  const { root, first, log } = scenario();

  assert.equal(verdict(log, ask("jacob/uploader", root, root, "jacob/uploader", ["jacob/uploader"])), "jacob/uploader is already in its chain");
  assert.equal(verdict(log, ask("carol/client", root, first, "jacob/uploader", ["jacob/uploader", "carol/client"])), "jacob/uploader is already in its chain");
  assert.equal(verdict(log, ask("carol/client", root, first, "carol/client", ["jacob/uploader", "carol/client"])), "carol/client is already in its chain");
  assert.equal(verdict(log, ask("carol/client", root, first, "bob/client", ["jacob/uploader", "carol/client"])), "ok full"); // Another agent of someone already involved.
});

await test("fan-out: one job may ask at most four agents, counting only those it asked before", () => {
  const { root, log } = scenario();
  const asked = ["bob/client", "erin/api", "frank/web", "gina/db"].map((target) => ask("jacob/uploader", root, root, target, ["jacob/uploader"]));
  const all = [...log, ...asked];

  assert.equal(MAX_CHILDREN, 4);
  assert.equal(verdict(all, asked[2] ?? assert.fail()), "ok full"); // The fourth, carol's agent being the first.
  assert.equal(verdict(all, asked[3] ?? assert.fail()), "jacob/uploader has already asked 4 agents");
  assert.equal(verdict(all, ask("carol/client", root, log[2] ?? assert.fail(), "gina/db", ["jacob/uploader", "carol/client"])), "ok full"); // Another job's children are its own.
});

await test("tree size: at most eight jobs may be asked under one root, counting only those asked before", () => {
  const { root, first, log } = scenario();
  const below = ["bob/client", "erin/api", "frank/web"].map((target) => ask("jacob/uploader", root, root, target, ["jacob/uploader"])); // With carol's agent, four under jacob's.
  const further = ["bob/api", "erin/web", "frank/db"].map((target) => ask("carol/client", root, first, target, ["jacob/uploader", "carol/client"])); // With dave's, four under carol's.
  const bob = below[0] ?? assert.fail();
  const ninth = ask("bob/client", root, bob, "gina/db", ["jacob/uploader", "bob/client"]);
  const all = [...log, ...below, ...further, accept("bob/client", bob), ninth];

  assert.equal(MAX_TREE, 8);
  assert.equal(verdict(all, further[2] ?? assert.fail()), "ok full"); // The eighth.
  assert.equal(verdict(all, ninth), "8 agents have already been asked under its root");
});

await test("mode: a request's run may do at most what the least any agent above it was let do", () => {
  const root = say("bob", "@jacob/uploader does removing `retries` break anything?");
  const first = ask("jacob/uploader", root, root, "carol/client", ["jacob/uploader"]);
  const second = ask("carol/client", root, first, "dave/billing", ["jacob/uploader", "carol/client"]);
  const under = (rootMode: string, firstMode: string): string =>
    verdict([root, accept("jacob/uploader", root, { mode: rootMode }), first, accept("carol/client", first, { mode: firstMode }), second], second);

  assert.equal(verdict([root, accept("jacob/uploader", root, { mode: "auto-edits" }), first], first), "ok auto-edits");
  assert.equal(under("auto-edits", "read-only"), "ok read-only");
  assert.equal(under("supervised", "supervised"), "ok supervised");
  assert.equal(under("auto-edits", "full"), "ok auto-edits"); // carol let hers go further than its parent: the ceiling stays.
});

await test("time: nothing more may be asked under a root an hour after its agent was let run", () => {
  const root = say("bob", "@jacob/uploader does removing `retries` break anything?");
  const first = ask("jacob/uploader", root, root, "carol/client", ["jacob/uploader"]);
  const late = (ts: number): string => {
    const second = ask("carol/client", root, first, "dave/billing", ["jacob/uploader", "carol/client"], { ts });
    return verdict([root, accept("jacob/uploader", root, { ts: NOW }), first, accept("carol/client", first, { ts: NOW + 60 }), second], second);
  };

  assert.equal(late(NOW + ROOT_TIME - 1), "ok full");
  assert.equal(late(NOW + ROOT_TIME), "its root has been running for 60 minutes");
});

await test("a chain is false when an agent in it was never accepted by its owner", () => {
  const { root, first, second, log } = scenario();
  const [question, rootRun] = log;
  const unaccepted = [question ?? assert.fail(), rootRun ?? assert.fail(), first, second];

  assert.equal(verdict(unaccepted, second), "carol/client is not working on what it was asked");
  assert.equal(verdict([...unaccepted, accept("carol/client", first, { author: "jacob" })], second), "carol/client is not working on what it was asked"); // Only carol lets hers run.
  assert.equal(verdict([...unaccepted, accept("carol/client", first, { author: "carol/client" })], second), "carol/client is not working on what it was asked"); // Nor does it let itself.
  assert.equal(verdict([...unaccepted, accept("carol/client", first, { trusted: false })], second), "carol/client is not working on what it was asked");
  assert.equal(verdict([question ?? assert.fail(), first], first), "jacob/uploader is not working on what it was asked");
  assert.equal(verdict(log, ask("carol/client", root, root, "dave/billing", ["carol/client"])), "nothing here asked carol/client the request it names"); // Never asked under the root itself.
});

await test("a chain is false when an agent in it has finished, been stopped or withdrawn", () => {
  const { first, second, log } = scenario();
  const after = (...more: readonly Entry[]): string => verdict([...log, ...more], second);

  assert.equal(after(end("carol/client", "job.result", "carol/client", first)), "carol/client is not working on what it was asked"); // Answered by the agent itself, as from phase 4.
  assert.equal(after(end("carol", "job.result", "carol/client", first)), "carol/client is not working on what it was asked");
  assert.equal(after(end("carol", "job.error", "carol/client", first)), "carol/client is not working on what it was asked");
  assert.equal(after(end("carol/client", "job.cancelled", "carol/client", first)), "carol/client is not working on what it was asked");
  assert.equal(after(end("carol", "job.declined", "carol/client", first)), "carol/client is not working on what it was asked");
  assert.equal(after(end("jacob/uploader", "job.withdrawn", "carol/client", first)), "carol/client is not working on what it was asked"); // Taken back by the agent that asked.
  assert.equal(after(end("bob", "job.withdrawn", "carol/client", first), end("dave", "job.error", "carol/client", first)), "ok full"); // Neither speaks for it.
  assert.equal(after(end("carol", "job.error", "carol/client", first), accept("carol/client", first)), "ok full"); // Run again.
  assert.equal(after(end("carol", "job.result", "carol/client", first), accept("carol/client", first)), "carol/client is not working on what it was asked"); // An answer is final.
  assert.equal(after(end("jacob", "job.result", "jacob/uploader", log[0] ?? assert.fail())), "jacob/uploader is not working on what it was asked"); // The root's agent has answered.
});

await test("a chain is false when an agent in it was accepted without being let ask others", () => {
  const root = say("bob", "@jacob/uploader does removing `retries` break anything?");
  const first = ask("jacob/uploader", root, root, "carol/client", ["jacob/uploader"]);
  const before = entry("jacob", "job.accepted", { repo: "uploader", branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: "full", by: "owner" }, [root]); // From before phase 5.

  assert.equal(verdict([root, accept("jacob/uploader", root, { delegate: false }), first], first), "jacob/uploader was not let ask other agents");
  assert.equal(verdict([root, before, first], first), "jacob/uploader was not let ask other agents");
  assert.equal(verdict([root, accept("jacob/uploader", root), accept("jacob/uploader", root, { delegate: false }), first], first), "jacob/uploader was not let ask other agents"); // The newest acceptance counts.
});

await test("a chain is false when its root is made up, or it names agents other than those that asked", () => {
  const { root, first, second, log } = scenario();
  const madeUp = "ab".repeat(32);
  const rootless = log.filter((each) => each !== root);

  assert.equal(verdict(log, ask("jacob/uploader", madeUp, madeUp, "carol/client", ["jacob/uploader"])), "nothing here asked jacob/uploader the request it names");
  assert.equal(verdict(rootless, second), "nothing here asked carol/client the request it names");
  assert.equal(verdict([{ ...root, trusted: false }, ...rootless], second), "nothing here asked carol/client the request it names");
  assert.equal(verdict([{ ...root, event: { ...root.event, author: "bob/client" } }, ...rootless], second), "nothing here asked carol/client the request it names"); // Only a person's message starts anything.
  const untagged = say("bob", "does removing `retries` break anything?");
  const claimed = ask("jacob/uploader", untagged, untagged, "carol/client", ["jacob/uploader"]);
  assert.equal(verdict([untagged, accept("jacob/uploader", untagged), claimed], claimed), "nothing here asked jacob/uploader the request it names");
  assert.equal(verdict(log, ask("carol/client", root, first, "dave/billing", ["bob/uploader", "carol/client"])), "its chain is not the agents that asked");
  assert.equal(verdict(log, ask("carol/client", root, first, "dave/billing", ["carol/client"])), "its chain is not the agents that asked");
});
