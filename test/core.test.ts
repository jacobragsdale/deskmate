/** The parts of the client that have logic of their own: the fold of a chat's events and the rules that keep it honest, the tag list, links to notes, an event's envelope and what each kind says, reading what the hub answers, a hub on another protocol, splitting the agent command, and running it. */

import assert from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { candidates, ChatLog, chatOf, continues, rings, STALE } from "../src/core/chat.ts";
import type { Entry, Message } from "../src/core/chat.ts";
import type { Node } from "../src/core/delegation.ts";
import { oneshotRunner, runAgent, splitCommand } from "../src/desk/agents/oneshot.ts";
import { DEFAULT_PRESET, oneshotAgent } from "../src/desk/agents/presets.ts";
import { AgentCancelledError, Client, PlayerTwoError, readConfig } from "../src/desk/client.ts";
import type { Runner, Transport } from "../src/desk/client.ts";
import type { RunHandlers } from "../src/desk/agents/runner.ts";
import { readContent } from "../src/core/kinds.ts";
import { noteIn, noteLink, noteOf, notesIn } from "../src/core/links.ts";
import { roomName, suggestions } from "../src/core/rooms.ts";
import type { Room } from "../src/core/rooms.ts";
import { loadKey, publicHex, signEvent } from "../src/core/sign.ts";
import * as repos from "../src/desk/repos.ts";
import { Session } from "../src/desk/session.ts";
import { branchNameSchema, channelSchema, commandLineOf, eventSchema, fitText, MAX_CONTENT, MAX_PATCH, MODES, PROTOCOL } from "../src/core/wire.ts";
import { atMost, decide } from "../src/desk/permissions.ts";
import type { Action, Decision } from "../src/desk/permissions.ts";
import type { ChannelInfo, Delivered, TeamRepo } from "../src/core/wire.ts";
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
  const again = logOf("jacob", [ask, job("job.accepted", ACCEPTED, NOW - STALE - 1), job("job.accepted", { ...ACCEPTED, commit: "b".repeat(40) })]); // A run that never ended, as when its desk went, run again at another commit.
  assert.deepEqual(
    again.requests(again.message(ask.event.id) ?? assert.fail("no request"), NOW).map((request) => [request.state, request.accepted?.commit]),
    [["working", "b".repeat(40)]]
  );
  assert.deepEqual(stateAfter(job("job.result", answer)), ["jacob/uploader waiting"]); // An answer to a run nobody accepted moves nothing,
  assert.deepEqual(stateAfter(job("job.accepted", ACCEPTED), job("job.result", answer), job("job.accepted", ACCEPTED), job("job.error")), ["jacob/uploader answered"]); // and nothing moves one answered.

  const log = logOf("jacob", [ask, job("job.accepted", ACCEPTED)]);
  const message = log.message(ask.event.id);
  assert.ok(message !== null);
  assert.deepEqual(log.requests(message, NOW)[0]?.accepted, { repo: "uploader", ...ACCEPTED, delegate: false }); // Not let ask other agents, as no acceptance from before phase 5 says.

  // What its owner's desk says it is doing counts while it works, from its owner, and a run accepted again starts with nothing said.
  const doing = (summary: string, author = "jacob"): Entry => entry(author, author === "jacob" ? "bob" : "jacob", "job.progress", { repo: "uploader", summary }, { refs: [ask.event.id] });
  const summaryAfter = (...later: Entry[]): string[] => {
    const folded = logOf("jacob", [ask, ...later]);
    return folded.requests(folded.message(ask.event.id) ?? assert.fail("no request"), NOW).map((request) => request.summary);
  };
  assert.deepEqual(summaryAfter(job("job.accepted", ACCEPTED), doing("reading"), doing("editing files")), ["editing files"]);
  assert.deepEqual(summaryAfter(doing("reading")), [""]); // Not working yet.
  assert.deepEqual(summaryAfter(job("job.accepted", ACCEPTED), doing("reading", "bob")), [""]); // Only its owner speaks for it.
  assert.deepEqual(summaryAfter(job("job.accepted", ACCEPTED), doing("reading"), job("job.accepted", ACCEPTED)), [""]);
  assert.deepEqual(summaryAfter(job("job.accepted", ACCEPTED), doing("reading"), doing("editing src/queue.py")), ["reading"]); // Only the fixed words are read.
  assert.deepEqual(summaryAfter(job("job.accepted", ACCEPTED), job("job.result", answer), doing("reading")), [""]);
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
  assert.deepEqual(states(log, ask), ["jacob/uploader waiting"]);
  log.add([entry("bob", "jacob", "message.delete", {}, { refs: [ask.event.id] })]);
  assert.deepEqual(states(log, ask), []); // A deleted request asks nothing of anyone.
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

  // Accepted longer ago than any run takes, it is shown as waiting, and whoever asked may take it back then, counted by the withdrawal's own time. Nobody else may.
  const long = NOW - STALE - 1;
  const acceptedLongAgo = entry("jacob", "#backend", "job.accepted", { repo: "uploader", ...ACCEPTED }, { ...about, ts: long });
  const withdrawnAt = (author: string, ts: number): Entry => entry(author, "#backend", "job.withdrawn", { agent: "jacob/uploader" }, { ...about, ts });
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo]), ask), ["jacob/uploader waiting", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, withdrawnAt("bob", NOW)]), ask), ["jacob/uploader withdrawn", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, withdrawnAt("bob", long + STALE)]), ask, long + STALE), ["jacob/uploader working", "carol/uploader waiting"]); // Still believed then.
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, withdrawnAt("carol", NOW)]), ask), ["jacob/uploader waiting", "carol/uploader waiting"]);

  // Half a second past STALE is not past it yet: a withdrawal made then is signed in whole seconds, at exactly STALE, which the fold does not count. So Withdraw is not offered until it would count.
  const since = acceptedLongAgo.event.ts;
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo]), ask, since + STALE + 0.5), ["jacob/uploader working", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, withdrawnAt("bob", Math.floor(since + STALE + 0.5))]), ask, since + STALE + 1), ["jacob/uploader waiting", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo]), ask, since + STALE + 1), ["jacob/uploader waiting", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, withdrawnAt("bob", since + STALE + 1)]), ask, since + STALE + 1), ["jacob/uploader withdrawn", "carol/uploader waiting"]);

  // Word from its owner of what it is doing, as while it waits on the owner's answer for longer than STALE, says it goes on: it is believed for STALE seconds from that word, and a withdrawal judged by it.
  const doing = (author: string, ts: number): Entry => entry(author, "#backend", "job.progress", { repo: "uploader", summary: "waiting for approval" }, { ...about, ts });
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, doing("jacob", NOW - 10)]), ask), ["jacob/uploader working", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, doing("jacob", NOW - 10), withdrawnAt("bob", NOW)]), ask), ["jacob/uploader working", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, doing("jacob", NOW - 10)]), ask, NOW - 10 + STALE + 1), ["jacob/uploader waiting", "carol/uploader waiting"]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, doing("jacob", NOW - 10), withdrawnAt("bob", NOW - 10 + STALE + 1)]), ask, NOW - 10 + STALE + 1), [
    "jacob/uploader withdrawn",
    "carol/uploader waiting"
  ]);
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, doing("carol", NOW - 10)]), ask), ["jacob/uploader waiting", "carol/uploader waiting"]); // Only its owner speaks for it.
  assert.deepEqual(states(logOf("jacob", [ask, acceptedLongAgo, doing("jacob", long - 10)]), ask, long + STALE), ["jacob/uploader working", "carol/uploader waiting"]); // Never back in time.
});

