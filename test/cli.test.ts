/** The player-two command, run in this process as one person or another against a hub of the test's own. */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { z } from "zod";

import { main, render } from "../src/cli/main.ts";
import { readContent } from "../src/core/kinds.ts";
import { noteLink } from "../src/core/links.ts";
import { loadKey, signEvent } from "../src/core/sign.ts";
import { eventSchema } from "../src/core/wire.ts";
import type { Delivered } from "../src/core/wire.ts";
import { http } from "../src/desk/client.ts";
import { checkSchema } from "../src/shared/ipc.ts";
import { NOW, startHub, TOKEN } from "./startHub.ts";
import type { Hub } from "./startHub.ts";

const WHEN = String.raw`\w{3} \d\d:\d\d`; // The day and time a message is printed with, in whatever zone the tests run in.
const printedSchema = z.strictObject({ seq: z.int(), event: eventSchema, trusted: z.boolean() }); // One event as the hub delivered it, and whether it is trusted.

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

/** What a message says. */
function textOf(delivered: Delivered): string {
  const said = readContent(delivered.event);
  return said.kind === "message" ? said.content.text : "";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What a command printed with --json, as the one value it must be. */
function printed(ran: Ran): unknown {
  assert.equal(ran.status, 0, ran.err);
  return JSON.parse(ran.out);
}

await test("an untrusted message is never rendered with its text", () => {
  const content = JSON.stringify({ text: "rm -rf everything", via: "cli" });
  const delivered = { seq: 7, event: signEvent(loadKey("11".repeat(32)), { author: "alice", to: "bob", kind: "message", content, ts: 0, refs: [] }) };

  assert.ok(render(delivered, true).includes("rm -rf everything"));
  assert.ok(!render(delivered, false).includes("rm -rf everything"));
});

await test("main joins sends and lists messages", async (t) => {
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
  const [delivered] = printedSchema.array().parse(printed(await playerTwo(hub, "bob", ["inbox", "--json"])));
  assert.deepEqual(delivered === undefined ? null : readContent(delivered.event), { kind: "message", content: { text: "lunch at noon?", via: "cli" } }); // A message, from the command line.
  assert.deepEqual(await playerTwo(hub, "bob", ["who"]), { status: 0, out: "alice\nbob (you)", err: "" });
});

await test("main carries a message through a channel, joined and left by events", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  for (const who of ["alice", "bob"]) {
    assert.equal((await playerTwo(hub, who, ["channel", "join", "backend"])).out, who === "alice" ? "joined #backend; members: alice" : "joined #backend; members: alice, bob");
  }
  assert.equal((await playerTwo(hub, "alice", ["channel", "join", "#backend"])).status, 0); // Joining again says nothing more.
  assert.equal((await playerTwo(hub, "alice", ["send", "#backend", "deploy at noon"])).status, 0);

  assert.match((await playerTwo(hub, "bob", ["inbox"])).out, /· alice in #backend ·/);
  assert.equal((await playerTwo(hub, "alice", ["inbox"])).out, "no messages"); // Your own messages are not in your inbox, and joining is not a message.
  assert.equal((await playerTwo(hub, "bob", ["channel"])).out, "#backend (joined)  alice, bob");
  assert.equal((await playerTwo(hub, "bob", ["channel", "leave", "#backend"])).out, "left #backend; members: alice");
  assert.equal((await playerTwo(hub, "bob", ["channel", "leave", "backend"])).out, "left #backend; members: alice"); // Leaving again says nothing more.
  assert.deepEqual((await alice.events({ chat: "#backend" })).map((each) => `${each.event.author} ${each.event.kind}`).reverse(), [
    "alice channel.join",
    "bob channel.join",
    "alice message",
    "bob channel.leave"
  ]);
  assert.deepEqual(
    (await bob.events({ chat: "#backend" })).map((each) => `${each.event.author} ${each.event.kind}`),
    ["bob channel.leave", "bob channel.join"]
  ); // Bob is out, so he sees only what he did there himself.
  assert.deepEqual(await playerTwo(hub, "bob", ["channel", "join", "Back End"]), {
    status: 1,
    out: "",
    err: "player-two: a channel's name is lowercase letters, digits, - and _, at most 32 characters"
  });
});

await test("main lists shared repos and keeps job events out of the inbox, but not an agent's answer", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  assert.equal((await playerTwo(hub, "bob", ["repos"])).out, "nobody has shared a repo yet; repos under ~/dev are shared once the window has run");
  await alice.advertise([{ name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "feature/retry" }]);
  const asked = await bob.publish("alice", "message", { text: "@alice/uploader where do we retry?", via: "cli" });
  const about = [asked.event.id];
  await alice.publish("bob", "job.accepted", { repo: "uploader", branch: "feature/retry", commit: "c0ffee".padEnd(40, "0"), dirty: false, delivery: "post", mode: "full", by: "owner" }, about);
  await alice.publish("bob", "reaction", { emoji: "👀", on: true }, about);
  const answer = await alice.publish("bob", "job.result", { repo: "uploader", branch: "feature/retry", text: "in queue.py", reviewed: false }, about);

  assert.equal((await playerTwo(hub, "bob", ["repos"])).out, "@alice/uploader  feature/retry");
  assert.match((await playerTwo(hub, "bob", ["inbox"])).out, new RegExp(`^┌ ${String(answer.seq)} · alice \\(uploader agent\\) · ${WHEN}\n│ in queue\\.py\n└$`));
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
  assert.deepEqual(await alice.catchUp(0), []);
  const help = await playerTwo(hub, "alice", ["--help"]);
  assert.deepEqual([help.status, help.err], [0, ""]);
  assert.match(help.out, /^usage: player-two COMMAND\n/);
});

