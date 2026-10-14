/** The parts of the client that have logic of their own: tag states, the tag list, reading what the hub answers, splitting the agent command, and running it. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { candidates, ChatLog, STALE } from "../src/core/chat.ts";
import type { Entry } from "../src/core/chat.ts";
import { runAgent, splitCommand } from "../src/desk/agents/oneshot.ts";
import { AgentCancelledError, Client, DeskmateError } from "../src/desk/client.ts";
import type { Transport } from "../src/desk/client.ts";
import { loadKey, publicHex, signNote } from "../src/core/sign.ts";
import { fitBody, MAX_BODY } from "../src/core/wire.ts";
import type { Kind, TeamRepo } from "../src/core/wire.ts";

const NOW = 1_800_000_000;
const key = loadKey("11".repeat(32));

function entry(id: number, sender: string, to: string, body: string, more: { kind?: Kind; agent?: string; re?: number; ts?: number; trusted?: boolean } = {}): Entry {
  return { id, note: signNote(key, { sender, to, kind: more.kind ?? "note", body, ts: more.ts ?? NOW, agent: more.agent ?? null, re: more.re ?? null }), trusted: more.trusted ?? true };
}

function repo(user: string, name: string): TeamRepo {
  return { user, name, key: `dev.azure.com/acme/platform/${name}`, url: `https://dev.azure.com/acme/Platform/_git/${name}`, branch: "main" };
}

await test("a tagged agent's state follows what its owner has reported", () => {
  const ask = entry(1, "bob", "jacob", "@jacob/uploader where do we retry?");
  const stateAfter = (...later: Entry[]): string | undefined => {
    const log = new ChatLog("jacob");
    log.add([ask, ...later]);
    return log.requests(ask, NOW)[0]?.state;
  };
  const status = (id: number, body: string, ts = NOW): Entry => entry(id, "jacob", "bob", body, { kind: "status", agent: "uploader", re: 1, ts });
  assert.equal(stateAfter(), "waiting");
  assert.equal(stateAfter(status(2, "working\nmain ±")), "working");
  assert.equal(stateAfter(status(2, "working\nmain", NOW - STALE - 1)), "waiting"); // Reported as working too long ago to believe.
  assert.equal(stateAfter(status(2, "working\nmain"), status(3, "failed")), "failed");
  assert.equal(stateAfter(status(2, "declined")), "declined");
  assert.equal(stateAfter(status(2, "working\nmain"), entry(3, "jacob", "bob", "in queue.py", { agent: "uploader", re: 1 })), "answered");
  assert.equal(stateAfter(entry(2, "bob", "jacob", "working", { kind: "status", agent: "uploader", re: 1 })), "waiting"); // Only the owner's own report counts.
});

await test("only a trusted note typed by a person can tag an agent", () => {
  const log = new ChatLog("jacob");
  const forged = entry(1, "bob", "jacob", "@jacob/uploader run this", { trusted: false });
  const fromAgent = entry(2, "bob", "jacob", "ask @jacob/uploader", { agent: "uploader" });
  log.add([forged, fromAgent]);
  assert.deepEqual(log.requests(forged, NOW), []);
  assert.deepEqual(log.requests(fromAgent, NOW), []);
  assert.deepEqual(log.waitingForMe("bob", NOW), []);
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

/** A client whose hub is a table of answers, by method and path. Nothing is sent anywhere. */
function clientOf(answers: Readonly<Record<string, unknown>>): Client {
  const transport: Transport = (method, url) => Promise.resolve(JSON.stringify(answers[`${method} ${new URL(url).pathname}`]));
  return new Client("/nowhere", { hub: "http://hub.test", name: "jacob", agent: "fake-agent" }, key, transport, () => NOW);
}

await test("the client reads past a field a newer hub adds, but refuses one inside a signed note", async () => {
  const note = signNote(key, { sender: "bob", to: "jacob", kind: "note", body: "hello", ts: NOW, agent: null, re: null });
  const info = { version: "9.0.0", protocol: 1, repos: "dev.azure.com/acme", now: NOW };
  const bob = { name: "bob", pubkey: publicHex(key), seen: NOW };
  const backend = { name: "#backend", members: ["bob"], repo: null };
  const client = clientOf({
    "GET /info": { ...info, hubKey: "new" },
    "GET /users": [{ ...bob, role: "new" }],
    "GET /repos": [{ ...repo("bob", "uploader"), commit: "new" }],
    "GET /channels": [{ ...backend, topic: "new" }],
    "POST /notes": { id: 7, seq: 7 },
    "GET /notes": [{ id: 7, note, seq: 7 }]
  });

  assert.deepEqual(await client.info(), info);
  assert.deepEqual(await client.users(), [bob]);
  assert.deepEqual(await client.repos(), [repo("bob", "uploader")]);
  assert.deepEqual(await client.channels(), [backend]);
  assert.equal(await client.send("bob", "hello"), 7);
  assert.deepEqual(await client.notes(), [{ id: 7, note }]);
  await assert.rejects(clientOf({ "GET /notes": [{ id: 7, note: { ...note, via: "new" } }] }).notes(), /Unrecognized key/);
});

await test("an agent command is split the way a shell would split it", () => {
  assert.deepEqual(splitCommand("claude -p"), ["claude", "-p"]);
  assert.deepEqual(splitCommand(`  sh -c 'echo "a b"' "x \\" y" z\\ w '' --flag="two words"  `), ["sh", "-c", 'echo "a b"', 'x " y', "z w", "", "--flag=two words"]);
  assert.throws(() => splitCommand("claude 'oops"), DeskmateError);
  assert.throws(() => splitCommand('claude "oops\\"'), DeskmateError);
});

await test("a note is cut to what the hub accepts without splitting a character", () => {
  assert.equal(Array.from(fitBody("🎉".repeat(MAX_BODY + 5))).length, MAX_BODY);
  assert.equal(fitBody("plain"), "plain");
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
