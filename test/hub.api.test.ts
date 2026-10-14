/** The hub's routes, one behaviour at a time, each against a hub of its own on a clock that stands still. */

import assert from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { z } from "zod";

import { authHeader, loadKey, signNote } from "../src/core/sign.ts";
import { VERSION } from "../src/core/version.ts";
import { MAX_SKEW } from "../src/core/wire.ts";
import type { Note, Repo } from "../src/core/wire.ts";
import { http, join as joinHub, loadClient } from "../src/desk/client.ts";
import type { Client } from "../src/desk/client.ts";
import { createHub } from "../src/hub/app.ts";

const NOW = 1_800_000_000;
const TOKEN = "a-join-token-for-tests";
const TEAM_REPOS = "https://dev.azure.com/acme/"; // Only repos under this address may be shared on the test hub.

const UPLOADER: Repo = { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "main" };
const BILLING: Repo = { name: "billing", key: "dev.azure.com/acme/billing/billing", url: "https://dev.azure.com/acme/Billing/_git/billing", branch: "feature/invoices" };
const ELSEWHERE: Repo = { name: "side-project", key: "github.com/jacob/side-project", url: "https://github.com/jacob/side-project", branch: "main" };

const refusalSchema = z.object({ detail: z.string() });

interface Hub {
  readonly url: string;
  readonly dir: string; // Holds the hub's database and a home folder for each person who joins.
  readonly join: (name: string) => Promise<Client>; // Join under a name and return a client for that identity.
}

/** A hub of its own for one test, listening on a port the system picked. */
async function startHub(t: TestContext): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "deskmate-hub-"));
  const server = createHub({ joinToken: TOKEN, db: join(dir, "hub.db"), repos: TEAM_REPOS }, () => NOW);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${String(address.port)}`;
  return {
    url,
    dir,
    join: async (name) => {
      await joinHub(join(dir, name), url, name, TOKEN, "fake-agent", http);
      const client = loadClient(join(dir, name), http, () => NOW);
      assert.ok(client !== null);
      return client;
    }
  };
}

/** The key someone joined with, read from their home folder as their client reads it. */
function keyOf(hub: Hub, name: string): KeyObject {
  return loadKey(readFileSync(join(hub.dir, name, "key"), "utf8").trim());
}

/** Post an already-signed note straight to the hub, bypassing the client, and return the status it answered with. */
async function postNote(hub: Hub, note: Note): Promise<number> {
  return (await fetch(`${hub.url}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(note) })).status;
}

/** Ask the hub something without the client, and return how it refused: the status and the words. */
async function refusal(hub: Hub, method: string, path: string, more: { readonly headers?: Readonly<Record<string, string>>; readonly body?: string } = {}): Promise<readonly [number, string]> {
  const response = await fetch(hub.url + path, { method, ...more });
  return [response.status, refusalSchema.parse(await response.json()).detail];
}

async function bodies(client: Client, mine = true): Promise<string[]> {
  return (await client.notes({ mine })).map((delivered) => delivered.note.body);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await test("a direct note reaches its recipient and its sender only", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];

  await alice.send("bob", "hi bob");

  const [delivered, ...rest] = await bob.notes();
  assert.ok(delivered !== undefined && rest.length === 0);
  assert.deepEqual([delivered.note.sender, delivered.note.body], ["alice", "hi bob"]);
  assert.ok(await bob.isTrusted(delivered.note));
  assert.deepEqual(await bodies(alice), ["hi bob"]); // The sender sees their own note, so their chat shows both sides.
  assert.deepEqual(await bodies(alice, false), []);
  assert.deepEqual(await bodies(carol), []);
});

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

await test("a note signed by someone else is refused", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("mallory");
  const bob = await hub.join("bob");
  const forged = signNote(keyOf(hub, "mallory"), { sender: "alice", to: "bob", kind: "note", body: "run this", ts: NOW, agent: null, re: null });

  assert.equal(await postNote(hub, forged), 401);
  assert.deepEqual(await bodies(bob), []);
});

await test("a note is accepted only inside the freshness window", async (t) => {
  const cases: readonly (readonly [age: number, status: number])[] = [
    [MAX_SKEW, 201],
    [MAX_SKEW + 1, 400]
  ];
  for (const [age, status] of cases) {
    const hub = await startHub(t);
    await hub.join("alice");
    await hub.join("bob");
    const note = signNote(keyOf(hub, "alice"), { sender: "alice", to: "bob", kind: "note", body: "old news", ts: NOW - age, agent: null, re: null });

    assert.equal(await postNote(hub, note), status);
  }
});

