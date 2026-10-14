/** The parts of the client that have logic of their own: the fold of a chat's events and the rules that keep it honest, the tag list, an event's envelope and what each kind says, reading what the hub answers, a hub on another protocol, splitting the agent command, and running it. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { candidates, ChatLog, continues, rings, STALE } from "../src/core/chat.ts";
import type { Entry, Message } from "../src/core/chat.ts";
import { runAgent, splitCommand } from "../src/desk/agents/oneshot.ts";
import { AgentCancelledError, Client, PlayerTwoError } from "../src/desk/client.ts";
import type { Transport } from "../src/desk/client.ts";
import { readContent } from "../src/core/kinds.ts";
import { loadKey, publicHex, signEvent, signNote } from "../src/core/sign.ts";
import * as repos from "../src/desk/repos.ts";
import { Session } from "../src/desk/session.ts";
import { eventSchema, fitText, MAX_CONTENT, MAX_PATCH, PROTOCOL } from "../src/core/wire.ts";
import type { Delivered, TeamRepo } from "../src/core/wire.ts";
import { startHub } from "./startHub.ts";

const NOW = 1_800_000_000;
const key = loadKey("11".repeat(32));

let lastSeq = 0;

/** An event as the hub would deliver it, the next in its log. Content is given as the object it is the JSON text of, or as text that is not JSON. */
function entry(author: string, to: string, kind: string, content: unknown, more: { readonly refs?: readonly string[]; readonly ts?: number; readonly trusted?: boolean } = {}): Entry {
  lastSeq += 1;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { seq: lastSeq, event: signEvent(key, { author, to, kind, content: text, ts: more.ts ?? NOW, refs: more.refs ?? [] }), trusted: more.trusted ?? true };
}

function say(author: string, to: string, text: string, refs: readonly string[] = []): Entry {
  return entry(author, to, "message", { text, via: "window" }, { refs });
}

const ACCEPTED = { branch: "main", commit: "a".repeat(40), dirty: true, delivery: "review", mode: "full", by: "owner" };

/** A log of these events, as `me` sees them. */
function logOf(me: string, entries: readonly Entry[]): ChatLog {
  const log = new ChatLog(me);
  log.add(entries);
  return log;
}

/** Where each agent a message tags stands, as owner/repo and state. */
function states(log: ChatLog, ask: Entry, now = NOW): string[] {
  const message = log.message(ask.event.id);
  return message === null ? [] : log.requests(message, now).map((request) => `${request.owner}/${request.repo} ${request.state}`);
}

/** What a chat shows, each thing as a line of text, replies indented under their root. */
function shown(log: ChatLog, chat: string): string[] {
  const lines = (message: Message, indent: string): string[] => [
    `${indent}${message.entry.event.author}${message.agent === null ? "" : `/${message.agent}`}: ${message.deleted ? "(deleted)" : message.text}${message.edited ? " (edited)" : ""}${[...message.reactions].map(([emoji, who]) => ` ${emoji}${[...who].join("+")}`).join("")}`,
    ...message.replies.flatMap((reply) => lines(reply, `${indent}  `))
  ];
  return log.items(chat).flatMap((item) => {
    switch (item.kind) {
      case "message":
        return lines(item.message, "");
      case "line":
        return [`${item.entry.event.author} ${item.did}${item.repo === "" ? "" : ` ${item.repo}`}`];
      case "untrusted":
        return [`! ${item.entry.event.author}`];
    }
  });
}

function repo(user: string, name: string): TeamRepo {
  return { user, name, key: `dev.azure.com/acme/platform/${name}`, url: `https://dev.azure.com/acme/Platform/_git/${name}`, branch: "main" };
}

