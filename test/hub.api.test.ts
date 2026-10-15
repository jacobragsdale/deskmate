/** The hub's routes, one behaviour at a time, each against a hub of its own on a clock that stands still. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { z } from "zod";

import { readContent } from "../src/core/kinds.ts";
import { authHeader, loadKey, publicHex, signEvent } from "../src/core/sign.ts";
import { VERSION } from "../src/core/version.ts";
import { deliveredSchema, MAX_SKEW, PROTOCOL, receiptSchema } from "../src/core/wire.ts";
import type { Delivered, Event, Repo } from "../src/core/wire.ts";
import { oneshotAgent } from "../src/desk/agents/presets.ts";
import { http, join as joinHub } from "../src/desk/client.ts";
import type { Client } from "../src/desk/client.ts";
import { createHub } from "../src/hub/app.ts";
import { Database } from "../src/hub/db.ts";
import { NOW, startHub, TEAM_REPOS, TOKEN } from "./startHub.ts";
import type { Hub } from "./startHub.ts";

const UPLOADER: Repo = { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "main" };
const BILLING: Repo = { name: "billing", key: "dev.azure.com/acme/billing/billing", url: "https://dev.azure.com/acme/Billing/_git/billing", branch: "feature/invoices" };
const ELSEWHERE: Repo = { name: "side-project", key: "github.com/jacob/side-project", url: "https://github.com/jacob/side-project", branch: "main" };

const COMMAND = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const refusalSchema = z.object({ detail: z.string() });

/** The key someone joined with, read from their home folder as their client reads it. */
function keyOf(hub: Hub, name: string): KeyObject {
  return loadKey(readFileSync(join(hub.dir, name, "key"), "utf8").trim());
}

/** The header that proves one request comes from `name`, for asking the hub without the client. */
function signedBy(hub: Hub, name: string, method: string, path: string): Readonly<Record<string, string>> {
  return { Authorization: authHeader(keyOf(hub, name), name, NOW, method, path) };
}

/** Ask the hub something without the client, and return how it refused: the status and the words. */
async function refusal(hub: Hub, method: string, path: string, more: { readonly headers?: Readonly<Record<string, string>>; readonly body?: string } = {}): Promise<readonly [number, string]> {
  const response = await fetch(hub.url + path, { method, ...more });
  return [response.status, refusalSchema.parse(await response.json()).detail];
}

/** An event signed by `author`, or by `more.key` when the test forges one. Content is given as the object it is the JSON text of. */
function signed(hub: Hub, author: string, to: string, kind: string, content: unknown = {}, more: { readonly ts?: number; readonly refs?: readonly string[]; readonly key?: KeyObject } = {}): Event {
  return signEvent(more.key ?? keyOf(hub, author), { author, to, kind, content: JSON.stringify(content), ts: more.ts ?? NOW, refs: more.refs ?? [] });
}

/** Post an event as `poster`, who signs the request, and return the status with the seq it was stored at or the words it was refused in. */
async function post(hub: Hub, poster: string, event: unknown): Promise<readonly [number, number | string]> {
  const response = await fetch(`${hub.url}/events`, { method: "POST", headers: { ...signedBy(hub, poster, "POST", "/events"), "Content-Type": "application/json" }, body: JSON.stringify(event) });
  const body: unknown = await response.json();
  return [response.status, response.ok ? receiptSchema.parse(body).seq : refusalSchema.parse(body).detail];
}

/** What `reader` gets from GET /events with this query. */
async function read(hub: Hub, reader: string, query: string): Promise<Delivered[]> {
  const path = `/events?${query}`;
  const response = await fetch(hub.url + path, { headers: signedBy(hub, reader, "GET", path) });
  assert.equal(response.status, 200, path);
  return z.array(deliveredSchema).parse(await response.json());
}

/** The same, each event as its text when it is a message and its kind when it is not. */
async function said(hub: Hub, reader: string, query = "after=0"): Promise<string[]> {
  return (await read(hub, reader, query)).map(({ event }) => {
    const content = readContent(event);
    return content.kind === "message" ? content.content.text : event.kind;
  });
}

/** Post a message as its author, for a test that is about something else, and return its seq. */
async function say(hub: Hub, author: string, to: string, text: string): Promise<number> {
  const [status, seq] = await post(hub, author, signed(hub, author, to, "message", { text, via: "cli" }));
  assert.ok(status === 201 && typeof seq === "number", String(seq));
  return seq;
}

/** An open GET /stream: the next line that is not empty, as a message's text, an event's kind, or a comment as it came; and hanging up. */
interface Stream {
  readonly next: () => Promise<string>;
  readonly hangUp: () => void;
}

async function openStream(hub: Hub, reader: string, after: number): Promise<Stream> {
  const path = `/stream?after=${String(after)}`;
  const hangUp = new AbortController();
  const response = await fetch(hub.url + path, { headers: signedBy(hub, reader, "GET", path), signal: hangUp.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.ok(response.body !== null);
  const chunks = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let held = "";
  const line = async (): Promise<string> => {
    for (let end = held.indexOf("\n"); end === -1; end = held.indexOf("\n")) {
      const { value, done } = await chunks.read();
      if (done) {
        return "(closed)";
      }
      held += value;
    }
    const [first = "", ...rest] = held.split("\n");
    held = rest.join("\n");
    return first;
  };
  const next = async (): Promise<string> => {
    for (let found = await line(); ; found = await line()) {
      if (found.startsWith("data: ")) {
        const { event } = deliveredSchema.parse(JSON.parse(found.slice("data: ".length)));
        const content = readContent(event);
        return content.kind === "message" ? content.content.text : event.kind;
      }
      if (found !== "") {
        return found;
      }
    }
  };
  return {
    next,
    hangUp: () => {
      hangUp.abort();
    }
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await test("joining again with the same key is allowed", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");

  assert.equal((await hub.join("alice")).config.name, "alice");
});

await test("a taken name cannot be joined with another key", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");

  await assert.rejects(joinHub(join(hub.dir, "impostor"), hub.url, "alice", TOKEN, oneshotAgent("fake-agent"), http), /taken/);
});

await test("joining needs the join token", async (t) => {
  const hub = await startHub(t);

  await assert.rejects(joinHub(join(hub.dir, "alice"), hub.url, "alice", "not-the-token", oneshotAgent("fake-agent"), http), /join token/);
});

await test("reading events needs the reader's own fresh signature", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("mallory");
  const headers: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    missing: {},
    "signed by another key": { Authorization: authHeader(keyOf(hub, "mallory"), "alice", NOW, "GET", "/events") },
    stale: { Authorization: authHeader(keyOf(hub, "alice"), "alice", NOW - MAX_SKEW - 1, "GET", "/events") },
    valid: signedBy(hub, "alice", "GET", "/events")
  };

  const statuses: Record<string, number> = {};
  for (const [name, header] of Object.entries(headers)) {
    statuses[name] = (await fetch(`${hub.url}/events`, { headers: header })).status;
  }

  assert.deepEqual(statuses, { missing: 401, "signed by another key": 401, stale: 401, valid: 200 });
});