await test("of an agent's say about patches only its own repo's patch counts: one about another repo, a review and a patch.applied from it count for nothing, and a person's do", () => {
  const ask = say("bob", "jacob", "@jacob/uploader shout the notes");
  const about = (target: Entry): { readonly refs: readonly string[] } => ({ refs: [target.event.id] });
  const patch = (author: string, name: string): Entry =>
    entry(
      author,
      "bob",
      "patch",
      {
        repo: { name, key: `dev.azure.com/acme/platform/${name}`, url: `https://dev.azure.com/acme/Platform/_git/${name}` },
        base: "a".repeat(40),
        branch: "main",
        title: `${name}, by ${author}`,
        diff: "diff --git a/x b/x\n"
      },
      about(ask)
    );
  const own = patch("jacob/uploader", "uploader");
  const log = logOf("bob", [
    ask,
    entry("jacob", "bob", "job.accepted", { repo: "uploader", ...ACCEPTED }, about(ask)),
    own,
    patch("jacob/uploader", "billing"), // Not its repo.
    entry("jacob/uploader", "bob", "review", { verdict: "approve", text: "my own work is fine" }, about(own)),
    entry("jacob/uploader", "bob", "patch.applied", { branch: "main" }, about(own)),
    entry("bob", "jacob", "review", { verdict: "changes", text: "" }, about(own)),
    entry("bob", "jacob", "patch.applied", { branch: "player-two/12345678" }, about(own))
  ]);
  assert.deepEqual(shown(log, "jacob"), ["bob: @jacob/uploader shout the notes", "jacob/uploader/uploader: uploader, by jacob/uploader"]);
  const shownPatch = log.message(own.event.id)?.patch;
  assert.deepEqual([shownPatch?.reviews, shownPatch?.applied], [[{ who: "bob", verdict: "changes", text: "" }], [{ who: "bob", branch: "player-two/12345678" }]]);
});