await test("a tagged agent's state follows its owner's job events, and one working for longer than any run takes is waiting again", () => {
  const ask = say("bob", "jacob", "@jacob/uploader where do we retry?");
  const job = (kind: string, content: object = {}, ts = NOW): Entry => entry("jacob", "bob", kind, { repo: "uploader", ...content }, { refs: [ask.event.id], ts });
  const stateAfter = (...later: Entry[]): string[] => states(logOf("jacob", [ask, ...later]), ask);
  const answer = { branch: "main", text: "in queue.py", reviewed: true };

  assert.deepEqual(stateAfter(), ["jacob/uploader waiting"]);
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED)), ["jacob/uploader working"]);
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED, NOW - STALE - 1)), ["jacob/uploader waiting"]); // Accepted too long ago to believe.
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED), job("job.result", answer)), ["jacob/uploader answered"]);
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED), job("job.error")), ["jacob/uploader failed"]);
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED), job("job.cancelled")), ["jacob/uploader stopped"]);
  assert.deepEqual(stateAfter(job("job.declined", { reason: "" })), ["jacob/uploader declined"]);
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED), job("job.declined", { reason: "" })), ["jacob/uploader declined"]); // A draft thrown away.
  assert.deepEqual(stateAfter(job("job.declined", { reason: "" }), job("job.accepted", ACCEPTED)), ["jacob/uploader working"]); // Run after all.
  assert.deepEqual(stateAfter(job("job.result", answer)), ["jacob/uploader waiting"]); // An answer to a run nobody accepted moves nothing,
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED), job("job.result", answer), job("job.accepted", ACCEPTED), job("job.error")), ["jacob/uploader answered"]); // and nothing moves one answered.

  const log = logOf("jacob", [ask, job("job.accepted", ACCEPTED)]);
  const message = log.message(ask.event.id);
  assert.ok(message !== null);
  assert.deepEqual(log.requests(message, NOW)[0]?.accepted, { repo: "uploader", ...ACCEPTED });
  assert.deepEqual(
    log.waitingForMe("bob", NOW - STALE).map((request) => request.repo),
    []
  );
  assert.deepEqual(
    logOf("jacob", [ask])
      .waitingForMe("bob", NOW)
      .map((request) => request.repo),
    ["uploader"]
  );
});

await test("an edit or a delete counts only from the message's author, and never on an agent's answer", () => {
  const hello = say("bob", "jacob", "hello");
  const about = { refs: [hello.event.id] };
  const ask = say("bob", "jacob", "@jacob/uploader where?");
  const answer = entry("jacob", "bob", "job.result", { repo: "uploader", branch: "main", text: "here", reviewed: true }, { refs: [ask.event.id] });
  const log = logOf("jacob", [
    hello,
    entry("jacob", "bob", "message.edit", { text: "forged by jacob" }, about),
    entry("bob", "jacob", "message.edit", { text: "hello again" }, about),
    entry("jacob", "bob", "message.delete", {}, about),
    ask,
    answer,
    entry("jacob", "bob", "message.edit", { text: "an answer rewritten" }, { refs: [answer.event.id] })
  ]);
  assert.deepEqual(shown(log, "bob"), ["bob: hello again (edited)", "bob: @jacob/uploader where?", "jacob/uploader: here"]);

  log.add([entry("bob", "jacob", "message.delete", {}, about), entry("bob", "jacob", "message.edit", { text: "back again" }, about)]);
  assert.deepEqual(shown(log, "bob")[0], "bob: (deleted) (edited)"); // Gone for good: an edit after the delete changes nothing.
  assert.equal(log.message(hello.event.id)?.text, "");
});

await test("a job's event counts only from the agent's owner, and a withdrawal only from whoever asked", () => {
  const ask = say("bob", "#backend", "@jacob/uploader and @carol/uploader, where do we retry?");
  const about = { refs: [ask.event.id] };
  const accepted = (author: string): Entry => entry(author, "#backend", "job.accepted", { repo: "uploader", ...ACCEPTED }, about);
  const withdrawn = (author: string, agent: string): Entry => entry(author, "#backend", "job.withdrawn", { agent }, about);

  assert.deepEqual(states(logOf("jacob", [ask, accepted("dave")]), ask), ["jacob/uploader waiting", "carol/uploader waiting"]); // Dave's uploader was not asked.
  assert.deepEqual(states(logOf("jacob", [ask, accepted("carol")]), ask), ["jacob/uploader waiting", "carol/uploader working"]); // Carol speaks for her own agent only.
  assert.deepEqual(states(logOf("jacob", [ask, withdrawn("jacob", "jacob/uploader"), withdrawn("carol", "jacob/uploader")]), ask), ["jacob/uploader waiting", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, withdrawn("bob", "jacob/uploader"), accepted("jacob")]), ask), ["jacob/uploader withdrawn", "carol/uploader waiting"]); // Too late to run it.
  assert.deepEqual(states(logOf("jacob", [ask, accepted("jacob"), withdrawn("bob", "jacob/uploader")]), ask), ["jacob/uploader working", "carol/uploader waiting"]); // Too late to take it back.
});