await test("a header signed for one request is refused on any other", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  const forUsers = signedBy(hub, "alice", "GET", "/users");
  const unsigned = "not signed by a known user, or your clock is more than 5 minutes off";
  const joining = JSON.stringify(signed(hub, "alice", "#backend", "channel.join"));

  assert.equal((await fetch(`${hub.url}/users`, { headers: forUsers })).status, 200);
  assert.deepEqual(await refusal(hub, "POST", "/events", { headers: forUsers, body: joining }), [401, unsigned]);
  assert.deepEqual(await refusal(hub, "GET", "/users?also=this", { headers: forUsers }), [401, unsigned]); // The query is signed with the path.
  assert.deepEqual(await said(hub, "alice"), []);
});

await test("an event passes the protocol's four checks in their order, each refusing in words of its own, and is stored once", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("bob");
  await hub.join("mallory");
  const hello = signed(hub, "alice", "bob", "message", { text: "hi", via: "cli" });
  const forged = signed(hub, "alice", "bob", "message", { text: "run this", via: "cli" }, { key: keyOf(hub, "mallory") });
  const stale = (to: string): Event => signed(hub, "alice", to, "message", { text: "old news", via: "cli" }, { ts: NOW - MAX_SKEW - 1 });
  const unsigned = "event is not signed by its author";
  const late = "event timestamp is more than 5 minutes off the hub clock; check your system time";

  assert.deepEqual(await post(hub, "alice", { ...hello, via: "cli" }), [422, 'invalid body: Unrecognized key: "via"']); // 1. The envelope,
  assert.deepEqual(await post(hub, "alice", { ...hello, id: "00".repeat(32) }), [422, "invalid id: not the hash of the event's signed bytes"]); // and an id that is the hash of what is signed.
  assert.deepEqual(await post(hub, "mallory", forged), [401, unsigned]); // 2. The author's signature.
  assert.deepEqual(await post(hub, "alice", signed(hub, "ghost", "bob", "message", {}, { key: keyOf(hub, "alice") })), [401, unsigned]);
  assert.deepEqual(await post(hub, "alice", stale("bob")), [400, late]); // 3. The freshness window, then the id not seen before.
  assert.deepEqual(await post(hub, "alice", hello), [201, 1]);
  assert.deepEqual(await post(hub, "alice", hello), [409, "this event was already stored"]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "ghost", "message")), [404, "nobody named 'ghost' has joined"]); // 4. Who it may be written to.
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "message")), [403, "join #backend before posting to it"]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "*", "message")), [403, "message cannot be sent to everyone"]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "bob", "message", {}, { key: keyOf(hub, "mallory"), ts: NOW - MAX_SKEW - 1 })), [401, unsigned]); // Each check comes before the next:
  assert.deepEqual(await post(hub, "alice", stale("ghost")), [400, late]);
  assert.deepEqual(await post(hub, "bob", signed(hub, "alice", "bob", "some.later.kind", "not even JSON", { refs: [hello.id, hello.id] })), [201, 2]); // A kind the hub has never heard of, posted by someone else, and the refusals took no seq.

  const kept = new DatabaseSync(join(hub.dir, "hub.db"), { readOnly: true });
  t.after(() => {
    kept.close();
  });
  const first = createHash("sha256")
    .update(`${"0".repeat(64)}${hello.id}`)
    .digest("hex");
  assert.deepEqual({ ...kept.prepare("SELECT seq, chain FROM events WHERE seq = 1").get() }, { seq: 1, chain: first }); // Chained to 64 zeros,
  assert.deepEqual(
    kept
      .prepare("SELECT ref, seq FROM event_refs")
      .all()
      .map((row) => ({ ...row })),
    [{ ref: hello.id, seq: 2 }]
  ); // and what each refers to indexed once.
});

await test("an event is accepted only inside the freshness window, either side of the hub's clock", async (t) => {
  const cases: readonly (readonly [ts: number, status: number])[] = [
    [NOW - MAX_SKEW, 201],
    [NOW + MAX_SKEW, 201],
    [NOW - MAX_SKEW - 1, 400],
    [NOW + MAX_SKEW + 1, 400]
  ];
  for (const [ts, status] of cases) {
    const hub = await startHub(t);
    await hub.join("alice");
    await hub.join("bob");

    assert.equal((await post(hub, "alice", signed(hub, "alice", "bob", "message", { text: "news", via: "cli" }, { ts })))[0], status, String(ts - NOW));
  }
});

await test("a replayed event is stored and delivered once", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("bob");
  const once = signed(hub, "alice", "bob", "message", { text: "once", via: "cli" });

  assert.deepEqual(
    [await post(hub, "alice", once), await post(hub, "bob", once)],
    [
      [201, 1],
      [409, "this event was already stored"]
    ]
  );
  assert.deepEqual(await said(hub, "bob"), ["once"]);
  assert.equal(await say(hub, "alice", "bob", "next"), 2); // The copy that was refused used up no seq.
});