await test("a job's event from an agent, owner/repo, counts exactly as one from its owner does, for that repo only, and nothing else from an agent counts at all", () => {
  const ask = say("bob", "jacob", "@jacob/uploader and @jacob/billing, where do we retry?");
  const by = (author: string, kind: string, content: object, about: Entry = ask): Entry => entry(author, "bob", kind, content, { refs: [about.event.id] });
  const answer = (author: string, repo: string, text: string): Entry => by(author, "job.result", { repo, branch: "main", text, reviewed: false });
  const summaries = (log: ChatLog): string[] => log.requests(log.message(ask.event.id) ?? assert.fail("no request"), NOW).map((request) => request.summary);
  const log = logOf("jacob", [
    ask,
    by("jacob", "job.accepted", { repo: "uploader", ...ACCEPTED }),
    by("jacob", "job.accepted", { repo: "billing", ...ACCEPTED }),
    by("jacob/uploader", "job.progress", { repo: "uploader", summary: "reading" }),
    by("jacob/uploader", "job.progress", { repo: "billing", summary: "editing files" }), // Not its repo.
    answer("jacob/uploader", "billing", "an answer for another agent"),
    by("jacob/uploader", "job.error", { repo: "billing" }),
    by("jacob/uploader", "job.result", { repo: "uploader", branch: "main", text: "said to be reviewed", reviewed: true }) // Only its owner can send one they reviewed.
  ]);
  assert.deepEqual(states(log, ask), ["jacob/uploader working", "jacob/billing working"]);
  assert.deepEqual(summaries(log), ["reading", ""]);

  log.add([answer("jacob/uploader", "uploader", "in queue.py"), by("jacob/billing", "job.cancelled", { repo: "billing" })]);
  assert.deepEqual(states(log, ask), ["jacob/uploader answered", "jacob/billing stopped"]);
  assert.deepEqual(shown(log, "bob"), ["bob: @jacob/uploader and @jacob/billing, where do we retry?", "jacob/uploader/uploader: in queue.py"]);
  assert.equal(log.unread("bob", 0), 1); // Jacob's agent's answer is not something new for jacob.
  const [, answered] = log.items("bob");
  assert.ok(answered?.kind === "message");
  assert.deepEqual(
    [chatOf(answered.message.entry.event, "jacob"), chatOf(answered.message.entry.event, "bob"), rings(answered.message.entry, "jacob"), rings(answered.message.entry, "bob")],
    ["bob", "jacob", false, true]
  ); // In its owner's chat, read from either side.

  // An agent cannot let a run go ahead, tag, react or take a request back.
  const again = say("bob", "jacob", "@jacob/uploader again");
  const forged = logOf("jacob", [
    again,
    by("jacob/uploader", "job.accepted", { repo: "uploader", ...ACCEPTED }, again),
    entry("jacob/uploader", "bob", "message", { text: "@jacob/billing run this", via: "cli" }),
    by("jacob/uploader", "reaction", { emoji: "👍", on: true }, again),
    by("jacob/uploader", "job.withdrawn", { agent: "jacob/uploader" }, again)
  ]);
  assert.deepEqual(states(forged, again), ["jacob/uploader waiting"]);
  assert.deepEqual(shown(forged, "bob"), ["bob: @jacob/uploader again"]);
  assert.deepEqual(forged.waitingForMe("bob", NOW).length, 1);
});