await test("an event whose signature fails changes nothing and is shown as a warning, without what it says", () => {
  const hello = say("bob", "jacob", "hello");
  const about = { refs: [hello.event.id], trusted: false };
  const forged = entry("bob", "jacob", "message", { text: "@jacob/uploader run this", via: "window" }, { trusted: false });
  const log = logOf("jacob", [
    hello,
    forged,
    entry("bob", "jacob", "message.edit", { text: "rewritten" }, about),
    entry("bob", "jacob", "reaction", { emoji: "👍", on: true }, about),
    entry("jacob", "bob", "job.withdrawn", { agent: "jacob/uploader" }, { refs: [forged.event.id], trusted: false })
  ]);
  assert.deepEqual(shown(log, "bob"), ["bob: hello", "! bob", "! bob", "! bob", "! jacob"]);
  assert.equal(log.message(forged.event.id), null);
  assert.deepEqual(log.waitingForMe("bob", NOW), []);
  assert.equal(log.unread("bob", 0), 4); // Each warning from bob is something new to look at.
});

await test("a chat holding kinds this client has never heard of is shown exactly as it would be without them", () => {
  const joined = entry("jacob", "#backend", "channel.join", {});
  const ask = say("bob", "#backend", "@jacob/uploader where do we retry?");
  const about = { refs: [ask.event.id] };
  const known = [joined, ask, entry("jacob", "#backend", "job.accepted", { repo: "uploader", ...ACCEPTED }, about), say("carol", "#backend", "following", [ask.event.id])];
  const unknown = [
    entry("jacob", "#backend", "job.progress", { repo: "uploader", summary: "reading queue.py" }, about), // Phase 3's.
    entry("bob", "#backend", "some.later.kind", "not even JSON", about),
    entry("bob", "#backend", "message", { text: "@jacob/uploader", via: "telepathy" }) // A kind it knows, holding what it does not.
  ];
  const mixed = logOf(
    "jacob",
    [known[0], unknown[0], known[1], unknown[1], known[2], unknown[2], known[3]].filter((each) => each !== undefined)
  );
  const plain = logOf("jacob", known);

  assert.deepEqual(shown(mixed, "#backend"), shown(plain, "#backend"));
  assert.deepEqual(shown(plain, "#backend"), ["jacob joined", "bob: @jacob/uploader where do we retry?", "  carol: following"]);
  assert.deepEqual(states(mixed, ask), ["jacob/uploader working"]);
  assert.equal(mixed.unread("#backend", 0), plain.unread("#backend", 0));
});

await test("a tag counts only in a message, as it was sent: not in an agent's answer and not in an edit", () => {
  const ask = say("bob", "jacob", "@jacob/uploader where?");
  const inThread = say("bob", "jacob", "and @jacob/theme?", [ask.event.id]);
  const answer = entry("jacob", "bob", "job.result", { repo: "uploader", branch: "main", text: "ask @jacob/billing", reviewed: false }, { refs: [ask.event.id] });
  const edit = entry("bob", "jacob", "message.edit", { text: "@jacob/uploader and @jacob/billing where?" }, { refs: [ask.event.id] });
  const log = logOf("jacob", [ask, inThread, answer, edit]);

  assert.deepEqual(states(log, ask), ["jacob/uploader waiting"]);
  assert.deepEqual(states(log, inThread), ["jacob/theme waiting"]); // Tags work in a reply.
  assert.deepEqual(states(log, answer), []);
  assert.deepEqual(
    log.waitingForMe("bob", NOW).map((request) => request.repo),
    ["uploader", "theme"]
  );
});

