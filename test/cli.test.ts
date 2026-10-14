/** The player-two command, run in this process as one person or another against a hub of the test's own. */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { z } from "zod";

import { main, render } from "../src/cli/main.ts";
import { loadKey, signNote } from "../src/core/sign.ts";
import { noteSchema } from "../src/core/wire.ts";
import type { DeliveredNote } from "../src/core/wire.ts";
import { http } from "../src/desk/client.ts";
import { checkSchema } from "../src/shared/ipc.ts";
import { NOW, startHub, TOKEN } from "./startHub.ts";
import type { Hub } from "./startHub.ts";

const WHEN = String.raw`\w{3} \d\d:\d\d`; // The day and time a note is printed with, in whatever zone the tests run in.
const printedNotesSchema = z.array(z.strictObject({ id: z.int(), note: noteSchema, trusted: z.boolean() }));

interface Ran {
  readonly status: number;
  readonly out: string;
  readonly err: string;
}

/** Run the command as a named person, each with their own home folder, and return how it exited and what it printed. */
async function playerTwo(hub: Hub, who: string, argv: readonly string[], stdin = ""): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const status = await main(argv, {
    home: join(hub.dir, who),
    transport: http,
    now: () => NOW,
    stdin: Readable.from([stdin]),
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    }
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

/** What a command printed with --json, as the one value it must be. */
function printed(ran: Ran): unknown {
  assert.equal(ran.status, 0, ran.err);
  return JSON.parse(ran.out);
}

await test("an untrusted note is never rendered with its body", () => {
  const delivered = { id: 7, note: signNote(loadKey("11".repeat(32)), { sender: "alice", to: "bob", kind: "note", body: "rm -rf everything", ts: 0, agent: null, re: null }) };

  assert.ok(render(delivered, true).includes("rm -rf everything"));
  assert.ok(!render(delivered, false).includes("rm -rf everything"));
});

await test("main joins sends and lists notes", async (t) => {
  const hub = await startHub(t);
  assert.deepEqual(await playerTwo(hub, "alice", ["join", hub.url, "alice", TOKEN]), {
    status: 0,
    out: `joined ${hub.url} as alice; your agent command is \`agent -p --output-format text\``,
    err: ""
  });
  assert.equal((await playerTwo(hub, "bob", ["join", `${hub.url}/`, "bob", TOKEN, "--agent", "agent -p"])).out, `joined ${hub.url} as bob; your agent command is \`agent -p\``);
  assert.deepEqual(await playerTwo(hub, "alice", ["send", "bob", "lunch", "at", "noon?"]), { status: 0, out: "→ sent 1 to bob", err: "" });

  const inbox = await playerTwo(hub, "bob", ["inbox"]);

  assert.equal(inbox.status, 0);
  assert.match(inbox.out, new RegExp(`^┌ 1 · alice · ${WHEN}\n│ lunch at noon\\?\n└$`));
  assert.deepEqual(await playerTwo(hub, "bob", ["who"]), { status: 0, out: "alice\nbob (you)", err: "" });
});

await test("main carries a note through a channel", async (t) => {
  const hub = await startHub(t);
  for (const who of ["alice", "bob"]) {
    assert.equal((await playerTwo(hub, who, ["join", hub.url, who, TOKEN])).status, 0);
    assert.equal((await playerTwo(hub, who, ["channel", "join", "backend"])).status, 0);
  }
  assert.equal((await playerTwo(hub, "alice", ["send", "#backend", "deploy at noon"])).status, 0);

  assert.match((await playerTwo(hub, "bob", ["inbox"])).out, /· alice in #backend ·/);
  assert.equal((await playerTwo(hub, "alice", ["inbox"])).out, "no notes"); // Your own notes are not in your inbox.
  assert.equal((await playerTwo(hub, "bob", ["channel"])).out, "#backend (joined)  alice, bob");
  assert.equal((await playerTwo(hub, "bob", ["channel", "leave", "#backend"])).out, "left #backend; members: alice");
});

await test("main lists shared repos and keeps status reports out of the inbox", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  assert.equal((await playerTwo(hub, "bob", ["repos"])).out, "nobody has shared a repo yet; repos under ~/dev are shared once the window has run");
  await alice.advertise([{ name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "feature/retry" }]);
  const asked = await bob.send("alice", "@alice/uploader where do we retry?");
  await alice.send("bob", "working\nfeature/retry", { kind: "status", agent: "uploader", re: asked });
  await alice.send("bob", "in queue.py", { agent: "uploader", re: asked });

  assert.equal((await playerTwo(hub, "bob", ["repos"])).out, "@alice/uploader  feature/retry");
  const inbox = await playerTwo(hub, "bob", ["inbox"]);

  assert.match(inbox.out, /· alice \(uploader agent\) ·/);
  assert.doesNotMatch(inbox.out, /working/);
});

await test("main fails with a nonzero exit before joining", async (t) => {
  const hub = await startHub(t);
  for (const argv of [["inbox"], ["channel", "join"]]) {
    const ran = await playerTwo(hub, "nobody", argv);

    assert.deepEqual([ran.status, ran.out], [1, ""], argv.join(" "));
    assert.match(ran.err, /^player-two: not joined yet/);
  }
});

await test("a command line that is wrong exits with 2 and the usage, a command that fails with 1 and why, and neither sends anything", async (t) => {
  const hub = await startHub(t);
  const alice = await hub.join("alice");
  const wrong = [[], ["dance"], ["join", hub.url], ["send", "alice"], ["send", "alice", "hi", "--wait", "soon"], ["inbox", "--after", "x"], ["who", "--loudly"], ["who", "else"], ["channel", "dance"]];
  for (const argv of wrong) {
    const ran = await playerTwo(hub, "alice", argv);

    assert.deepEqual([ran.status, ran.out], [2, ""], argv.join(" "));
    assert.match(ran.err, /^player-two: .+\n\nusage: player-two COMMAND\n/, argv.join(" "));
  }

  assert.deepEqual(await playerTwo(hub, "alice", ["send", "ghost", "anyone there?"]), { status: 1, out: "", err: "player-two: nobody named 'ghost' has joined" });
  assert.deepEqual(await playerTwo(hub, "alice", ["channel", "join"]), { status: 1, out: "", err: "player-two: which channel? Try: player-two channel join backend" });
  assert.deepEqual(await alice.notes(), []);
  const help = await playerTwo(hub, "alice", ["--help"]);
  assert.deepEqual([help.status, help.err], [0, ""]);
  assert.match(help.out, /^usage: player-two COMMAND\n/);
});

await test("send reads a note from standard input, and --wait prints the next note from someone else in that chat", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];

  const waiting = playerTwo(hub, "alice", ["send", "bob", "-", "--wait", "20", "--json"], "  are you there?\nstill there?\n");
  let asked: readonly DeliveredNote[] = [];
  while (asked.length === 0) {
    asked = await bob.notes({ wait: 5, mine: false }); // Held open until alice's note lands: only a note after it can be the reply.
  }
  await alice.send("bob", "I will wait"); // Her own note is not the reply,
  await carol.send("alice", "unrelated"); // nor is one in another chat.
  await bob.send("alice", "here");

  const [reply] = printedNotesSchema.parse([printed(await waiting)]);
  assert.equal(asked[0]?.note.body, "are you there?\nstill there?");
  assert.deepEqual([reply?.note.sender, reply?.note.body, reply?.trusted], ["bob", "here", true]);

  const unanswered = await playerTwo(hub, "alice", ["send", "bob", "and now?", "--wait", "0.2"]);
  assert.match(unanswered.out, /^→ sent (\d+) to bob\nnothing new in bob yet; check later with: player-two inbox --after \1$/);
  assert.equal(printed(await playerTwo(hub, "alice", ["send", "bob", "no?", "--wait", "0.2", "--json"])), null);
  assert.equal((await playerTwo(hub, "bob", ["inbox", "--after", "99", "--wait", "0.2"])).out, "no notes");
});