await test("joining, leaving and pinning are events the hub acts on, and one it cannot act on is refused and not stored", async (t) => {
  const hub = await startHub(t);
  const alice = await hub.join("alice");
  await hub.join("bob");
  const uploader = { name: UPLOADER.name, key: UPLOADER.key, url: UPLOADER.url };
  const channel = async (): Promise<unknown> => (await alice.channels())[0];

  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "channel.join")), [201, 1]); // Joining makes the channel.
  assert.deepEqual(await post(hub, "bob", signed(hub, "bob", "#backend", "channel.join")), [201, 2]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "channel.pin", { repo: uploader, branch: null })), [201, 3]);
  assert.deepEqual(await channel(), { name: "#backend", members: ["alice", "bob"], repo: uploader, branch: null });
  assert.deepEqual(await post(hub, "bob", signed(hub, "bob", "#backend", "channel.leave")), [201, 4]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "channel.pin", { repo: null, branch: null })), [201, 5]);
  assert.deepEqual(await channel(), { name: "#backend", members: ["alice"], repo: null, branch: null });

  const elsewhere = { name: ELSEWHERE.name, key: ELSEWHERE.key, url: ELSEWHERE.url };
  assert.deepEqual(await post(hub, "bob", signed(hub, "bob", "#backend", "channel.pin", { repo: uploader, branch: null })), [403, "join #backend before posting to it"]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "channel.pin", { repo: elsewhere, branch: null })), [
    422,
    "side-project is not under dev.azure.com/acme, so this hub does not share it"
  ]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "channel.pin", { repo: uploader, branch: "main" })), [422, "invalid content: not what channel.pin holds"]); // Not until phase 6.
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "channel.join", "not JSON")), [422, "invalid content: not what channel.join holds"]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "bob", "channel.join")), [422, "channel.join is sent to the channel it is about"]);
  assert.deepEqual(await post(hub, "bob", signed(hub, "bob", "#backend", "channel.leave")), [403, "join #backend before posting to it"]);
  assert.deepEqual(await channel(), { name: "#backend", members: ["alice"], repo: null, branch: null });
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "#backend", "message", { text: "still here", via: "cli" })), [201, 6]); // Nothing refused was stored.
});

await test("a direct event reaches the two people in it and nobody else, and a chat with one person holds both directions", async (t) => {
  const hub = await startHub(t);
  for (const name of ["alice", "bob", "carol", "dave"]) {
    await hub.join(name);
  }
  await say(hub, "alice", "bob", "hi bob");
  await say(hub, "bob", "alice", "hi alice");
  const later = signed(hub, "carol", "bob", "some.later.kind", "not even JSON", { refs: ["0f".repeat(32)] });
  await post(hub, "carol", later);

  assert.deepEqual(await said(hub, "bob"), ["hi bob", "hi alice", "some.later.kind"]);
  assert.deepEqual(await said(hub, "alice"), ["hi bob", "hi alice"]);
  assert.deepEqual(await said(hub, "carol"), ["some.later.kind"]);
  assert.deepEqual(await said(hub, "dave"), []);
  assert.deepEqual(await said(hub, "bob", "chat=alice"), ["hi alice", "hi bob"]); // Newest first.
  assert.deepEqual(await said(hub, "alice", "chat=bob"), ["hi alice", "hi bob"]);
  assert.deepEqual(await said(hub, "carol", "chat=alice"), []);
  assert.deepEqual(await read(hub, "bob", "chat=carol"), [{ seq: 3, event: later }]); // A kind the hub has never heard of comes back exactly as it was signed.
});

await test("a channel's events reach its members only: leaving stops them, and joining shows what was said before", async (t) => {
  const hub = await startHub(t);
  for (const name of ["alice", "bob", "carol"]) {
    await hub.join(name);
  }
  await post(hub, "alice", signed(hub, "alice", "#backend", "channel.join"));
  await say(hub, "alice", "#backend", "before bob");

  assert.deepEqual(await said(hub, "bob"), []);
  assert.deepEqual(await said(hub, "bob", "chat=%23backend"), []);

  await post(hub, "bob", signed(hub, "bob", "#backend", "channel.join"));
  await say(hub, "alice", "#backend", "with bob");

  assert.deepEqual(await said(hub, "bob", "chat=%23backend"), ["with bob", "channel.join", "before bob", "channel.join"]);
  assert.deepEqual(await said(hub, "bob", "after=3"), ["with bob"]);

  await post(hub, "bob", signed(hub, "bob", "#backend", "channel.leave"));
  await say(hub, "alice", "#backend", "after bob");

  assert.deepEqual(await said(hub, "bob"), ["channel.join", "channel.leave"]); // What he wrote himself, and nothing more of the channel's.
  assert.deepEqual(await said(hub, "bob", "chat=%23backend"), ["channel.leave", "channel.join"]);
  assert.deepEqual(await said(hub, "alice", "chat=%23backend&limit=2"), ["after bob", "channel.leave"]);
  assert.deepEqual(await said(hub, "carol"), []);
});

await test("a chat pages back with before and limit, catching up pages forward with after, and a query out of either form is refused", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("bob");
  for (const text of ["one", "two", "three", "four", "five"]) {
    await say(hub, "alice", "bob", text);
  }
  const refused = async (query: string): Promise<readonly [number, string]> => {
    const path = `/events?${query}`;
    return refusal(hub, "GET", path, { headers: signedBy(hub, "bob", "GET", path) });
  };

  assert.deepEqual(await said(hub, "bob", "chat=alice&limit=2"), ["five", "four"]);
  assert.deepEqual(await said(hub, "bob", "chat=alice&before=4&limit=2"), ["three", "two"]);
  assert.deepEqual(await said(hub, "bob", "after=2&limit=2"), ["three", "four"]);
  assert.deepEqual(await said(hub, "bob", ""), ["one", "two", "three", "four", "five"]);
  assert.deepEqual(await refused("limit=0"), [422, "invalid limit: Too small: expected number to be >=1"]);
  assert.deepEqual(await refused("limit=201"), [422, "invalid limit: Too big: expected number to be <=200"]);
  assert.deepEqual(await refused("chat=Alice"), [422, "invalid chat: Invalid string: must match pattern /^#?[a-z0-9][a-z0-9_-]{0,31}$/"]);
  assert.deepEqual(await refused("before=3"), [422, "invalid query: before or around goes with chat, and after without it"]);
  assert.deepEqual(await refused("chat=alice&after=3"), [422, "invalid query: before or around goes with chat, and after without it"]);
});

/** What a search finds, each result as its seq and its snippet written out with the found words in brackets. */
async function found(client: Client, q: string, chat?: string): Promise<(readonly [number, string])[]> {
  return (await client.search(chat === undefined ? { q } : { q, chat })).map(({ seq, snippet }) => [seq, snippet.map((piece) => (piece.hit ? `[${piece.text}]` : piece.text)).join("")]);
}