await test("replies sit under their thread's root, an answer follows its request, reactions are counted per person, and an older page loaded later lands in its place", () => {
  const pinned = entry("bob", "#backend", "channel.pin", {
    repo: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" },
    branch: null
  });
  const root = say("bob", "#backend", "@jacob/uploader deploy?");
  const reply = say("carol", "#backend", "@jacob/uploader too", [root.event.id]);
  const all = [
    pinned,
    root,
    reply,
    say("bob", "#backend", "a reply to a reply goes under the root", [reply.event.id]),
    entry("jacob", "#backend", "job.result", { repo: "uploader", branch: "main", text: "deployed", reviewed: true }, { refs: [root.event.id] }),
    entry("jacob", "#backend", "job.result", { repo: "uploader", branch: "main", text: "you too", reviewed: true }, { refs: [reply.event.id] }),
    entry("bob", "#backend", "reaction", { emoji: "🎉", on: true }, { refs: [root.event.id] }),
    entry("carol", "#backend", "reaction", { emoji: "🎉", on: true }, { refs: [root.event.id] }),
    entry("bob", "#backend", "reaction", { emoji: "🎉", on: false }, { refs: [root.event.id] }),
    entry("carol", "#backend", "channel.pin", { repo: null, branch: null }),
    entry("carol", "#backend", "channel.leave", {})
  ];
  const log = logOf("jacob", all.slice(5));
  log.add(all.slice(0, 5)); // The older page, loaded after the newer one.

  assert.deepEqual(shown(log, "#backend"), [
    "bob pinned uploader",
    "bob: @jacob/uploader deploy? 🎉carol",
    "  carol: @jacob/uploader too",
    "  bob: a reply to a reply goes under the root",
    "  jacob/uploader: you too",
    "jacob/uploader: deployed",
    "carol unpinned",
    "carol left"
  ]);
  assert.deepEqual(shown(log, "#backend"), shown(logOf("jacob", all), "#backend"));
  assert.deepEqual(log.bounds("#backend"), { oldest: all[0]?.seq, newest: all.at(-1)?.seq });
});

await test("a message rings when it is sent to the user or tags their agent in a channel, and one soon after from the same person sits under the same header", () => {
  const first = say("bob", "#backend", "hello");
  const log = logOf("jacob", [first, say("bob", "#backend", "and again"), say("bob", "#backend", "much later")]);
  const [a, b, c] = log.items("#backend").flatMap((item) => (item.kind === "message" ? [item.message] : []));
  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  assert.deepEqual([continues(null, a), continues(a, b)], [false, true]);
  assert.ok(!continues(b, { ...c, entry: entry("bob", "#backend", "message", { text: "much later", via: "window" }, { ts: NOW + 301 }) }));
  assert.deepEqual(
    [say("bob", "jacob", "hi"), first, say("bob", "#backend", "@jacob/uploader?"), say("jacob", "bob", "hi"), entry("bob", "jacob", "reaction", { emoji: "👍", on: true })].map((each) =>
      rings(each, "jacob")
    ),
    [true, false, true, false, false]
  );
});

await test("the tag list leads with the pinned repo, then my agents, then my partner's, and offers a clone once a repo is named", () => {
  const team = [repo("bob", "uploader"), repo("carol", "billing"), repo("jacob", "uploader"), repo("jacob", "theme"), repo("bob", "theme")];
  const tags = (query: string, pinned: string | null, partner: string | null): string[] =>
    candidates(query, team, "jacob", pinned, partner).rows.map((pick) => `${pick.clone ? "clone " : ""}${pick.owner}/${pick.repo}`);
  assert.deepEqual(tags("", null, "bob"), ["jacob/theme", "jacob/uploader", "bob/theme", "bob/uploader", "carol/billing"]);
  assert.deepEqual(tags("", "uploader", null), ["jacob/uploader", "bob/uploader", "jacob/theme", "bob/theme", "carol/billing"]);
  assert.deepEqual(tags("bill", null, null), ["carol/billing", "clone jacob/billing"]);
  assert.deepEqual(candidates("", team, "jacob", null, null, 2).more, 3);
});

/** A client whose hub is a table of answers, by method and path. Nothing is sent anywhere; what was asked is added to `asked`. */
function clientOf(answers: Readonly<Record<string, unknown>>, asked: string[] = []): Client {
  const transport: Transport = (method, url) => {
    asked.push(`${method} ${new URL(url).pathname}`);
    return Promise.resolve(JSON.stringify(answers[asked.at(-1) ?? ""]));
  };
  return new Client("/nowhere", { hub: "http://hub.test", name: "jacob", agent: "fake-agent" }, key, transport, () => NOW);
}