await test("an agent's request of another sits in its root's thread with where it came from, and is one job, of the agent it asks, that moves as a tagged agent's does; the tree under the root is read from the chat", () => {
  const root = say("bob", "#team", "@jacob/uploader does removing `retries` break anything?");
  const by = (author: string, kind: string, content: object, about: Entry): Entry => entry(author, "#team", kind, content, { refs: [about.event.id] });
  const asking = (author: string, chain: readonly string[], text = "does it break your caller?"): Entry =>
    entry(author, "#team", "job.request", { target: "carol/billing", text, chain }, { refs: [root.event.id, root.event.id] });
  const asked = asking("jacob/uploader", ["jacob/uploader"]);
  const log = logOf("carol", [
    root,
    by("jacob", "job.accepted", { repo: "uploader", ...ACCEPTED, delegate: true }, root),
    asked,
    asking("bob", ["jacob/uploader"], "from bob himself"), // Only an agent asks another this way.
    asking("jacob/uploader", ["bob/client"], "through another agent") // Its chain does not end with it.
  ]);
  const shape = (nodes: readonly Node[]): string => nodes.map((node) => (node.children.length === 0 ? node.agent : `${node.agent} [${shape(node.children)}]`)).join(", ");

  assert.deepEqual(shown(log, "#team"), ["bob: @jacob/uploader does removing `retries` break anything?", "  jacob/uploader/uploader: does it break your caller?"]);
  assert.deepEqual(log.message(asked.event.id)?.delegation, { root: root.event.id, parent: root.event.id, chain: ["jacob/uploader"], first: "bob", target: "carol/billing" });
  assert.equal(log.message(root.event.id)?.delegation, null);
  assert.deepEqual([states(log, root), states(log, asked)], [["jacob/uploader working"], ["carol/billing waiting"]]);
  assert.equal(log.waitingForMe("#team", NOW).length, 1);
  assert.equal(shape(log.tree(root.event.id)), "jacob/uploader [carol/billing]");
  assert.deepEqual(log.tree(asked.event.id), []); // Only a person's message is a root.

  log.add([by("carol", "job.accepted", { repo: "billing", ...ACCEPTED }, asked), by("carol/billing", "job.result", { repo: "billing", branch: "main", text: "no", reviewed: false }, asked)]);
  assert.deepEqual(states(log, asked), ["carol/billing answered"]);
  assert.deepEqual(shown(log, "#team").at(-1), "  carol/billing/billing: no"); // The answer follows its request, in the thread.
  assert.equal(log.unread("#team", 0), 2); // Bob's message and jacob's agent's request; carol's own agent's answer is not new to her.
  assert.equal(logOf("carol", [asked]).message(asked.event.id)?.delegation?.first, ""); // Its root not loaded: who asked first is not known here.
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

await test("a link to a note names a 64-hex id and nothing else, and is found in text wherever it stands whole", () => {
  const id = "ab".repeat(32);
  const link = noteLink(id);

  assert.equal(link, `player-two://note/${id}`);
  assert.equal(noteOf(link), id);
  for (const other of [`${link}/`, `${link}0`, link.slice(0, -1), link.toUpperCase(), `player-two://note/${"AB".repeat(32)}`, `player-two://chat/${id}`, `https://example.com/${id}`, ` ${link}`, ""]) {
    assert.equal(noteOf(other), null, other);
  }
  assert.deepEqual(notesIn(`see ${link}, and (${link}).`), [
    { text: "see ", note: null },
    { text: link, note: id },
    { text: ", and (", note: null },
    { text: link, note: id },
    { text: ").", note: null }
  ]);
  assert.deepEqual(notesIn(`${link}cafe and ${link.slice(0, -1)} and player-two://note/${"AB".repeat(32)}`), [
    { text: `${link}cafe and ${link.slice(0, -1)} and player-two://note/${"AB".repeat(32)}`, note: null }
  ]);
  assert.deepEqual(notesIn(link), [{ text: link, note: id }]);
  assert.deepEqual(notesIn(""), []);
});

await test("the app takes a note from the arguments it is started or handed with only when one is exactly a note link, whatever else is among them", () => {
  const id = "ab".repeat(32);
  const link = noteLink(id);
  const exe = "C:\\Program Files\\Player Two\\Player Two.exe";
  const shapes: readonly (readonly string[])[] = [
    [exe, link], // Windows, started by the link.
    [exe, "--allow-file-access-from-files", "--original-process-start-time=13371337133713371", link], // Windows, a second copy's arguments as the first is handed them.
    ["/tmp/.mount_PlayerA1b2C3/player-two", "--no-sandbox", link], // Linux, from the AppImage's desktop file.
    ["/usr/lib/electron/electron", "/home/jacob/dev/player-two", link], // Linux, run from its source.
    [exe, "player-two://note/../x", link] // A hostile link is passed over; one beside it that holds is still taken.
  ];
  for (const argv of shapes) {
    assert.equal(noteIn(argv), id, argv.join(" "));
  }
  const hostile = [
    "player-two://note/../x",
    `player-two://note/../${id}`,
    `player-two://note/${id}/..`,
    `player-two://chat/${id}`,
    `player-two://evil.example/${id}`,
    `player-two://note/${id.toUpperCase()}`,
    `PLAYER-TWO://note/${id}`,
    `player-two://note/${id}/more`,
    `player-two://note/${id}/`,
    `player-two://note/${id}?x=1`,
    `player-two://note/${id}#x`,
    `player-two://note/${id.slice(1)}`,
    `player-two://note/${id}0`,
    `${link}" --inspect=9229`,
    `--app=${link}`,
    `player-two:note/${id}`,
    `player-two:///note/${id}`,
    `https://example.com/note/${id}`,
    ""
  ];
  for (const argument of hostile) {
    assert.equal(noteIn([exe, argument]), null, argument);
  }
  assert.equal(noteIn([exe]), null);
  assert.equal(noteIn([]), null);
});

await test("the tag list leads with the agents on a branch room's branch, then the pinned repo, then my agents, then my partner's, and offers a clone once a repo is named", () => {
  const team = [repo("bob", "uploader"), repo("carol", "billing"), repo("jacob", "uploader"), repo("jacob", "theme"), repo("bob", "theme"), { ...repo("carol", "uploader"), branch: "retry" }];
  const tags = (query: string, pinned: { readonly name: string; readonly branch: string | null } | null, partner: string | null): string[] =>
    candidates(query, team, "jacob", pinned, partner).rows.map((pick) => `${pick.clone ? "clone " : ""}${pick.owner}/${pick.repo}`);
  assert.deepEqual(tags("", null, "bob"), ["jacob/theme", "jacob/uploader", "bob/theme", "bob/uploader", "carol/uploader", "carol/billing"]);
  assert.deepEqual(tags("", { name: "uploader", branch: null }, null), ["jacob/uploader", "bob/uploader", "carol/uploader", "jacob/theme", "bob/theme", "carol/billing"]);
  assert.deepEqual(tags("", { name: "uploader", branch: "retry" }, null), ["carol/uploader", "jacob/uploader", "bob/uploader", "jacob/theme", "bob/theme", "carol/billing"]);
  assert.deepEqual(tags("", { name: "theme", branch: "retry" }, null), ["jacob/theme", "bob/theme", "jacob/uploader", "bob/uploader", "carol/uploader", "carol/billing"]); // Nobody is on it.
  assert.deepEqual(tags("bill", null, null), ["carol/billing", "clone jacob/billing"]);
  assert.deepEqual(candidates("", team, "jacob", null, null, 2).more, 4);
});

await test("a room is suggested for each branch I am on, not the repo's default, with the teammates on it too, unless a channel is pinned to it or I dismissed it", () => {
  const on = (user: string, name: string, branch: string): TeamRepo => ({ ...repo(user, name), branch });
  const team = [
    on("bob", "uploader", "feature/retry"),
    on("carol", "uploader", "feature/retry"),
    on("dave", "uploader", "main"),
    on("jacob", "uploader", "feature/retry"),
    on("bob", "billing", "master"), // Billing's origin names no default, so master is taken for it.
    on("jacob", "billing", "master"),
    on("bob", "theme", "main"), // Theme's origin names develop, so main is a branch like any other.
    on("jacob", "theme", "main"),
    on("bob", "api", "detached at a1b2c3d"), // No branch.
    on("jacob", "api", "detached at a1b2c3d"),
    on("jacob", "docs", "notes"), // Nobody else is on it.
    on("bob", "web", "feature/retry"), // Not mine.
    { ...on("bob", "other", "feature/retry"), name: "uploader" } // Another repo of the same name, as its key says.
  ];
  const defaults = new Map([
    ["uploader", null],
    ["theme", "develop"]
  ]);
  const pinned = (name: string, branch: string | null): ChannelInfo => ({ name: "#room", members: ["bob"], repo: { name, key: repo("bob", name).key, url: repo("bob", name).url }, branch });
  const suggested = (channels: readonly ChannelInfo[], dismissed: readonly Room[] = []): string[] =>
    suggestions(team, "jacob", channels, defaults, dismissed).map(({ repo: name, branch, others }) => `${name}/${branch} ${others.join(" ")}`);

  assert.deepEqual(suggested([]), ["uploader/feature/retry bob carol", "theme/main bob"]);
  assert.deepEqual(suggested([pinned("uploader", "feature/retry")]), ["theme/main bob"]); // A room I am not in counts.
  assert.deepEqual(suggested([pinned("uploader", null), pinned("uploader", "main"), pinned("web", "feature/retry")]), ["uploader/feature/retry bob carol", "theme/main bob"]);
  assert.deepEqual(suggested([], [{ repo: "theme", branch: "main" }]), ["uploader/feature/retry bob carol"]);
  assert.deepEqual(suggested([], [{ repo: "theme", branch: "develop" }]), ["uploader/feature/retry bob carol", "theme/main bob"]);
  // Bob's desk knows no default for theme, so main is taken for it.
  assert.deepEqual(
    suggestions(team, "bob", [], new Map(), []).map(({ repo: name, branch }) => `${name}/${branch}`),
    ["uploader/feature/retry"]
  );
});

await test("a branch room's name is the repo and the branch, cleaned and cut to fit a channel's name, with a number in place of its end while it is taken", () => {
  assert.equal(roomName("uploader", "feature/retry", []), "#uploader-feature-retry");
  assert.equal(roomName("uploader", "feature/retry", ["#uploader-feature-retry"]), "#uploader-feature-retry-2");
  assert.equal(roomName("uploader", "feature/retry", ["#uploader-feature-retry", "#uploader-feature-retry-2"]), "#uploader-feature-retry-3");
  assert.equal(roomName("uploader", "release/2026.10", []), "#uploader-release-2026-10");
  assert.equal(roomName("acme.billing.api", "Users/Jacob/ABC-123_Fix--it", []), "#acme-billing-api-users-jacob-abc"); // The repo keeps 16 characters, and the rest is cut.
  assert.equal(roomName("platform.services.uploader-v2", "fix", []), "#platform-services-uploader-v-fix"); // The repo is cut to leave the branch room.
  assert.equal(roomName("uploader", "a-branch-name-that-goes-on-and-on", []), "#uploader-a-branch-name-that-goes");
  assert.equal(roomName("uploader", "a-branch-name-that-goes-on-and-on", ["#uploader-a-branch-name-that-goes"]), "#uploader-a-branch-name-that-go-2");
  assert.equal(roomName("uploader", "ÄÖÜ", []), "#uploader"); // Nothing of the branch a name can hold.
  for (const { name, branch } of [
    { name: "a", branch: "-_-" },
    { name: "x".repeat(64), branch: "y".repeat(200) },
    { name: "a.b", branch: "😀/🎉" }
  ]) {
    assert.ok(channelSchema.safeParse(roomName(name, branch, [])).success, `${name} ${branch}`);
  }
});

await test("a pin's branch is a name git check-ref-format --branch takes, except @ and one holding a control, formatting character or line separator beyond ASCII, which git takes", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "player-two-refs-")); // Outside any repository, where git expands no @{-1}.
  t.after(() => {
    rmSync(outside, { recursive: true, force: true });
  });
  const gitTakes = async (name: string): Promise<boolean> => (await repos.git(["-C", outside, "check-ref-format", "--branch", name], 20)).ok;
  const taken = ["main", "feature/retry", "release/2026.10", "Users/Jacob/ABC-123_fix", "a-", "a/-b", "a./b", "x.lockx", "lock", "a@b", "@a", "head", "a{b}", "a#b!$%&(;<|=+,'\"", "ÄÖÜ", "😀"];
  const refused = ["-", "-x", "--force", ":main", "a:b", "a..b", "....", "a/..b", "a b", "a\tb", "a\nb", "a\x7fb", "a~b", "a^b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "@{-1}"];
  refused.push("/a", "a/", "a//b", "a.", "a/b.", "a.lock", "a.lock/b", "b/a.lock", ".a", "a/.b", ".lock", "HEAD");
  for (const name of [...taken, ...refused]) {
    assert.deepEqual([await gitTakes(name), branchNameSchema.safeParse(name).success], [taken.includes(name), taken.includes(name)], JSON.stringify(name));
  }
  for (const name of ["@", "a\u202eb", "a\u2066b", "a\u200bb", "a\u2028b", "a\u0085b"]) {
    assert.deepEqual([await gitTakes(name), branchNameSchema.safeParse(name).success], [true, false], JSON.stringify(name));
  }
  assert.ok(branchNameSchema.safeParse("x".repeat(200)).success);
  assert.ok(!branchNameSchema.safeParse("x".repeat(201)).success); // As every branch here.
});