await test("a word said in a channel is found by its members and not by anyone else, best match first, and in one chat when asked", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  for (const name of ["alice", "bob"]) {
    await post(hub, name, signed(hub, name, "#backend", "channel.join"));
  }
  const inChannel = await say(hub, "alice", "#backend", "the retry queue lives in queue.py");
  const direct = await say(hub, "alice", "bob", "retry, retry and retry again");
  await say(hub, "carol", "alice", "nothing to see here");

  assert.deepEqual(await found(bob, "retry"), [
    [direct, "[retry], [retry] and [retry] again"],
    [inChannel, "the [retry] queue lives in queue.py"]
  ]);
  assert.deepEqual(await found(bob, "retry", "#backend"), [[inChannel, "the [retry] queue lives in queue.py"]]);
  assert.deepEqual(await found(bob, "queue retry"), [[inChannel, "the [retry] [queue] lives in [queue].py"]]); // Every word, in any order.
  assert.deepEqual(await found(carol, "retry"), []);
  assert.deepEqual(await found(alice, "retry", "carol"), []);
  assert.deepEqual((await alice.search({ q: "retry", limit: 1 })).length, 1);
});

await test("an edited message is found by its new words only, and a deleted one not at all", async (t) => {
  const hub = await startHub(t);
  const bob = await hub.join("bob");
  await hub.join("alice");
  const edited = signed(hub, "alice", "bob", "message", { text: "deploy on friday", via: "cli" });
  const deleted = signed(hub, "alice", "bob", "message", { text: "deploy the secret key", via: "cli" });
  for (const event of [
    edited,
    deleted,
    signed(hub, "alice", "bob", "message.edit", { text: "deploy on monday" }, { refs: [edited.id] }),
    signed(hub, "alice", "bob", "message.delete", {}, { refs: [deleted.id] })
  ]) {
    await post(hub, "alice", event);
  }

  assert.deepEqual(await found(bob, "monday"), [[1, "deploy on [monday]"]]);
  assert.deepEqual(await found(bob, "friday"), []);
  assert.deepEqual(await found(bob, "secret"), []);
  assert.deepEqual(await found(bob, "deploy"), [[1, "[deploy] on monday"]]);
});

await test("whatever is typed is read as words and never as query syntax: a search finds something or nothing, and too many words or characters are refused", async (t) => {
  const hub = await startHub(t);
  const bob = await hub.join("bob");
  await hub.join("alice");
  await say(hub, "alice", "bob", 'the "quotes" and odd:syntax, NEAR the retry* queue ^ here');
  const hostile = [
    '"quotes" AND -odd:syntax',
    '"',
    '""',
    '"""',
    "'",
    "*",
    "ret*",
    "NEAR(retry queue)",
    "NEAR(retry queue, 2)",
    "^retry",
    "text:retry",
    "{text}: retry",
    "search:retry",
    "rank:1",
    "retry OR nothing",
    "NOT retry",
    "AND",
    ")(",
    "-",
    "+retry",
    "retry\u0000queue",
    "🎉",
    "🎉 retry",
    "x".repeat(5000),
    "'; DROP TABLE events; --"
  ];
  const refused = new Set(['"', '""', '"""', "'", "*", ")(", "-", "🎉", "x".repeat(5000)]); // No letter or digit, so no words; or too long.
  const statuses: Record<string, number> = {};
  for (const q of hostile) {
    const path = `/search?${new URLSearchParams({ q }).toString()}`;
    const response = await fetch(hub.url + path, { headers: signedBy(hub, "bob", "GET", path) });
    statuses[q] = response.status;
    assert.equal(Array.isArray(await response.json()), !refused.has(q), q);
  }

  assert.deepEqual(
    Object.values(statuses),
    hostile.map((q) => (refused.has(q) ? 422 : 200)),
    JSON.stringify(statuses)
  );
  assert.equal((await bob.search({ q: '"quotes" AND -odd:syntax' })).length, 1); // Every word is in the message: quotes, and, odd, syntax.
  assert.equal((await bob.search({ q: "retry\u0000queue" })).length, 1);
  assert.equal((await bob.search({ q: "NEAR(retry queue)" })).length, 1); // NEAR is a word like any other, and the message holds "near".
  // A word is a run of letters and digits, as the tokenizer reads it: one joined to the next by punctuation is two words, and counts as two.
  const tooMuch = /invalid q: a search holds 1 to 8 words, in at most 200 characters/;
  await assert.rejects(bob.search({ q: "one two three four five six seven eight nine" }), tooMuch);
  await assert.rejects(bob.search({ q: Array<string>(9).fill("the").join(".") }), tooMuch);
  assert.equal((await bob.search({ q: Array<string>(8).fill("the").join(".") })).length, 1);
  await assert.rejects(bob.search({ q: " \u0000 " }), tooMuch);
  await assert.rejects(bob.search({ q: `retry ${"x".repeat(195)}` }), tooMuch);
  assert.deepEqual(await bob.search({ q: `retry ${"x".repeat(194)}` }), []);
  await assert.rejects(bob.search({ q: "retry", limit: 51 }), /invalid limit/);
  assert.equal((await bob.events({ chat: "alice" })).length, 1); // And the table is still there.
});

await test("one event is read by its id by whoever can see it, and a chat opens at a seq with events on both sides of it", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  for (let n = 1; n <= 9; n += 1) {
    await say(hub, "alice", "bob", String(n));
  }
  const fifth = (await bob.events({ chat: "alice", before: 6, limit: 1 }))[0];
  assert.ok(fifth !== undefined);
  const page = async (around: number, limit?: number): Promise<number[]> =>
    (await bob.around(limit === undefined ? { chat: "alice", around } : { chat: "alice", around, limit })).map((delivered) => delivered.seq);

  assert.deepEqual(await bob.event(fifth.event.id), fifth);
  assert.deepEqual(await alice.event(fifth.event.id), fifth);
  assert.equal(await carol.event(fifth.event.id), null); // Not hers to see, and answered as if it were not there.
  assert.equal(await bob.event("0f".repeat(32)), null);
  assert.equal(await bob.event("not an id"), null);
  assert.deepEqual(await page(5, 4), [3, 4, 5, 6]);
  assert.deepEqual(await page(5, 5), [3, 4, 5, 6, 7]);
  assert.deepEqual(await page(2, 4), [1, 2, 3]);
  assert.deepEqual(await page(9, 4), [7, 8, 9]);
  assert.deepEqual(await page(5), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(await carol.around({ chat: "alice", around: 5 }), []);
  const path = "/events?around=5";
  assert.deepEqual(await refusal(hub, "GET", path, { headers: signedBy(hub, "bob", "GET", path) }), [422, "invalid query: before or around goes with chat, and after without it"]);
  const both = "/events?chat=alice&around=5&before=5";
  assert.deepEqual(await refusal(hub, "GET", both, { headers: signedBy(hub, "bob", "GET", both) }), [422, "invalid query: before or around goes with chat, and after without it"]);
});

