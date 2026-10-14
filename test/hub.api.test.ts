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
import { authHeader, loadKey, signEvent } from "../src/core/sign.ts";
import { VERSION } from "../src/core/version.ts";
import { deliveredSchema, MAX_SKEW, receiptSchema } from "../src/core/wire.ts";
import type { Delivered, Event, Repo } from "../src/core/wire.ts";
import { http, join as joinHub } from "../src/desk/client.ts";
import { createHub } from "../src/hub/app.ts";
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

  await assert.rejects(joinHub(join(hub.dir, "impostor"), hub.url, "alice", TOKEN, "fake-agent", http), /taken/);
});

await test("joining needs the join token", async (t) => {
  const hub = await startHub(t);

  await assert.rejects(joinHub(join(hub.dir, "alice"), hub.url, "alice", "not-the-token", "fake-agent", http), /join token/);
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
  assert.deepEqual(await refused("before=3"), [422, "invalid query: before goes with chat, and after without it"]);
  assert.deepEqual(await refused("chat=alice&after=3"), [422, "invalid query: before goes with chat, and after without it"]);
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

await test("the audit head is the newest seq and chain value, and hub verify passes a clean log and names the first row changed by hand", async (t) => {
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
  kept.prepare("UPDATE events SET content = ? WHERE seq = 2").run(JSON.stringify({ text: "TWO", via: "cli" }));
  kept.close();

  assert.deepEqual(verify(), [1, "player-two: the chain breaks at seq 2: that event, or its chain value, is not what was stored after the 1 before it\n"]);
});

await test("the hub says which repos it shares, which version and protocol it is, and what time it has", async (t) => {
  const hub = await startHub(t);

  assert.deepEqual(await (await hub.join("alice")).info(), { version: VERSION, protocol: 2, repos: "dev.azure.com/acme", now: NOW });
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

  assert.throws(() => createHub({ joinToken: TOKEN, db: old, repos: TEAM_REPOS, downloads: "" }), /another version of Player Two \(schema 3, this one uses 5\)/);
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