/** A client whose hub is a table of answers, by method and path. Nothing is sent anywhere; what was asked is added to `asked`. */
function clientOf(answers: Readonly<Record<string, unknown>>, asked: string[] = []): Client {
  const transport: Transport = (method, url) => {
    asked.push(`${method} ${new URL(url).pathname}`);
    return Promise.resolve(JSON.stringify(answers[asked.at(-1) ?? ""]));
  };
  const agent = { id: "custom", label: "fake-agent", protocol: "oneshot", command: "fake-agent", args: [] } as const;
  return new Client("/nowhere", { hub: "http://hub.test", name: "jacob", agents: [agent], defaultAgent: "custom", ownMode: "auto-edits" }, key, transport, () => NOW);
}

await test("a client that has never seen an agent's owner, or any registration of the agent, does not trust its events, and asks the hub only for registrations before it says so", async () => {
  const asked: string[] = [];
  const client = clientOf({ "GET /events": [], "GET /users": [] }, asked);
  const content = JSON.stringify({ repo: "uploader", branch: "main", text: "trust me", reviewed: false });
  const answer = { seq: 7, event: signEvent(key, { author: "zed/uploader", to: "jacob", kind: "job.result", content, ts: NOW, refs: [] }) };

  assert.equal(await client.isTrusted(answer), false);
  assert.deepEqual(asked, ["GET /events"]); // The events to everyone: an agent's key is never taken from the hub's word, nor pinned as a person's is.
  assert.deepEqual(shown(logOf("jacob", [{ ...answer, trusted: false }]), "zed"), ["! zed/uploader"]); // Shown as a warning, without what it says.
});