await test("the client reads past a field a newer hub adds, but refuses one inside a signed note", async () => {
  const note = signNote(key, { sender: "bob", to: "jacob", kind: "note", body: "hello", ts: NOW, agent: null, re: null });
  const info = { version: "9.0.0", protocol: 1, repos: "dev.azure.com/acme", now: NOW };
  const bob = { name: "bob", pubkey: publicHex(key), seen: NOW };
  const backend = { name: "#backend", members: ["bob"], repo: null, branch: null };
  const uploader = { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" };
  const pinned = { name: "#uploads", members: ["bob"], repo: uploader, branch: null };
  const client = clientOf({
    "GET /info": { ...info, hubKey: "new" },
    "GET /users": [{ ...bob, role: "new" }],
    "GET /repos": [{ ...repo("bob", "uploader"), commit: "new" }],
    "GET /channels": [
      { ...backend, topic: "new" },
      { ...pinned, repo: { ...uploader, commit: "new" } }
    ],
    "POST /notes": { id: 7, seq: 7 },
    "GET /notes": [{ id: 7, note, seq: 7 }]
  });

  assert.deepEqual(await client.info(), info);
  assert.deepEqual(await client.users(), [bob]);
  assert.deepEqual(await client.repos(), [repo("bob", "uploader")]);
  assert.deepEqual(await client.channels(), [backend, pinned]);
  assert.equal(await client.send("bob", "hello"), 7);
  assert.deepEqual(await client.notes(), [{ id: 7, note }]);
  await assert.rejects(clientOf({ "GET /notes": [{ id: 7, note: { ...note, via: "new" } }] }).notes(), /Unrecognized key/);
});

await test("the client posts an event whose id it knows at once, reads a chat back newest first, catches up past a page, and follows the stream across a drop", { timeout: 20_000 }, async (t) => {
  const hub = await startHub(t);
  const alice = await hub.join("alice");
  const bob = await hub.join("bob");
  const text = (delivered: Delivered): string => {
    const said = readContent(delivered.event);
    return said.kind === "message" ? said.content.text : delivered.event.kind;
  };

  const hello = await alice.publish("bob", "message", { text: "hello", via: "cli" });
  const reply = await bob.publish("alice", "message", { text: "hi", via: "cli" }, [hello.event.id]);
  assert.deepEqual([hello.seq, hello.event.author, reply.event.refs], [1, "alice", [hello.event.id]]);
  assert.deepEqual(await bob.events({ chat: "alice" }), [reply, hello]);
  assert.deepEqual(await bob.events({ chat: "alice", before: reply.seq, limit: 1 }), [hello]);
  await assert.rejects(alice.publish("bob", "message", { text: "", via: "cli" }), z.ZodError); // Nothing is signed that its kind does not hold.

  for (let count = 0; count < 200; count += 1) {
    await alice.publish("bob", "reaction", { emoji: "👍", on: count % 2 === 0 }, [hello.event.id]);
  }
  const caught = await bob.catchUp(1);
  assert.deepEqual([caught.length, caught[0]?.seq, caught.at(-1)?.seq], [201, 2, 202]);

  // The stream sends what is there, and once the hub has cut it, it opens again from the last seq it handed over: what was sent in between arrives, and nothing twice.
  const heard: Delivered[] = [];
  const stop = new AbortController();
  const following = bob.stream(
    200,
    (batch) => {
      heard.push(...batch);
      return Promise.resolve();
    },
    stop.signal
  );
  const until = async (count: number): Promise<void> => {
    for (let tries = 0; heard.length < count && tries < 200; tries += 1) {
      await delay(25);
    }
  };
  await until(2);
  hub.drop();
  await delay(50);
  const late = await alice.publish("bob", "message", { text: "while you were away", via: "cli" });
  await until(3);
  stop.abort();
  await following;
  assert.deepEqual(
    heard.map((each) => each.seq),
    [201, 202, late.seq]
  );
  assert.equal(text(heard[2] ?? late), "while you were away");
});

await test("an event is trusted when it holds under the key first seen for its author, and not once a byte of it changes or the hub swaps the key", async (t) => {
  const hub = await startHub(t);
  const alice = await hub.join("alice");
  const bob = await hub.join("bob");
  const { event } = await alice.publish("bob", "message", { text: "hello", via: "cli" });

  assert.ok(await bob.isTrusted(event));
  assert.ok(!(await bob.isTrusted({ ...event, content: JSON.stringify({ text: "hullo", via: "cli" }) })));
  writeFileSync(join(hub.dir, "bob", "known.json"), JSON.stringify({ alice: publicHex(key) })); // Bob first saw alice under another key: what the hub says now does not count.
  assert.ok(!(await bob.isTrusted(event)));
});

await test("a hub on another protocol is not followed: the session says which side to update, and asks again only once a minute", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  const cases: readonly (readonly [number, string])[] = [
    [PROTOCOL + 1, "app"],
    [PROTOCOL - 1, "hub"]
  ];
  for (const [protocol, side] of cases) {
    const asked: string[] = [];
    const client = clientOf({ "GET /info": { version: "9.0.0", protocol, repos: "dev.azure.com/acme", now: NOW } }, asked);
    const session = new Session(client, "/nowhere", { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) });

    session.start();
    await settle();
    assert.deepEqual(session.view().link, { state: "down", problem: `the hub speaks protocol ${String(protocol)} and this app speaks protocol ${String(PROTOCOL)}: update the ${side}` });
    t.mock.timers.tick(59_000);
    await settle();
    assert.deepEqual(asked, ["GET /info"]);
    t.mock.timers.tick(1_000);
    await settle();
    assert.deepEqual(asked, ["GET /info", "GET /info"]);
    await session.stop();
  }
});