await test("the stream sends what is visible after S, then each event as it is stored, a comment every 20 seconds, and nothing more of a channel once it is left", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] }); // The hub's alone: fetch and the test runner keep their own timers.
  const hub = await startHub(t);
  for (const name of ["alice", "bob"]) {
    await hub.join(name);
    await post(hub, name, signed(hub, name, "#backend", "channel.join"));
  }
  await say(hub, "alice", "#backend", "before the stream");
  const stream = await openStream(hub, "bob", 2);
  t.after(stream.hangUp);

  assert.equal(await stream.next(), "before the stream");
  await say(hub, "alice", "bob", "while it is open");
  assert.equal(await stream.next(), "while it is open");
  t.mock.timers.tick(20_000);
  assert.equal(await stream.next(), ":");
  await post(hub, "bob", signed(hub, "bob", "#backend", "channel.leave"));
  await say(hub, "alice", "#backend", "after bob left");
  await say(hub, "alice", "bob", "still to bob");
  assert.equal(await stream.next(), "channel.leave");
  assert.equal(await stream.next(), "still to bob");
});

await test("a stream that starts more than a page behind sends all of it, in order", { timeout: 10_000 }, async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  for (let n = 1; n <= 205; n += 1) {
    await say(hub, "alice", "alice", String(n));
  }
  const stream = await openStream(hub, "alice", 0);
  t.after(stream.hangUp);
  const got: string[] = [];
  for (let n = 1; n <= 205; n += 1) {
    got.push(await stream.next());
  }

  assert.deepEqual(
    got,
    Array.from({ length: 205 }, (_, n) => String(n + 1))
  );
});

await test("a stream whose reader hangs up is closed, leaving no timer behind", { timeout: 10_000 }, async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  const timers = (): number => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const before = timers();
  const stream = await openStream(hub, "alice", 0);

  assert.equal(timers(), before + 1); // The comment line's.
  stream.hangUp();
  for (let tries = 0; timers() > before && tries < 100; tries += 1) {
    await pause(10);
  }
  assert.equal(timers(), before);
  assert.equal(await say(hub, "alice", "alice", "nobody is listening"), 1); // And the hub goes on.
});

await test("the audit head is the newest seq and chain value, and hub verify passes a clean log and names the first row changed by hand, its signature too, or that cannot be read", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("bob");
  const head = async (): Promise<unknown> => (await fetch(`${hub.url}/audit/head`, { headers: signedBy(hub, "alice", "GET", "/audit/head") })).json();
  const verify = (): readonly [number | null, string] => {
    const ran = spawnSync(process.execPath, [COMMAND, "hub", "verify"], { env: { PLAYER_TWO_DB: join(hub.dir, "hub.db") }, encoding: "utf8" });
    return [ran.status, ran.stdout + ran.stderr];
  };

  assert.deepEqual(await head(), { seq: 0, chain: "0".repeat(64) });
  assert.deepEqual(verify(), [0, `the chain holds: 0 events, the last chain value ${"0".repeat(64)}\n`]);

  let chain = "0".repeat(64);
  for (const text of ["one", "two", "three"]) {
    const event = signed(hub, "alice", "bob", "message", { text, via: "cli" });
    await post(hub, "alice", event);
    chain = createHash("sha256")
      .update(chain + event.id)
      .digest("hex");
  }

  assert.deepEqual(await head(), { seq: 3, chain });
  assert.deepEqual(verify(), [0, `the chain holds: 3 events, the last chain value ${chain}\n`]);

  const kept = new DatabaseSync(join(hub.dir, "hub.db"));
  const change = (sql: string, ...values: string[]): void => {
    kept.prepare(sql).run(...values);
  };
  change("UPDATE events SET content = ? WHERE seq = 2", JSON.stringify({ text: "TWO", via: "cli" }));
  assert.deepEqual(verify(), [1, "player-two: the chain breaks at seq 2: that event, or its chain value, is not what was stored after the 1 before it\n"]);
  change("UPDATE events SET content = ? WHERE seq = 2", JSON.stringify({ text: "two", via: "cli" }));
  assert.equal(verify()[0], 0);

  change("UPDATE events SET sig = (SELECT sig FROM events WHERE seq = 1) WHERE seq = 3"); // Not part of what the id is the hash of, so only the signature can tell.
  assert.deepEqual(verify(), [1, "player-two: the chain breaks at seq 3: its signature does not hold under the key alice joined with\n"]);
  change("UPDATE events SET refs = ? WHERE seq = 1", "not JSON");
  assert.deepEqual(verify(), [1, "player-two: the chain breaks at seq 1: that row cannot be read as an event (invalid event.refs: Invalid input: expected array, received undefined)\n"]);
  change("UPDATE events SET refs = '[]' WHERE seq = 1");
  change("DELETE FROM users WHERE name = 'alice'");
  assert.deepEqual(verify(), [1, "player-two: the chain breaks at seq 1: its author, alice, has no key on this hub to check its signature against\n"]);
  kept.close();
});