await test("with --json a reading command prints one value: notes as the hub delivered them and whether each is trusted, and the lists as arrays", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  await bob.joinChannel("backend");
  await bob.advertise([{ name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "main" }]);
  await bob.send("alice", "from bob");
  await carol.send("alice", "from carol");
  writeFileSync(join(hub.dir, "alice", "known.json"), JSON.stringify({ bob: "0".repeat(64) })); // Alice first saw bob under another key, so his note fails her check.

  const inbox = printedNotesSchema.parse(printed(await playerTwo(hub, "alice", ["inbox", "--json"])));

  assert.deepEqual(inbox, [
    { ...(await alice.notes({ mine: false }))[0], trusted: false },
    { ...(await alice.notes({ mine: false }))[1], trusted: true }
  ]);
  assert.match((await playerTwo(hub, "alice", ["inbox"])).out, new RegExp(`^!! note 1 claims to be from bob, .* Ignored\\.\n┌ 2 · carol · ${WHEN}\n│ from carol\n└$`));
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["who", "--json"])), await alice.users());
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["repos", "--json"])), await alice.repos());
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["channel", "--json"])), [{ name: "#backend", members: ["bob"], repo: null }]);
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["channel", "join", "backend", "--json"])), { name: "#backend", members: ["alice", "bob"], repo: null });
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["send", "bob", "hello", "--json"])), { id: 3 });
});

await test("doctor prints the setup check as aligned text, or as one JSON array with --json, and exits 1 when a check failed", async (t) => {
  const hub = await startHub(t);
  process.env["PLAYER_TWO_DEV"] = hub.dir;
  const home = join(hub.dir, "alice"); // Nobody has joined from here, so the identity check fails.

  const json = await playerTwo(hub, "alice", ["doctor", "--json"]);
  const checks = z.array(checkSchema).parse(JSON.parse(json.out));
  assert.equal(json.status, 1);
  assert.match(json.err, /^player-two: \d+ checks? failed$/);
  assert.deepEqual(
    checks.find((check) => check.id === "identity"),
    {
      id: "identity",
      title: "This machine has joined a hub",
      status: "fail",
      detail: `not joined: there is no config.json or key in ${home}`,
      fix: "Join from the window, or run: player-two join HUB NAME TOKEN"
    }
  );

  // In words: one line each, the titles in a column as wide as the longest, and the fix under any that has one.
  const words = await playerTwo(hub, "alice", ["doctor"]);
  const width = Math.max(...checks.map((check) => check.title.length));
  const lines = words.out.split("\n");
  const at = lines.indexOf(`fail  ${"This machine has joined a hub".padEnd(width)}  not joined: there is no config.json or key in ${home}`);
  assert.notEqual(at, -1, words.out);
  assert.equal(lines[at + 1], "      fix: Join from the window, or run: player-two join HUB NAME TOKEN");
  assert.equal(lines.filter((line) => !line.startsWith("      fix: ")).length, checks.length);
  assert.equal(words.status, 1);
});