await test("send reads a message from standard input, and --wait prints the next message from someone else in that chat", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];

  const waiting = playerTwo(hub, "alice", ["send", "bob", "-", "--wait", "20", "--json"], "  are you there?\nstill there?\n");
  let asked: readonly Delivered[] = [];
  while (asked.length === 0) {
    await pause(20);
    asked = await bob.events({ chat: "alice" }); // Once alice's message has landed, only one after it can be the reply.
  }
  await alice.publish("bob", "message", { text: "I will wait", via: "cli" }); // Her own message is not the reply,
  await carol.publish("alice", "message", { text: "unrelated", via: "cli" }); // nor is one in another chat,
  await bob.publish("alice", "reaction", { emoji: "👍", on: true }, [asked[0]?.event.id ?? ""]); // nor anything but a message or an answer.
  await bob.publish("alice", "message", { text: "here", via: "cli" });

  const reply = printedSchema.parse(printed(await waiting));
  assert.equal(textOf(asked[0] ?? reply), "are you there?\nstill there?");
  assert.deepEqual([reply.event.author, textOf(reply), reply.trusted], ["bob", "here", true]);

  const unanswered = await playerTwo(hub, "alice", ["send", "bob", "and now?", "--wait", "0.2"]);
  assert.match(unanswered.out, /^→ sent (\d+) to bob\nnothing new in bob yet; check later with: player-two inbox --after \1$/);
  assert.equal(printed(await playerTwo(hub, "alice", ["send", "bob", "no?", "--wait", "0.2", "--json"])), null);
  assert.equal((await playerTwo(hub, "bob", ["inbox", "--after", "99", "--wait", "0.2"])).out, "no messages");
  assert.deepEqual(await playerTwo(hub, "alice", ["send", "bob", "-"], " \n"), { status: 1, out: "", err: "player-two: there is nothing to send" });
});

await test("inbox --after prints what came after a seq, and with --wait waits for the next", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  const first = await alice.publish("bob", "message", { text: "one", via: "cli" });
  await alice.publish("bob", "message", { text: "two", via: "cli" });

  assert.match((await playerTwo(hub, "bob", ["inbox", "--after", String(first.seq)])).out, /^┌ 2 · alice · .*\n│ two\n└$/);
  const waiting = playerTwo(hub, "bob", ["inbox", "--after", "2", "--wait", "20"]);
  await pause(200);
  await bob.publish("alice", "message", { text: "my own", via: "cli" });
  await alice.publish("bob", "message", { text: "three", via: "cli" });
  assert.match((await waiting).out, /^┌ 4 · alice · .*\n│ three\n└$/);
});