await test("the client reads past a field a newer hub adds, but refuses one inside a signed event", async () => {
  const event = signEvent(key, { author: "bob", to: "jacob", kind: "message", content: JSON.stringify({ text: "hello", via: "cli" }), ts: NOW, refs: [] });
  const info = { version: "9.0.0", protocol: PROTOCOL, repos: "dev.azure.com/acme", now: NOW };
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
    "POST /events": { seq: 7, chain: "new" },
    "GET /events": [{ seq: 7, event, chain: "new" }],
    [`GET /events/${event.id}`]: { seq: 7, event, chain: "new" },
    "GET /search": [{ seq: 7, event, snippet: "say \u0002hello\u0003 to…", rank: "new" }],
    "GET /audit/head": { seq: 7, chain: "0".repeat(64), events: "new" }
  });

  assert.deepEqual(await client.info(), info);
  assert.deepEqual(await client.users(), [bob]);
  assert.deepEqual(await client.repos(), [repo("bob", "uploader")]);
  assert.deepEqual(await client.channels(), [backend, pinned]);
  assert.equal((await client.publish("bob", "message", { text: "hello", via: "cli" })).seq, 7);
  assert.deepEqual(await client.events({ chat: "bob" }), [{ seq: 7, event }]);
  assert.deepEqual(await client.around({ chat: "bob", around: 7 }), [{ seq: 7, event }]);
  assert.deepEqual(await client.event(event.id), { seq: 7, event });
  assert.deepEqual(await client.search({ q: "hello" }), [
    {
      seq: 7,
      event,
      snippet: [
        { text: "say ", hit: false },
        { text: "hello", hit: true },
        { text: " to…", hit: false }
      ]
    }
  ]);
  assert.deepEqual(await client.head(), { seq: 7, chain: "0".repeat(64) });
  await assert.rejects(clientOf({ "GET /events": [{ seq: 7, event: { ...event, via: "new" } }] }).events({ chat: "bob" }), /Unrecognized key/);
  await assert.rejects(clientOf({ "GET /search": [{ seq: 7, event: { ...event, via: "new" }, snippet: "" }] }).search({ q: "hello" }), /Unrecognized key/);
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
  const hello = await alice.publish("bob", "message", { text: "hello", via: "cli" });

  assert.ok(await bob.isTrusted(hello));
  assert.ok(!(await bob.isTrusted({ ...hello, event: { ...hello.event, content: JSON.stringify({ text: "hullo", via: "cli" }) } })));
  writeFileSync(join(hub.dir, "bob", "known.json"), JSON.stringify({ alice: publicHex(key) })); // Bob first saw alice under another key: what the hub says now does not count.
  assert.ok(!(await bob.isTrusted(hello)));
});

await test("an agent's event is trusted under the key its owner's newest registration before it holds, a registration its owner's pinned key vouches for, and under no other", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, mallory, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("mallory"), await hub.join("carol")];
  const [first, second] = [loadKey("33".repeat(32)), loadKey("44".repeat(32))];
  const report = (signer: KeyObject, seq: number, author = "alice/uploader"): Delivered => ({
    seq,
    event: signEvent(signer, { author, to: "bob", kind: "job.progress", content: JSON.stringify({ repo: "uploader", summary: "reading" }), ts: NOW, refs: [] })
  });

  assert.ok(!(await bob.isTrusted(report(first, 1)))); // Nobody has registered it.
  await alice.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(first) }); // 1
  await mallory.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(second) }); // 2: her own uploader, which says nothing of alice's.
  await alice.publish("bob", "message", { text: "between", via: "cli" }); // 3
  assert.ok(await bob.isTrusted(report(first, 3))); // Learned from the hub once it was needed.
  assert.ok(!(await bob.isTrusted(report(second, 3))));
  assert.ok(!(await bob.isTrusted(report(first, 1)))); // Not before it was registered.
  assert.ok(await bob.isTrusted(report(second, 3, "mallory/uploader")));

  await alice.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(second) }); // 4: a new key from here on.
  assert.ok(await bob.isTrusted(report(second, 5)));
  assert.ok(!(await bob.isTrusted(report(first, 5))));
  assert.ok(await bob.isTrusted(report(first, 3))); // What it signed before still holds.

  writeFileSync(join(hub.dir, "carol", "known.json"), JSON.stringify({ alice: publicHex(key) })); // Carol first saw alice under another key, so nothing the hub holds from this alice vouches for an agent.
  assert.ok(!(await carol.isTrusted(report(second, 5))));
  assert.ok(await carol.isTrusted(report(second, 5, "mallory/uploader")));
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
  // An agent's words written as one line to show are split back into the same words, and a line that is a preset's one-shot command is that preset.
  const args = ["-p", "two words", "it's", "", "--home=$HOME", 'a"b', "--plain=1,2"];
  assert.equal(commandLineOf({ command: "my agent", args }), `'my agent' -p 'two words' 'it'\\''s' '' '--home=$HOME' 'a"b' --plain=1,2`);
  assert.deepEqual(splitCommand(commandLineOf({ command: "my agent", args })), ["my agent", ...args]);
  assert.equal(oneshotAgent(" agent  -p --output-format 'text' "), DEFAULT_PRESET);
  assert.equal(oneshotAgent("agent -p").id, "custom");
});