await test("an agent command is split the way a shell would split it", () => {
  assert.deepEqual(splitCommand("claude -p"), ["claude", "-p"]);
  assert.deepEqual(splitCommand(`  sh -c 'echo "a b"' "x \\" y" z\\ w '' --flag="two words"  `), ["sh", "-c", 'echo "a b"', 'x " y', "z w", "", "--flag=two words"]);
  assert.throws(() => splitCommand("claude 'oops"), PlayerTwoError);
  assert.throws(() => splitCommand('claude "oops\\"'), PlayerTwoError);
});

await test("an event's envelope holds exactly the signed fields, a kind of dotted lowercase words, and content up to its kind's limit", () => {
  const event = { id: "ab".repeat(32), author: "bob", to: "#backend", kind: "message", content: "{}", ts: NOW, refs: ["cd".repeat(32)], nonce: "ef".repeat(8), sig: "01".repeat(64) };
  const fits = (changed: Readonly<Record<string, unknown>>): boolean => eventSchema.safeParse({ ...event, ...changed }).success;

  assert.ok(fits({}));
  assert.ok(fits({ to: "*", kind: "job.accepted" }));
  assert.ok(fits({ kind: "a1.b2.c", refs: Array.from({ length: 8 }, () => event.refs[0]) }));
  assert.ok(fits({ content: "🎉".repeat(MAX_CONTENT) })); // Counted by character, not by UTF-16 unit.
  assert.ok(fits({ kind: "patch", content: "x".repeat(MAX_PATCH) }));
  assert.ok(!fits({ via: "window" })); // A field nobody signed.
  assert.ok(!fits({ kind: "Message" }));
  assert.ok(!fits({ kind: "job..accepted" }));
  assert.ok(!fits({ kind: `a${"b".repeat(64)}` }));
  assert.ok(!fits({ to: "#*" }));
  assert.ok(!fits({ refs: Array.from({ length: 9 }, () => event.refs[0]) }));
  assert.ok(!fits({ nonce: "ef" }));
  assert.ok(!fits({ content: "x".repeat(MAX_CONTENT + 1) }));
  assert.ok(!fits({ kind: "patch", content: "x".repeat(MAX_PATCH + 1) }));
});