await test("the hub says which repos it shares, which version and protocol it is, and what time it has", async (t) => {
  const hub = await startHub(t);

  assert.deepEqual(await (await hub.join("alice")).info(), { version: VERSION, protocol: PROTOCOL, repos: "dev.azure.com/acme", now: NOW });
  assert.deepEqual(await (await fetch(`${hub.url}/healthz`)).json(), { ok: true, now: NOW }); // Unsigned too, for a machine whose clock is too far off for /info to answer it.
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

await test("everyone sees which repos each person has and a new list replaces the old", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  await alice.advertise([UPLOADER, BILLING]);
  await bob.advertise([UPLOADER]);

  await alice.advertise([BILLING]);

  assert.deepEqual(await bob.repos(), [
    { ...BILLING, user: "alice" },
    { ...UPLOADER, user: "bob" }
  ]);
});

await test("a list with a repo from elsewhere or a repeated name is refused whole", async (t) => {
  const cases: readonly (readonly [readonly Repo[], RegExp])[] = [
    [[UPLOADER, ELSEWHERE], /does not share it/],
    [[UPLOADER, UPLOADER], /share a name/]
  ];
  for (const [repos, problem] of cases) {
    const alice = await (await startHub(t)).join("alice");

    await assert.rejects(alice.advertise(repos), problem);

    assert.deepEqual(await alice.repos(), []);
  }
});

await test("a person's last signed request shows when they were last here", async (t) => {
  const hub = await startHub(t);
  const alice = await hub.join("alice");
  await hub.join("bob");

  const seen = Object.fromEntries((await alice.users()).map((person) => [person.name, person.seen]));

  assert.deepEqual(seen, { alice: NOW, bob: 0 }); // Bob has joined but never asked for anything.
});

await test("the hub refuses to start on a database from another version, such as 0.4's", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "player-two-hub-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const old = join(dir, "old.db");
  const made = new DatabaseSync(old);
  made.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); PRAGMA user_version = 3;");
  made.close();

  assert.throws(() => createHub({ joinToken: TOKEN, db: old, repos: TEAM_REPOS, downloads: "" }), /another version of Player Two \(schema 3, this one uses 7\)/);
});

await test("anyone may send the public kinds to everyone, and everyone reads them, but nothing else may be sent to everyone", async (t) => {
  const hub = await startHub(t);
  const alice = await hub.join("alice");
  await hub.join("bob");
  const grant = { agent: "alice/uploader", askers: ["bob"], mode: "read-only", delivery: "review", expires: NOW + 86_400, runsPerDay: 20 } as const;

  const granted = await alice.publish("*", "grant", grant); // Signed with the time the grant's 30 days are counted from.
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "*", "grant.revoke", {}, { refs: [granted.event.id] })), [201, 2]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "*", "agent.register", { repo: "uploader", pubkey: "ab".repeat(32) })), [201, 3]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "*", "message", { text: "hello, everyone", via: "cli" })), [403, "message cannot be sent to everyone"]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice", "*", "channel.join")), [403, "channel.join cannot be sent to everyone"]);
  await assert.rejects(alice.publish("*", "grant", { ...grant, expires: NOW + 31 * 86_400 }), z.ZodError); // Never signed: no reader would take it for a grant.

  assert.deepEqual(await said(hub, "bob"), ["grant", "grant.revoke", "agent.register"]);
});

await test("an agent's key is the one in its owner's newest agent.register, sent to everyone; one sent elsewhere or holding anything else is refused and not stored", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("bob");
  const register = (author: string, to: string, content: unknown): Promise<readonly [number, number | string]> => post(hub, author, signed(hub, author, to, "agent.register", content));
  const agents = (): unknown[] => {
    const db = new DatabaseSync(join(hub.dir, "hub.db"), { readOnly: true });
    try {
      return db
        .prepare("SELECT owner, repo, pubkey, seq FROM agents ORDER BY owner, repo")
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };

  assert.deepEqual(await register("alice", "*", { repo: "uploader", pubkey: "aa".repeat(32) }), [201, 1]);
  assert.deepEqual(await register("bob", "*", { repo: "uploader", pubkey: "bb".repeat(32) }), [201, 2]);
  assert.deepEqual(await register("alice", "*", { repo: "uploader", pubkey: "cc".repeat(32) }), [201, 3]); // A new key replaces the one before.
  assert.deepEqual(await register("alice", "bob", { repo: "billing", pubkey: "dd".repeat(32) }), [422, 'agent.register is sent to everyone, "*"']);
  assert.deepEqual(await register("alice", "*", { repo: "billing", pubkey: "not a key" }), [422, "invalid content: not what agent.register holds"]);
  assert.deepEqual(await register("alice", "*", { repo: "Billing/../x", pubkey: "dd".repeat(32) }), [422, "invalid content: not what agent.register holds"]);

  assert.deepEqual(agents(), [
    { owner: "alice", repo: "uploader", pubkey: "cc".repeat(32), seq: 3 },
    { owner: "bob", repo: "uploader", pubkey: "bb".repeat(32), seq: 2 }
  ]);
  assert.deepEqual(await said(hub, "bob"), ["agent.register", "agent.register", "agent.register"]); // Nothing refused was stored.
});

await test("an agent's event is stored when its registered key signs it, it is a run's own report, and its owner may write where it goes; it reaches whoever its owner's would", async (t) => {
  const hub = await startHub(t);
  for (const name of ["alice", "bob", "carol"]) {
    await hub.join(name);
  }
  const agent = loadKey("33".repeat(32));
  assert.equal((await post(hub, "alice", signed(hub, "alice", "*", "agent.register", { repo: "uploader", pubkey: publicHex(agent) })))[0], 201);
  await post(hub, "alice", signed(hub, "alice", "#backend", "channel.join"));
  await say(hub, "bob", "alice", "@alice/uploader where do we retry?");
  const [request] = await read(hub, "bob", "chat=alice");
  const about = { key: agent, refs: [request?.event.id ?? ""] };
  const reports = [
    ["job.progress", { repo: "uploader", summary: "reading" }],
    ["job.result", { repo: "uploader", branch: "main", text: "in queue.py", reviewed: false }],
    ["job.error", { repo: "uploader" }],
    ["job.cancelled", { repo: "uploader" }]
  ] as const;

  for (const [kind, content] of reports) {
    assert.equal((await post(hub, "alice", signed(hub, "alice/uploader", "bob", kind, content, about)))[0], 201, kind);
  }
  assert.equal((await post(hub, "alice", signed(hub, "alice/uploader", "#backend", "job.progress", { repo: "uploader", summary: "reading" }, about)))[0], 201); // Where alice is.

  const cannot = (kind: string): readonly [number, string] => [403, `agents cannot send ${kind}: only a person can`];
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "bob", "message", { text: "hello from the agent", via: "cli" }, about)), cannot("message"));
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "bob", "job.accepted", {}, about)), cannot("job.accepted"));
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "*", "grant", {}, about)), cannot("grant"));
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "*", "agent.register", { repo: "uploader", pubkey: "ab".repeat(32) }, about)), cannot("agent.register"));
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "#ops", "channel.join", {}, about)), cannot("channel.join"));
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "#ops", "job.error", { repo: "uploader" }, about)), [403, "join #ops before posting to it"]); // Where alice is not.
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "ghost", "job.error", { repo: "uploader" }, about)), [404, "nobody named 'ghost' has joined"]);
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/uploader", "bob", "job.error", { repo: "uploader" }, { ...about, key: keyOf(hub, "alice") })), [
    401,
    "event is not signed by its author"
  ]); // Not even by its owner's key.
  assert.deepEqual(await post(hub, "alice", signed(hub, "alice/billing", "bob", "job.error", { repo: "billing" }, about)), [401, "event is not signed by its author"]); // An agent nobody registered.

  const kinds = ["@alice/uploader where do we retry?", "job.progress", "job.result", "job.error", "job.cancelled"];
  assert.deepEqual(await said(hub, "bob", "chat=alice&limit=10"), kinds.toReversed()); // The agent's events are in the chat between its owner and bob, for both of them.
  assert.deepEqual(await said(hub, "alice", "chat=bob&limit=10"), kinds.toReversed());
  assert.deepEqual(await said(hub, "carol"), ["agent.register"]);
  assert.deepEqual(await said(hub, "alice", "chat=%23backend"), ["job.progress", "channel.join"]);
});