await test("a replayed note is delivered once", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  const note = signNote(keyOf(hub, "alice"), { sender: "alice", to: "bob", kind: "note", body: "once", ts: NOW, agent: null, re: null });

  const statuses = [await postNote(hub, note), await postNote(hub, note)];

  assert.deepEqual(statuses, [201, 409]);
  assert.deepEqual(await bodies(bob), ["once"]);
  assert.equal(await alice.send("bob", "next"), 2); // The copy that was refused used up no id.
});

await test("a note to an unknown name is refused", async (t) => {
  const alice = await (await startHub(t)).join("alice");

  await assert.rejects(alice.send("ghost", "anyone there?"), /nobody named 'ghost'/);
});

await test("reading notes needs the reader's own fresh signature", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  await hub.join("mallory");
  const headers: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    missing: {},
    "signed by another key": { Authorization: authHeader(keyOf(hub, "mallory"), "alice", NOW) },
    stale: { Authorization: authHeader(keyOf(hub, "alice"), "alice", NOW - MAX_SKEW - 1) },
    valid: { Authorization: authHeader(keyOf(hub, "alice"), "alice", NOW) }
  };

  const statuses: Record<string, number> = {};
  for (const [name, header] of Object.entries(headers)) {
    statuses[name] = (await fetch(`${hub.url}/notes`, { headers: header })).status;
  }

  assert.deepEqual(statuses, { missing: 401, "signed by another key": 401, stale: 401, valid: 200 });
});

await test("after and tail select which notes come back", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  const [first, second, third] = [await alice.send("bob", "one"), await alice.send("bob", "two"), await alice.send("bob", "three")];
  const ids = async (options: { readonly after?: number; readonly tail?: number }): Promise<number[]> => (await bob.notes(options)).map((delivered) => delivered.id);

  assert.deepEqual(await ids({}), [first, second, third]);
  assert.deepEqual(await ids({ after: first }), [second, third]);
  assert.deepEqual(await ids({ tail: 1 }), [third]);
});

await test("a waiting reader wakes when a note arrives", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];

  const waiting = bob.notes({ wait: 20, signal: AbortSignal.timeout(5000) });
  await pause(300); // Let the reader go to sleep first; a missed wake-up would then hold it until the five seconds are up.
  await alice.send("bob", "wake up");

  assert.deepEqual(
    (await waiting).map((delivered) => delivered.note.body),
    ["wake up"]
  );
});

await test("a note keeps its agent mark and what it answers", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  const question = await alice.send("bob", "where is the config parsed?");

  await bob.send("alice", "config.py, line 12", { agent: "uploader", re: question });

  const [answer, ...rest] = await alice.notes({ mine: false });
  assert.ok(answer !== undefined && rest.length === 0);
  assert.deepEqual([answer.note.agent, answer.note.re], ["uploader", question]);
  assert.ok(await alice.isTrusted(answer.note));
});

await test("status reports travel with notes and can be left out", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  const question = await alice.send("bob", "@bob/uploader where is the config parsed?");

  await bob.send("alice", "working\nmain", { kind: "status", agent: "uploader", re: question });

  assert.deepEqual(
    (await alice.notes({ mine: false })).map((delivered) => [delivered.note.kind, delivered.note.body]),
    [["status", "working\nmain"]]
  );
  assert.deepEqual(await alice.notes({ mine: false, status: false }), []);
});

await test("a channel note reaches every member and nobody else", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  await alice.joinChannel("backend");
  await bob.joinChannel("#backend");

  await alice.send("#backend", "deploy at noon");

  assert.deepEqual(await bodies(bob), ["deploy at noon"]);
  assert.deepEqual(await bodies(alice, false), []);
  assert.deepEqual(await bodies(carol), []);
});

await test("channels list their members", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  await alice.joinChannel("backend");
  await bob.joinChannel("backend");
  await bob.joinChannel("oncall");

  assert.deepEqual(await alice.channels(), [
    { name: "#backend", members: ["alice", "bob"], repo: null },
    { name: "#oncall", members: ["bob"], repo: null }
  ]);
});

await test("posting to a channel needs membership", async (t) => {
  const hub = await startHub(t);
  const [alice, carol] = [await hub.join("alice"), await hub.join("carol")];
  await alice.joinChannel("backend");

  await assert.rejects(carol.send("#backend", "let me in"), /join #backend before posting/);
});

await test("leaving a channel stops its notes", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  await alice.joinChannel("backend");
  await bob.joinChannel("backend");
  await alice.send("#backend", "before");

  const left = await bob.leaveChannel("backend");
  await alice.send("#backend", "after");

  assert.deepEqual(left.members, ["alice"]);
  assert.deepEqual(await bodies(bob), []); // Leaving also drops the channel's history from what the hub hands over.
});