await test("each kind's content is read by its kind, and anything else is unknown", () => {
  const read = (kind: string, content: unknown): string => {
    const found = readContent(signEvent(key, { author: "jacob", to: "bob", kind, content: typeof content === "string" ? content : JSON.stringify(content), ts: NOW, refs: [] }));
    return found.kind === "unknown" ? "unknown" : `${found.kind} ${JSON.stringify(found.content)}`;
  };
  const accepted = { repo: "uploader", branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: "full", by: "owner" };
  const known: readonly (readonly [string, unknown])[] = [
    ["message", { text: "hi @bob/uploader", via: "window" }],
    ["message.edit", { text: "hello" }],
    ["message.delete", {}],
    ["reaction", { emoji: "👍", on: false }],
    ["channel.join", {}],
    ["channel.leave", {}],
    ["channel.pin", { repo: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" }, branch: null }],
    ["channel.pin", { repo: null, branch: null }],
    ["job.accepted", accepted],
    ["job.declined", { repo: "uploader", reason: "" }],
    ["job.result", { repo: "uploader", branch: "main", text: "in queue.py", reviewed: true }],
    ["job.error", { repo: "uploader" }],
    ["job.cancelled", { repo: "uploader" }],
    ["job.withdrawn", { agent: "jacob/uploader" }]
  ];

  for (const [kind, content] of known) {
    assert.equal(read(kind, content), `${kind} ${JSON.stringify(content)}`);
  }
  assert.equal(read("message", { text: "hi", via: "window", lang: "en" }), `message ${JSON.stringify({ text: "hi", via: "window" })}`); // A field a later version adds is passed over.
  assert.equal(read("job.accepted", { ...accepted, commit: "a".repeat(64) }), `job.accepted ${JSON.stringify({ ...accepted, commit: "a".repeat(64) })}`);
  assert.equal(read("workflow.run", { workflow: "deploy" }), "unknown"); // A kind from a later phase.
  assert.equal(read("message", { text: "", via: "window" }), "unknown");
  assert.equal(read("message", { text: "hi", via: "email" }), "unknown");
  assert.equal(read("message", "not JSON"), "unknown");
  assert.equal(read("message", [{ text: "hi", via: "window" }]), "unknown");
  assert.equal(read("job.accepted", { ...accepted, mode: "supervised" }), "unknown"); // Not until phase 3.
  assert.equal(read("channel.pin", { repo: null, branch: "main" }), "unknown"); // Not until phase 6.
  assert.equal(read("job.withdrawn", { agent: "uploader" }), "unknown");
});

await test("a text is cut so the event carrying it fits what the hub accepts, however much writing it as JSON adds, without splitting a character", () => {
  for (const text of ["🎉".repeat(MAX_CONTENT), "\n".repeat(MAX_CONTENT), "\x01".repeat(MAX_CONTENT), `${"x".repeat(MAX_CONTENT - 1)}🎉`]) {
    const fitted = fitText(text);
    const content = JSON.stringify({ repo: "a".repeat(64), branch: '"'.repeat(200), text: fitted, reviewed: false });
    assert.ok(text.startsWith(fitted) && fitted.isWellFormed() && fitted.length > MAX_CONTENT / 7, JSON.stringify(text.slice(0, 2)));
    assert.ok(eventSchema.safeParse(signEvent(key, { author: "jacob", to: "bob", kind: "job.result", content, ts: NOW, refs: [] })).success);
  }
  assert.equal(fitText("plain"), "plain");
});

await test("a checkout's head is its branch, the commit it is at and whether anything is uncommitted, and one with no commit cannot be described", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "player-two-head-"));
  t.after(() => {
    rmSync(path, { recursive: true, force: true });
  });
  const checkout = { remote: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" }, path, branch: "main" };
  const git = (...args: string[]): Promise<unknown> => repos.git(["-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], 20);
  await git("init", "-q", "-b", "main");
  await assert.rejects(repos.describe(checkout), /git cannot say which commit/);
  await git("commit", "-q", "--allow-empty", "-m", "first");
  const head = await repos.describe(checkout);
  assert.deepEqual([head.branch, /^[0-9a-f]{40}$/.test(head.commit), head.dirty], ["main", true, false]);
  writeFileSync(join(path, "new.txt"), "changed");
  assert.deepEqual(await repos.describe(checkout), { ...head, dirty: true });
});

await test("running an agent returns what it printed, reports a failure, and stops when cancelled", async () => {
  const never = new AbortController().signal;
  assert.equal(await runAgent(["sh", "-c", "printf ' hello\n'"], process.cwd(), never), "hello");
  await assert.rejects(runAgent(["sh", "-c", "echo oops >&2; exit 3"], process.cwd(), never), /status 3: oops/);
  await assert.rejects(runAgent(["no-such-agent-command"], process.cwd(), never), /could not start the agent command/);
  const cancel = new AbortController();
  const started = Date.now();
  const run = runAgent(["sh", "-c", "sleep 30 & wait"], process.cwd(), cancel.signal);
  setTimeout(() => {
    cancel.abort();
  }, 100);
  await assert.rejects(run, AgentCancelledError);
  assert.ok(Date.now() - started < 5000);
});