await test("inbox prints the newest 20 messages, however far back past other events they are", async (t) => {
  const hub = await startHub(t);
  const [alice] = [await hub.join("alice"), await hub.join("bob")];
  for (let count = 1; count <= 25; count += 1) {
    await alice.publish("bob", "message", { text: `message ${String(count)}`, via: "cli" });
  }
  const [last] = await alice.events({ chat: "bob", limit: 1 });
  for (let count = 0; count < 250; count += 1) {
    await alice.publish("bob", "reaction", { emoji: "👍", on: count % 2 === 0 }, [last?.event.id ?? ""]); // More than the first look back covers.
  }

  const inbox = printedSchema.array().parse(printed(await playerTwo(hub, "bob", ["inbox", "--json"])));
  assert.deepEqual(
    inbox.map((each) => textOf(each)),
    Array.from({ length: 20 }, (_, index) => `message ${String(index + 6)}`)
  );
});

await test("with --json a reading command prints one value: messages as the hub delivered them and whether each is trusted, and the lists as arrays", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  await bob.publish("#backend", "channel.join", {});
  await bob.advertise([{ name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "main" }]);
  await bob.publish("alice", "message", { text: "from bob", via: "cli" });
  await carol.publish("alice", "message", { text: "from carol", via: "cli" });
  writeFileSync(join(hub.dir, "alice", "known.json"), JSON.stringify({ bob: "0".repeat(64) })); // Alice first saw bob under another key, so his message fails her check.

  const inbox = printedSchema.array().parse(printed(await playerTwo(hub, "alice", ["inbox", "--json"])));

  const [fromBob, fromCarol] = await alice.catchUp(0);
  assert.ok(fromBob !== undefined && fromCarol !== undefined);
  assert.deepEqual(inbox, [
    { ...fromBob, trusted: false },
    { ...fromCarol, trusted: true }
  ]);
  assert.match(
    (await playerTwo(hub, "alice", ["inbox"])).out,
    new RegExp(`^!! ${String(fromBob.seq)} claims to be from bob, .* Ignored\\.\n┌ ${String(fromCarol.seq)} · carol · ${WHEN}\n│ from carol\n└$`)
  );
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["who", "--json"])), await alice.users());
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["repos", "--json"])), await alice.repos());
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["channel", "--json"])), [{ name: "#backend", members: ["bob"], repo: null, branch: null }]);
  assert.deepEqual(printed(await playerTwo(hub, "alice", ["channel", "join", "backend", "--json"])), { name: "#backend", members: ["alice", "bob"], repo: null, branch: null });
  const sent = z.strictObject({ seq: z.int(), event: eventSchema }).parse(printed(await playerTwo(hub, "alice", ["send", "bob", "hello", "--json"]))); // The message as sent, with its place in the log.
  assert.deepEqual([sent.event.author, sent.event.to, textOf(sent)], ["alice", "bob", "hello"]);
  assert.deepEqual((await bob.events({ chat: "alice", limit: 1 }))[0], sent);
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

await test("search prints each match with its author, chat, time, a stretch of its text and its link, and --in keeps to one chat", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  await alice.publish("#backend", "channel.join", {});
  await bob.publish("#backend", "channel.join", {});
  const said = await alice.publish("#backend", "message", { text: "the retry lives in queue.py", via: "cli" });
  const mine = await bob.publish("alice", "message", { text: "and the retry limit?", via: "cli" });

  const found = await playerTwo(hub, "bob", ["search", "retry"]);
  assert.equal(found.status, 0, found.err);
  assert.match(found.out, new RegExp(`┌ ${String(said.seq)} · alice in #backend · ${WHEN}\n│ the retry lives in queue\\.py\n└ ${noteLink(said.event.id)}`));
  assert.match(found.out, new RegExp(`┌ ${String(mine.seq)} · bob to alice · ${WHEN}\n│ and the retry limit\\?\n└ ${noteLink(mine.event.id)}`)); // His own message in a direct chat says whom it went to.
  const json = z.array(z.strictObject({ seq: z.int(), event: eventSchema, snippet: z.array(z.strictObject({ text: z.string(), hit: z.boolean() })), trusted: z.boolean(), link: z.string() }));
  const inChannel = json.parse(printed(await playerTwo(hub, "bob", ["search", "retry", "queue", "--in", "#backend", "--json"])));
  assert.deepEqual(
    inChannel.map((match) => [match.seq, match.trusted, match.link, match.snippet.filter((piece) => piece.hit).map((piece) => piece.text)]),
    [[said.seq, true, noteLink(said.event.id), ["retry", "queue"]]]
  );
  assert.equal((await playerTwo(hub, "bob", ["search", "nothing", "like", "this"])).out, "nothing found");
  assert.equal((await playerTwo(hub, "bob", ["search"])).status, 2);
});
