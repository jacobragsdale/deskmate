/** Delegation: what an agent's request of another agent says, whether an acceptance lets its agent ask others, and whether the log lets a request go to its target. */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Entry } from "../src/core/chat.ts";
import { checkRequest, MAX_CHILDREN, MAX_TREE, peopleInvolved, ROOT_TIME, tree } from "../src/core/delegation.ts";
import type { Node } from "../src/core/delegation.ts";
import { readContent } from "../src/core/kinds.ts";
import { loadKey, publicHex, signEvent } from "../src/core/sign.ts";
import type { Delivered, PermissionMode } from "../src/core/wire.ts";
import { agentKey } from "../src/desk/agentKeys.ts";
import { askUnder } from "../src/desk/notes.ts";
import type { Client } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import type { Notice, ReplyView } from "../src/shared/ipc.ts";
import { startHub, TEAM_REPOS } from "./startHub.ts";
import type { Hub } from "./startHub.ts";

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

await test("a request is refused when it is not sent to the chat its root is in, where everyone the root's chat holds can read it", () => {
  const { second, log } = scenario();
  const to = (where: string, entry: Entry): Entry => ({ ...entry, event: { ...entry.event, to: where } }); // What is tested reads the trust verdict, not the signature.
  const [root = assert.fail(), ...rest] = log;

  assert.equal(verdict([root, ...rest.slice(0, -1), to("#ops", second)], to("#ops", second)), "it was not sent to the chat its root request is in");
  assert.equal(verdict([to("jacob", root), ...rest], to("dave", second)), "it was not sent to the chat its root request is in"); // A direct chat between bob and jacob, sent between carol and dave.
  assert.equal(verdict([to("jacob", root), ...rest], to("jacob", second)), "it was not sent to the chat its root request is in"); // Between carol and jacob.
  assert.equal(verdict([to("carol", root), ...rest], to("bob", second)), "ok full"); // Between bob and carol either way round.
});

// ── on the desks ─────────────────────────────────────────────────────────────

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");
const COMMIT = "c0ffee".padEnd(40, "0");