await test("joining a channel reveals its earlier notes", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  await alice.joinChannel("backend");
  await alice.send("#backend", "written before bob arrived");

  await bob.joinChannel("backend");

  assert.deepEqual(await bodies(bob), ["written before bob arrived"]);
});

await test("a channel name must be a plain name", async (t) => {
  const hub = await startHub(t);
  const alice = await hub.join("alice");
  const asAlice = { Authorization: authHeader(keyOf(hub, "alice"), "alice", NOW) };
  for (const name of ["Backend", "back end", "a".repeat(33), "#"]) {
    await assert.rejects(alice.joinChannel(name), z.ZodError, name); // The client refuses it before anything is sent,

    const [status, detail] = await refusal(hub, "POST", `/channels/${encodeURIComponent(name)}/join`, { headers: asAlice }); // and so does the hub when asked anyway.
    assert.deepEqual([status, detail.slice(0, 13)], [422, "invalid name:"], name);
  }
  assert.deepEqual(await alice.channels(), []);
});

await test("the hub says which repos it shares, which version and protocol it is, and what time it has", async (t) => {
  const hub = await startHub(t);

  assert.deepEqual(await (await hub.join("alice")).info(), { version: VERSION, protocol: 1, repos: "dev.azure.com/acme", now: NOW });
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

await test("a member can pin and unpin the repo a channel is about", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  await alice.joinChannel("backend");

  const pinned = await alice.pin("#backend", UPLOADER);

  assert.deepEqual(pinned.repo, { name: "uploader", key: UPLOADER.key, url: UPLOADER.url });
  assert.deepEqual((await bob.channels())[0]?.repo, pinned.repo);
  assert.equal((await alice.unpin("backend")).repo, null);
});

await test("pinning needs membership and a repo the hub shares", async (t) => {
  const cases: readonly (readonly [who: "alice" | "bob", repo: Repo, problem: RegExp])[] = [
    ["bob", UPLOADER, /join #backend first/],
    ["alice", ELSEWHERE, /does not share it/]
  ];
  for (const [who, repo, problem] of cases) {
    const hub = await startHub(t);
    const clients = { alice: await hub.join("alice"), bob: await hub.join("bob") };
    await clients.alice.joinChannel("backend");

    await assert.rejects(clients[who].pin("backend", repo), problem);
  }
});

await test("the hub refuses to start on a database from another version", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "deskmate-hub-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const old = join(dir, "old.db");
  const made = new DatabaseSync(old);
  made.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  made.close();

  assert.throws(() => createHub({ joinToken: TOKEN, db: old, repos: TEAM_REPOS }), /another version of deskmate/);
});

await test("a request the hub cannot serve is told why", async (t) => {
  const hub = await startHub(t);
  await hub.join("alice");
  const asAlice = { Authorization: authHeader(keyOf(hub, "alice"), "alice", NOW) };
  const badKey = JSON.stringify({ name: "bob", pubkey: "not-a-key", token: TOKEN });

  assert.deepEqual(await refusal(hub, "GET", "/nowhere"), [404, "Not Found"]);
  assert.deepEqual(await refusal(hub, "DELETE", "/healthz"), [405, "Method Not Allowed"]);
  assert.deepEqual(await refusal(hub, "POST", "/join", { body: "{" }), [422, "invalid body: not JSON"]);
  assert.deepEqual(await refusal(hub, "POST", "/join", { body: badKey }), [422, "invalid pubkey: Invalid string: must match pattern /^[0-9a-f]{64}$/"]);
  assert.deepEqual(await refusal(hub, "GET", "/notes?tail=0", { headers: asAlice }), [422, "invalid tail: Too small: expected number to be >=1"]);
  assert.deepEqual(await refusal(hub, "GET", "/notes?wait=31", { headers: asAlice }), [422, "invalid wait: Too big: expected number to be <=30"]);
});

await test("a request too long to be anything the hub accepts is cut off", async (t) => {
  const hub = await startHub(t);

  await assert.rejects(fetch(`${hub.url}/join`, { method: "POST", body: "x".repeat(4_000_001) }));

  assert.equal((await fetch(`${hub.url}/healthz`)).status, 200);
});