await test("a config.json that still names one agent command loads as one one-shot agent and is written back in the new shape; one whose default is not among its agents is refused", (t) => {
  const home = mkdtempSync(join(tmpdir(), "player-two-config-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const file = join(home, "config.json");
  writeFileSync(file, JSON.stringify({ hub: "http://hub.test", name: "jacob", agent: `claude -p --model "big one"` }));
  const agent = { id: "custom", label: `claude -p --model "big one"`, protocol: "oneshot", command: "claude", args: ["-p", "--model", "big one"] };
  const now = { hub: "http://hub.test", name: "jacob", agents: [agent], defaultAgent: "custom", ownMode: "auto-edits" };
  assert.deepEqual(readConfig(home), now);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), now);
  assert.deepEqual(readConfig(home), now); // Read again, as it was written.
  for (const wrong of [
    { ...now, defaultAgent: "cursor" },
    { ...now, agents: [agent, agent] },
    { ...now, agents: [] },
    { ...now, ownMode: "anything" }
  ]) {
    writeFileSync(file, JSON.stringify(wrong));
    assert.throws(() => readConfig(home), z.ZodError, JSON.stringify(wrong));
  }
});

await test("a mode allows, asks about or refuses each kind of action as the protocol reference's table says, and the modes are ordered read-only to full", () => {
  // One column per mode, in the order of MODES: read-only, supervised, auto-edits, full.
  const table: readonly (readonly [Action, readonly Decision[]])[] = [
    ["read", ["allow", "allow", "allow", "allow"]],
    ["search", ["allow", "allow", "allow", "allow"]],
    ["think", ["allow", "allow", "allow", "allow"]],
    ["edit", ["refuse", "ask", "allow", "allow"]],
    ["delete", ["refuse", "ask", "ask", "allow"]],
    ["move", ["refuse", "ask", "ask", "allow"]],
    ["execute", ["refuse", "ask", "ask", "allow"]],
    ["fetch", ["refuse", "ask", "ask", "allow"]],
    ["other", ["refuse", "ask", "ask", "allow"]]
  ];
  for (const [action, row] of table) {
    assert.deepEqual(
      MODES.map((mode) => decide(mode, action)),
      row,
      action
    );
  }
  assert.deepEqual(
    MODES.map((a) => MODES.map((b) => atMost(a, b))),
    MODES.map((_a, i) => MODES.map((_b, j) => i <= j))
  );
});