await test("a request an agent signs reads what its owner sees, may post its events, and changes nothing else of its owner's, not even when they were last here", async (t) => {
  const hub = await startHub(t);
  for (const name of ["alice", "bob", "carol"]) {
    await hub.join(name);
  }
  const agent = loadKey("33".repeat(32));
  await post(hub, "bob", signed(hub, "alice", "*", "agent.register", { repo: "uploader", pubkey: publicHex(agent) })); // Posted by bob, so alice has not been seen.
  await post(hub, "bob", signed(hub, "carol", "#ops", "channel.join"));
  await post(hub, "bob", signed(hub, "carol", "#ops", "message", { text: "for #ops only", via: "cli" }));
  await post(hub, "bob", signed(hub, "bob", "alice", "message", { text: "@alice/uploader where?", via: "cli" }));
  const as = (name: string, key: KeyObject, method: string, path: string): Readonly<Record<string, string>> => ({ Authorization: authHeader(key, name, NOW, method, path) });
  const status = async (path: string, headers: Readonly<Record<string, string>>, more: RequestInit = {}): Promise<number> => (await fetch(hub.url + path, { ...more, headers })).status;
  const visible = async (path: string): Promise<unknown> => (await fetch(hub.url + path, { headers: as("alice/uploader", agent, "GET", path) })).json();

  for (const path of ["/events?after=0", "/events?chat=bob", "/search?q=where", "/channels", "/users", "/info"]) {
    assert.equal(await status(path, as("alice/uploader", agent, "GET", path)), 200, path);
  }
  assert.deepEqual(
    z
      .array(deliveredSchema)
      .parse(await visible("/events?after=0"))
      .map(({ event }) => event.kind),
    ["agent.register", "message"]
  ); // Not carol's channel, which alice is not in.
  const progress = signed(hub, "alice/uploader", "bob", "job.progress", { repo: "uploader", summary: "reading" }, { key: agent });
  assert.equal(await status("/events", { ...as("alice/uploader", agent, "POST", "/events"), "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify(progress) }), 201);
  assert.deepEqual(await refusal(hub, "PUT", "/repos", { headers: as("alice/uploader", agent, "PUT", "/repos"), body: "[]" }), [403, "agents cannot change which repos their owner shares"]);

  const unsigned = [401, "not signed by a known user, or your clock is more than 5 minutes off"];
  assert.deepEqual(await refusal(hub, "GET", "/users", { headers: as("alice/uploader", keyOf(hub, "alice"), "GET", "/users") }), unsigned); // Its owner's key is not its key.
  assert.deepEqual(await refusal(hub, "GET", "/users", { headers: as("alice/billing", agent, "GET", "/users") }), unsigned); // Nobody registered that one.
  assert.deepEqual(await refusal(hub, "GET", "/users", { headers: as("alice/uploader/more", agent, "GET", "/users") }), unsigned); // Not a name at all.
  const seen = Object.fromEntries((await (await hub.join("bob")).users()).map((person) => [person.name, person.seen]));
  assert.deepEqual(seen, { alice: 0, bob: NOW, carol: 0 });
});

await test("hub verify checks an agent's events against the key its owner had registered for it then, and names one signed with any other", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("bob");
  const [first, second] = [loadKey("33".repeat(32)), loadKey("44".repeat(32))];
  const verify = (): readonly [number | null, string] => {
    const ran = spawnSync(process.execPath, [COMMAND, "hub", "verify"], { env: { PLAYER_TWO_DB: join(hub.dir, "hub.db") }, encoding: "utf8" });
    return [ran.status, ran.stdout + ran.stderr];
  };
  const progress = (key: KeyObject): Event => signed(hub, "alice/uploader", "bob", "job.progress", { repo: "uploader", summary: "reading" }, { key, refs: [] });
  for (const event of [
    signed(hub, "alice", "*", "agent.register", { repo: "uploader", pubkey: publicHex(first) }),
    progress(first),
    signed(hub, "alice", "*", "agent.register", { repo: "uploader", pubkey: publicHex(second) }), // A new key, from here on.
    progress(second)
  ]) {
    assert.equal((await post(hub, "alice", event))[0], 201);
  }
  const late = progress(first); // The old key, after the new one was registered.
  assert.deepEqual(await post(hub, "alice", late), [401, "event is not signed by its author"]);
  assert.match(verify()[1], /^the chain holds: 4 events/);

  // Put it in the log by hand in place of the fourth, which says the same with the new key, its chain value worked out again: only its signature can tell.
  const kept = new DatabaseSync(join(hub.dir, "hub.db"));
  const { chain } = z.object({ chain: z.string() }).parse(kept.prepare("SELECT chain FROM events WHERE seq = 3").get());
  const after = createHash("sha256")
    .update(chain + late.id)
    .digest("hex");
  kept.prepare("UPDATE events SET id = ?, nonce = ?, sig = ?, chain = ? WHERE seq = 4").run(late.id, late.nonce, late.sig, after);
  kept.close();
  assert.deepEqual(verify(), [1, "player-two: the chain breaks at seq 4: its signature does not hold under the key alice last registered for it before then\n"]);
});

await test("a database phase 2 made, schema 6, is brought forward with what it holds, gaining the agents table", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("bob");
  await say(hub, "alice", "bob", "words from before");
  await say(hub, "bob", "alice", "and a reply");
  const file = join(hub.dir, "hub.db");
  const older = new DatabaseSync(file); // What phase 2 left: the same users and events, and no agents table.
  older.exec("DROP TABLE agents; PRAGMA user_version = 6;");
  older.close();

  const db = new Database(file);
  db.setAgentKey("alice", "uploader", "aa".repeat(32), 3);
  assert.deepEqual([db.agentKeyOf("alice", "uploader"), db.agentKeyOf("bob", "uploader")], ["aa".repeat(32), null]);
  assert.deepEqual(
    db.eventsAfter("alice", 0, 10).map(({ event }) => readContent(event)),
    [
      { kind: "message", content: { text: "words from before", via: "cli" } },
      { kind: "message", content: { text: "and a reply", via: "cli" } }
    ]
  );
  assert.deepEqual(
    db.search("bob", ["before"], null, 10).map((hit) => hit.seq),
    [1]
  ); // The index is kept, not filled again.
  assert.deepEqual(
    db.users().map((person) => person.name),
    ["alice", "bob"]
  );
  db.close();
  const version = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual({ ...version.prepare("PRAGMA user_version").get() }, { user_version: 7 });
  version.close();
});

await test("the search index holds each message and answer as its author last edited it, and is filled from the events of a database 0.5 made", async (t) => {
  const hub = await startHub(t);
  const [, bob] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  const message = (author: string, to: string, text: string): Event => signed(hub, author, to, "message", { text, via: "cli" });
  const edited = message("alice", "bob", "the words before");
  const kept = message("alice", "bob", "words nobody could change");
  const deleted = message("alice", "bob", "words taken back");
  const asked = message("bob", "alice", "@alice/uploader a question");
  const answered = signed(hub, "alice", "bob", "job.result", { repo: "uploader", branch: "main", text: "an agent's answer", reviewed: false }, { refs: [asked.id] });
  for (const event of [
    edited,
    kept,
    deleted,
    asked,
    signed(hub, "alice", "bob", "message.edit", { text: "the words after" }, { refs: [edited.id] }),
    signed(hub, "bob", "alice", "message.edit", { text: "bob's words" }, { refs: [kept.id] }), // Not the author.
    signed(hub, "alice", "carol", "message.edit", { text: "words for carol" }, { refs: [kept.id] }), // Not the message's chat.
    signed(hub, "alice", "bob", "message.delete", {}, { refs: [deleted.id] }),
    signed(hub, "alice", "bob", "message.edit", { text: "words after the delete" }, { refs: [deleted.id] }),
    answered,
    signed(hub, "alice", "bob", "message.edit", { text: "an answer rewritten" }, { refs: [answered.id] }), // By its author, in its chat, but an answer is not a message.
    signed(hub, "alice", "bob", "message.delete", {}, { refs: [answered.id] }),
    signed(hub, "alice", "bob", "message", "not JSON"),
    signed(hub, "alice", "bob", "message", { text: "" }), // Not what a message holds.
    signed(hub, "alice", "bob", "message.edit", { text: "words naming nothing" }, { refs: [] }),
    message("alice", "bob", "\u0002marks\u0003 of its own")
  ]) {
    assert.equal((await post(hub, event.author, event))[0], 201);
  }
  const file = join(hub.dir, "hub.db");
  const words = (): unknown[] => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db
        .prepare("SELECT rowid, text FROM search ORDER BY rowid")
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  const indexed = [
    { rowid: 1, text: "the words after" },
    { rowid: 2, text: "words nobody could change" },
    { rowid: 4, text: "@alice/uploader a question" },
    { rowid: 10, text: "an agent's answer" },
    { rowid: 16, text: " marks  of its own" } // The characters that mark what a search found are spaces here, so every mark in a snippet is the hub's.
  ];

  assert.deepEqual(words(), indexed);
  assert.deepEqual(await found(bob, "own"), [[16, " marks  of its [own]"]]);

  const older = new DatabaseSync(file); // What 0.5 left: the same events, and no index.
  older.exec("DROP TABLE search; PRAGMA user_version = 5;");
  older.close();
  new Database(file).close();

  assert.deepEqual(words(), indexed);
});

await test("a request the hub cannot serve is told why", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  const badKey = JSON.stringify({ name: "bob", pubkey: "not-a-key", token: TOKEN });

  assert.deepEqual(await refusal(hub, "GET", "/nowhere"), [404, "Not Found"]);
  assert.deepEqual(await refusal(hub, "DELETE", "/healthz"), [405, "Method Not Allowed"]);
  assert.deepEqual(await refusal(hub, "GET", "/notes"), [404, "Not Found"]); // Notes went with phase 1, and so did the routes that changed a channel: those are events now.
  assert.deepEqual(await refusal(hub, "POST", "/channels/backend/join"), [404, "Not Found"]);
  assert.deepEqual(await refusal(hub, "POST", "/join", { body: "{" }), [422, "invalid body: not JSON"]);
  assert.deepEqual(await refusal(hub, "POST", "/join", { body: badKey }), [422, "invalid pubkey: Invalid string: must match pattern /^[0-9a-f]{64}$/"]);
  assert.deepEqual(await refusal(hub, "GET", "/stream?after=x", { headers: signedBy(hub, "alice", "GET", "/stream?after=x") }), [
    422,
    "invalid after: Invalid string: must match pattern /^\\d+(\\.\\d+)?$/"
  ]);
});

await test("a request too long to be anything the hub accepts is cut off", async (t) => {
  const hub = await startHub(t);

  await assert.rejects(fetch(`${hub.url}/join`, { method: "POST", body: "x".repeat(4_000_001) }));

  assert.equal((await fetch(`${hub.url}/healthz`)).status, 200);
});