/** Try `find` every 50 ms, for fifteen seconds, until it finds something. */
async function eventually<T>(what: string, find: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let tries = 0; tries < 300; tries += 1) {
    const found = await find();
    if (found !== undefined && found !== false) {
      return found;
    }
    await delay(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** One person's running desk, with their client, the notices it gave, and every message and reply its view of #team shows, by id. */
interface Desk {
  readonly client: Client;
  readonly session: Session;
  readonly notices: Notice[];
  readonly shown: (id: string) => ReplyView | undefined;
}

/** `name` on the hub, in #team, and their desk, with a checkout of each of `repos`, answering with the scripted ACP agent started with `args`. */
async function deskOf(t: TestContext, hub: Hub, name: string, repos: readonly string[], args: readonly string[] = ["--no-pids"]): Promise<Desk> {
  const client = await hub.join(name);
  client.saveAgents([{ id: "fake", label: "Fake", protocol: "acp", command: process.execPath, args: [FAKE, ...args] }], "fake");
  await client.publish("#team", "channel.join", {});
  const dev = join(hub.dir, `dev-${name}`);
  for (const repo of repos) {
    mkdirSync(join(dev, repo, ".git"), { recursive: true });
    writeFileSync(join(dev, repo, ".git", "config"), `[remote "origin"]\n\turl = ${TEAM_REPOS}Platform/_git/${repo}\n`);
    writeFileSync(join(dev, repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  const notices: Notice[] = [];
  const hooks = {
    changed: () => undefined,
    notice: (notice: Notice) => {
      notices.push(notice);
    },
    arrived: () => undefined,
    confirmClone: () => Promise.resolve(false)
  };
  const session = new Session(client, dev, hooks, { presence: 1, describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
  session.start();
  t.after(() => session.stop());
  await eventually(`${name}'s desk`, () => session.view().loaded && repos.every((repo) => session.view().myRepos.includes(repo)) && session.view().rows.some((row) => row.chat === "#team"));
  await session.handle({ do: "open", chat: "#team" });
  const shown = (id: string): ReplyView | undefined =>
    session
      .view()
      .current?.messages.flatMap((message) => [message, ...message.replies])
      .find((message) => message.id === id);
  return { client, session, notices, shown };
}

/** The event of `kind` about the request `id` that `author` sent, once `reader` can see it in #team. */
function sent(reader: Client, id: string, author: string, kind: string): Promise<Delivered> {
  return eventually(`${author}'s ${kind}`, async () => (await reader.events({ chat: "#team" })).find(({ event }) => event.refs[0] === id && event.author === author && event.kind === kind));
}

await test(
  "an agent's request of another is declined by its target's desk, saying why, when the log does not let it go; else it is offered with its chain, at no more than the chain was let do, or runs under a grant naming everyone it runs on the say of",
  { timeout: 120_000 },
  async (t) => {
    const hub = await startHub(t, () => Date.now() / 1000);
    const carol = await deskOf(t, hub, "carol", ["billing", "api"]);
    const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
    for (const who of [bob, jacob]) {
      await who.publish("#team", "channel.join", {});
    }
    const key = agentKey(join(hub.dir, "jacob"), "uploader");
    await jacob.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(key) });
    const uploader = jacob.as("jacob/uploader", key);
    /** Bob asks jacob's uploader agent, and jacob lets it go at `mode`, asking others when `delegate`, as his desk would. */
    const root = async (delegate = true, mode: PermissionMode = "auto-edits"): Promise<string> => {
      const { id } = (await bob.publish("#team", "message", { text: "@jacob/uploader does removing `retries` break anything?", via: "cli" })).event;
      await jacob.publish("#team", "job.accepted", { repo: "uploader", branch: "main", commit: COMMIT, dirty: false, delivery: "post", mode, delegate, by: "owner" }, [id]);
      return id;
    };
    /** Jacob's agent asks one of carol's under `under`, as its MCP server would. */
    const ask = async (under: string, target = "carol/billing"): Promise<string> =>
      (await uploader.publish("#team", "job.request", { target, text: "mcp", chain: ["jacob/uploader"] }, [under, under])).event.id;
    const reason = async (id: string): Promise<string> => {
      const said = readContent((await sent(bob, id, "carol", "job.declined")).event);
      return said.kind === "job.declined" ? said.content.reason : "";
    };
    const offered = (id: string): Promise<ReplyView> => eventually("carol is offered it", () => (carol.shown(id)?.requests[0]?.status.kind === "ready" ? carol.shown(id) : undefined));

    // Under a run not let ask others: declined, saying why.
    assert.equal(await reason(await ask(await root(false))), "jacob/uploader was not let ask other agents");

    // Let: offered to carol with its chain in words, at no more than jacob let his run do.
    const first = await root();
    const asked = await ask(first);
    const view = await offered(asked);
    assert.deepEqual(view.delegation, { first: "bob", chain: ["jacob/uploader"], target: "carol/billing", words: "bob asked jacob's uploader agent, which is asking your billing agent" });
    assert.deepEqual(view.requests[0]?.status, { kind: "ready", before: "", canDecline: true, offer: { mode: "read-only", post: false }, ceiling: "auto-edits" });
    const run = (id: string, mode: PermissionMode, repo = "billing"): Promise<void> => carol.session.handle({ do: "run", id, repo, post: true, mode, text: "mcp" });
    await assert.rejects(run(asked, "full"), /^Error: jacob's uploader agent's request may run at most auto-edits, as no agent it came through was let do more$/);
    await run(asked, "auto-edits");
    assert.match(readContent((await sent(bob, asked, "carol/billing", "job.result")).event).kind, /job.result/);

    // Once jacob's agent has answered, what it asked before may not go: a click on it is refused, saying why.
    const late = await ask(first, "carol/api");
    await offered(late);
    await uploader.publish("#team", "job.result", { repo: "uploader", branch: "main", text: "no", reviewed: false }, [first]);
    await eventually("carol sees it answered", () => carol.shown(first)?.requests.length === 0);
    await assert.rejects(run(late, "read-only", "api"), /may not go: jacob\/uploader is not working on what it was asked/);

    // A grant for bob alone does not cover a request that came through jacob's agent; one for bob and jacob does, at no more than the chain lets, asking nobody, with no MCP server.
    assert.equal((await carol.session.testPermissions("fake")).status, "ok");
    const grant = (askers: readonly string[]): Promise<void> => carol.session.handle({ do: "grant", repo: "billing", askers, mode: "full", delivery: "post", lasts: 3600, runsPerDay: 20 });
    for (const askers of [["bob"], ["jacob"]]) {
      await grant(askers); // Neither alone names everyone the next request runs on the say of.
      const waits = await ask(await root());
      await offered(waits);
      await delay(500);
      assert.ok(!(await bob.events({ chat: "#team" })).some(({ event }) => event.refs[0] === waits && event.kind === "job.accepted"), askers.join());
    }
    await grant(["bob", "jacob"]);
    const granted = await ask(await root());
    const accepted = readContent((await sent(bob, granted, "carol", "job.accepted")).event);
    assert.ok(accepted.kind === "job.accepted" && accepted.content.by !== "owner");
    assert.deepEqual([accepted.content.mode, accepted.content.delegate], ["auto-edits", false]);
    const answer = readContent((await sent(bob, granted, "carol/billing", "job.result")).event);
    assert.match(answer.kind === "job.result" ? answer.content.text : "", /; servers \[\]$/); // Its prompt says where every member can read it, which the scripted agent takes for "read".

    // A chain everyone in which is carol consults no grant, though one names everyone else in it: her own agent asking her other waits for her.
    const own = (await carol.client.publish("#team", "message", { text: "@carol/api and you?", via: "cli" })).event.id;
    await carol.client.publish("#team", "job.accepted", { repo: "api", branch: "main", commit: COMMIT, dirty: false, delivery: "post", mode: "full", delegate: true, by: "owner" }, [own]);
    const api = carol.client.as("carol/api", agentKey(join(hub.dir, "carol"), "api"));
    const mine = (await api.publish("#team", "job.request", { target: "carol/billing", text: "mcp", chain: ["carol/api"] }, [own, own])).event.id;
    assert.deepEqual((await offered(mine)).delegation?.words, "you asked your api agent, which is asking your billing agent");
    await delay(500);
    assert.ok(!(await bob.events({ chat: "#team" })).some(({ event }) => event.refs[0] === mine && event.kind === "job.accepted"));
  }
);

await test(
  "an agent's answer to another reaches the agent that asked only once it is posted in the chat: kept for its owner to review, it waits until they send it, as they edited it",
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHub(t, () => Date.now() / 1000);
    const carol = await deskOf(t, hub, "carol", ["billing"]);
    const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
    for (const who of [bob, jacob]) {
      await who.publish("#team", "channel.join", {});
    }
    const key = agentKey(join(hub.dir, "jacob"), "uploader");
    await jacob.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(key) });
    const { id: root } = (await bob.publish("#team", "message", { text: "@jacob/uploader does removing `retries` break anything?", via: "cli" })).event;
    await jacob.publish("#team", "job.accepted", { repo: "uploader", branch: "main", commit: COMMIT, dirty: false, delivery: "post", mode: "full", delegate: true, by: "owner" }, [root]);

    let settled = false;
    const asking = askUnder(jacob.as("jacob/uploader", key), root, "carol/billing", "does it break your caller?", 30).finally(() => {
      settled = true;
    });
    const request = await eventually("jacob's agent's request", async () => (await bob.events({ chat: "#team" })).find(({ event }) => event.kind === "job.request"));
    const { id } = request.event;
    await eventually("carol is offered it", () => carol.shown(id)?.requests[0]?.status.kind === "ready");
    await carol.session.handle({ do: "run", id, repo: "billing", post: false, mode: "read-only", text: "does it break your caller?" });
    const draft = await eventually("carol's draft", () => carol.session.view().current?.drafts.find((each) => each.id === id));
    assert.match(draft.text, /^turn 1: /);
    await delay(500);
    assert.equal(settled, false); // Nothing of it is in the chat, so jacob's agent has nothing.
    assert.ok(!(await bob.events({ chat: "#team" })).some(({ event }) => event.kind === "job.result"));

    await carol.session.handle({ do: "sendDraft", chat: "#team", id, repo: "billing", text: "No: nothing passes it." });
    const asked = await asking;
    assert.ok(!("refused" in asked));
    assert.deepEqual([asked.state, asked.answer?.text, asked.answer?.entry.event.author], ["answered", "No: nothing passes it.", "carol"]); // As carol sent it, under her name.
  }
);

await test(
  "withdrawing and stopping travel down the tree: a run let ask others that ends takes back what it asked, its asker may take back the root while it works, and a desk stops what it was asked once that is taken back or what asked it has ended",
  { timeout: 120_000 },
  async (t) => {
    const hub = await startHub(t, () => Date.now() / 1000);
    const bob = await deskOf(t, hub, "bob", ["client"]);
    const jacob = await deskOf(t, hub, "jacob", ["uploader"]);
    const carol = await deskOf(t, hub, "carol", ["billing"]);
    const uploader = jacob.client.as("jacob/uploader", agentKey(join(hub.dir, "jacob"), "uploader"));
    const run = async (desk: Desk, id: string, repo: string, delegate = true): Promise<void> => {
      await eventually("it can be run", () => desk.shown(id)?.requests[0]?.status.kind === "ready");
      await desk.session.handle({ do: "run", id, repo, post: true, mode: "full", text: desk.shown(id)?.body ?? "", delegate });
      await sent(bob.client, id, desk.client.config.name, "job.accepted");
    };
    /** Bob asks jacob's agent to take its time, and jacob lets it, asking others; it asks carol's to take its time too, and carol lets it. Resolves with both requests' ids. */
    const tree = async (): Promise<{ readonly root: string; readonly child: string }> => {
      const { id: root } = (await bob.client.publish("#team", "message", { text: "@jacob/uploader slow", via: "cli" })).event;
      await run(jacob, root, "uploader");
      const { id: child } = (await uploader.publish("#team", "job.request", { target: "carol/billing", text: "slow", chain: ["jacob/uploader"] }, [root, root])).event;
      await run(carol, child, "billing", false);
      return { root, child };
    };
    const stopped = (id: string, agent: string): Promise<Delivered> => sent(bob.client, id, agent, "job.cancelled");

    // Jacob stops his run: his desk takes back what his agent asked, at work or still waiting, and carol's desk stops hers.
    const first = await tree();
    const { id: waiting } = (await uploader.publish("#team", "job.request", { target: "bob/client", text: "read", chain: ["jacob/uploader"] }, [first.root, first.root])).event;
    await eventually("bob is offered it", () => bob.shown(waiting)?.requests[0]?.status.kind === "ready");
    await jacob.session.handle({ do: "stop", id: first.root, repo: "uploader" });
    await stopped(first.root, "jacob/uploader");
    for (const [id, agent] of [
      [first.child, "carol/billing"],
      [waiting, "bob/client"]
    ] satisfies [string, string][]) {
      assert.deepEqual(readContent((await sent(bob.client, id, "jacob/uploader", "job.withdrawn")).event), { kind: "job.withdrawn", content: { agent } });
    }
    await stopped(first.child, "carol/billing");
    const lines = await eventually("the tree settled", () => {
      const shown = bob.shown(first.root)?.tree ?? [];
      return shown.every((line) => line.state !== "working" && line.state !== "waiting") && shown;
    });
    assert.deepEqual(
      lines.map(({ agent, depth, state, mode }) => [agent, depth, state, mode]),
      [
        ["jacob/uploader", 0, "stopped", "full"],
        ["carol/billing", 1, "stopped", "full"],
        ["bob/client", 1, "withdrawn", null]
      ]
    );

    // Bob takes back the root while jacob's agent works on it, let ask others: that ends all of it. One not let ask others he cannot take back once it runs.
    const second = await tree();
    await bob.session.handle({ do: "withdraw", id: second.root, owner: "jacob", repo: "uploader" });
    await stopped(second.root, "jacob/uploader");
    await stopped(second.child, "carol/billing");
    const { id: plain } = (await bob.client.publish("#team", "message", { text: "@jacob/uploader slow, alone", via: "cli" })).event;
    await run(jacob, plain, "uploader", false);
    await eventually("bob sees it working", () => bob.shown(plain)?.requests[0]?.status.kind === "working");
    await assert.rejects(
      bob.session.handle({ do: "withdraw", id: plain, owner: "jacob", repo: "uploader" }),
      /only a request of yours that is still waiting, or that an agent let ask others is working on/
    );
    await jacob.session.handle({ do: "stop", id: plain, repo: "uploader" });

    // Carol's desk stops what it was asked once the log says what asked it has ended, though nobody took hers back: as if jacob's desk had gone.
    const third = await tree();
    await jacob.client.publish("#team", "job.cancelled", { repo: "uploader" }, [third.root]);
    await stopped(third.child, "carol/billing");
    assert.ok(!(await bob.client.events({ chat: "#team" })).some(({ event }) => event.refs[0] === third.child && event.kind === "job.withdrawn"));
    await jacob.session.handle({ do: "stop", id: third.root, repo: "uploader" });

    // And once the agent that asked takes it back, though what asked it goes on.
    const fourth = await tree();
    await uploader.publish("#team", "job.withdrawn", { agent: "carol/billing" }, [fourth.child]);
    await stopped(fourth.child, "carol/billing");
    assert.equal(jacob.session.view().busy.working, 1);
    await jacob.session.handle({ do: "stop", id: fourth.root, repo: "uploader" });
  }
);