await test("an event's envelope holds exactly the signed fields, a kind of dotted lowercase words, and content up to its kind's limit", () => {
  const event = { id: "ab".repeat(32), author: "bob", to: "#backend", kind: "message", content: "{}", ts: NOW, refs: ["cd".repeat(32)], nonce: "ef".repeat(8), sig: "01".repeat(64) };
  const fits = (changed: Readonly<Record<string, unknown>>): boolean => eventSchema.safeParse({ ...event, ...changed }).success;

  assert.ok(fits({}));
  assert.ok(fits({ to: "*", kind: "job.accepted" }));
  assert.ok(fits({ author: "bob/acme.billing.api" })); // From phase 4, one of bob's agents.
  assert.ok(!fits({ author: "bob/uploader/more" }));
  assert.ok(!fits({ author: "Bob/uploader" }));
  assert.ok(!fits({ author: "bob/" }));
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
  const accepted = { repo: "uploader", branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: "full", delegate: false, by: "owner" };
  const known: readonly (readonly [string, unknown])[] = [
    ["message", { text: "hi @bob/uploader", via: "window" }],
    ["message.edit", { text: "hello" }],
    ["message.delete", {}],
    ["reaction", { emoji: "👍", on: false }],
    ["channel.join", {}],
    ["channel.leave", {}],
    ["channel.pin", { repo: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" }, branch: null }],
    ["channel.pin", { repo: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" }, branch: "feature/retry" }], // From phase 6.
    ["channel.pin", { repo: null, branch: null }],
    ["job.accepted", accepted],
    ["job.declined", { repo: "uploader", reason: "" }],
    ["job.progress", { repo: "uploader", summary: "running a command" }],
    ["job.result", { repo: "uploader", branch: "main", text: "in queue.py", reviewed: true }],
    ["job.error", { repo: "uploader" }],
    ["job.cancelled", { repo: "uploader" }],
    ["job.withdrawn", { agent: "jacob/uploader" }],
    ["agent.register", { repo: "uploader", pubkey: "ab".repeat(32) }]
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
  assert.equal(read("job.accepted", { ...accepted, mode: "supervised" }), `job.accepted ${JSON.stringify({ ...accepted, mode: "supervised" })}`); // Every permission mode, from phase 3.
  assert.equal(read("job.accepted", { ...accepted, mode: "everything" }), "unknown");
  assert.equal(read("channel.pin", { repo: null, branch: "main" }), "unknown"); // A branch goes with a repo.
  assert.equal(read("job.withdrawn", { agent: "uploader" }), "unknown");
  assert.equal(read("job.progress", { repo: "uploader", summary: "running npm test" }), "unknown"); // Never a command, a path or output.
  assert.equal(read("agent.register", { repo: "uploader", pubkey: "AB".repeat(32) }), "unknown"); // A key in lowercase hex, as every key is written.
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

await test("a checkout's default branch is the one its origin names, as git clone notes it, and none after git init", async (t) => {
  const dev = mkdtempSync(join(tmpdir(), "player-two-default-"));
  t.after(() => {
    rmSync(dev, { recursive: true, force: true });
  });
  const path = join(dev, "uploader");
  await repos.git(["init", "-q", "-b", "main", path], 20);
  await repos.git(["-C", path, "remote", "add", "origin", "https://dev.azure.com/acme/Platform/_git/uploader"], 20);
  assert.deepEqual(
    repos.scan(dev, "dev.azure.com/acme").map((checkout) => [checkout.branch, checkout.defaultBranch]),
    [["main", null]]
  );
  await repos.git(["-C", path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"], 20);
  assert.deepEqual(
    repos.scan(dev, "dev.azure.com/acme").map((checkout) => [checkout.branch, checkout.defaultBranch]),
    [["main", "develop"]]
  );
});

await test("a checkout's head is its branch, the commit it is at and whether anything is uncommitted, and one with no commit, or whose status git cannot read, cannot be described", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "player-two-head-"));
  t.after(() => {
    rmSync(path, { recursive: true, force: true });
  });
  const checkout = { remote: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" }, path, branch: "main", defaultBranch: null };
  const git = (...args: string[]): Promise<unknown> => repos.git(["-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], 20);
  await git("init", "-q", "-b", "main");
  await assert.rejects(repos.describe(checkout), /git cannot say which commit/);
  await git("commit", "-q", "--allow-empty", "-m", "first");
  const head = await repos.describe(checkout);
  assert.deepEqual([head.branch, /^[0-9a-f]{40}$/.test(head.commit), head.dirty], ["main", true, false]);
  writeFileSync(join(path, "new.txt"), "changed");
  assert.deepEqual(await repos.describe(checkout), { ...head, dirty: true });
  writeFileSync(join(path, ".git", "index"), "not an index"); // The commit can still be named, but git status fails.
  await assert.rejects(repos.describe(checkout), /git cannot say whether .* has uncommitted changes: fatal: .*index/);
});

await test("running an agent returns what it printed, in the environment it is given beside the desk's own, reports a failure, and stops when cancelled", async () => {
  const never = new AbortController().signal;
  assert.equal(await runAgent(["sh", "-c", "printf ' hello\n'"], process.cwd(), never), "hello");
  assert.equal(await runAgent(["sh", "-c", 'printf "%s %s" "$PLAYER_TWO_AGENT" "$PATH"'], process.cwd(), never, { PLAYER_TWO_AGENT: "jacob/uploader" }), `jacob/uploader ${process.env["PATH"] ?? ""}`);
  assert.equal(
    await oneshotRunner(oneshotAgent("sh -c"), runAgent).run(
      'printf %s "$PLAYER_TWO_AGENT"',
      process.cwd(),
      "full",
      { activity: () => undefined, permission: () => Promise.resolve("refuse") },
      never,
      undefined,
      { PLAYER_TWO_AGENT: "jacob/uploader" }
    ),
    "jacob/uploader"
  );
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

await test("a one-shot agent runs only at a mode its command can keep to: Cursor's read-only as it is or at full with --force, any other only at full, and nothing starts at another", async () => {
  const ran: string[][] = [];
  const exec: Runner = (argv) => {
    ran.push([...argv]);
    return Promise.resolve("done");
  };
  const never = new AbortController().signal;
  const handlers: RunHandlers = { activity: () => undefined, permission: () => Promise.resolve("refuse") };
  const cursor = oneshotRunner(DEFAULT_PRESET, exec);
  const copilot = oneshotRunner(oneshotAgent("copilot -s --allow-all-tools --no-ask-user -p"), exec);
  const own = oneshotRunner(oneshotAgent("claude -p"), exec);
  assert.deepEqual(
    [cursor, copilot, own].map((runner) => MODES.map((mode) => runner.cannotHonour(mode) === "")),
    [
      [true, false, false, true],
      [false, false, false, true],
      [false, false, false, true]
    ]
  );
  assert.equal(await cursor.run("hi", process.cwd(), "read-only", handlers, never), "done");
  assert.equal(await cursor.run("hi", process.cwd(), "full", handlers, never), "done");
  assert.equal(await own.run("hi", process.cwd(), "full", handlers, never), "done");
  await assert.rejects(cursor.run("hi", process.cwd(), "auto-edits", handlers, never), /^Error: Cursor one-shot runs either read-only, when it only proposes changes, or with full access/);
  await assert.rejects(copilot.run("hi", process.cwd(), "read-only", handlers, never), /^Error: Copilot one-shot runs as a single command and cannot be limited/);
  assert.deepEqual(ran, [
    ["agent", "-p", "--output-format", "text", "hi"],
    ["agent", "-p", "--output-format", "text", "--force", "hi"],
    ["claude", "-p", "hi"]
  ]);
});
