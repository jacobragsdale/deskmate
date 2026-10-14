/** Two people's sessions against the real hub, started in this process: the check that the client and the hub still speak the same protocol, and that each sees what the other does. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { authHeader, loadKey, signEvent } from "../src/core/sign.ts";
import { AgentCancelledError, http, join as joinHub, loadClient } from "../src/desk/client.ts";
import type { Client } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import { createHub } from "../src/hub/app.ts";
import type { Arrival, ChatView, MessageView, Notice } from "../src/shared/ipc.ts";
import { startHub as hubOfItsOwn } from "./startHub.ts";

const TOKEN = "a-join-token-for-tests";
const COMMIT = "c0ffee".padEnd(40, "0"); // The commit every checkout here is said to be at.
const root = mkdtempSync(join(tmpdir(), "player-two-app-"));

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Wait until something is true of what a session shows, and return it. */
async function until<T>(session: Session, what: string, find: (view: ChatView) => T | undefined | false): Promise<T> {
  for (let tries = 0; tries < 200; tries += 1) {
    const found = find(session.view());
    if (found !== undefined && found !== false) {
      return found;
    }
    await pause(50);
  }
  throw new Error(`never happened: ${what}\n${JSON.stringify(session.view().current, null, 1)}`);
}

/** Lay down just enough of a git checkout for the scan to read: its origin and what HEAD points at. */
function checkout(dev: string, name: string): string {
  const git = join(dev, name, ".git");
  mkdirSync(git, { recursive: true });
  writeFileSync(join(git, "config"), `[remote "origin"]\n\turl = https://dev.azure.com/acme/Platform/_git/${name}\n`);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  return join(dev, name);
}

interface Person {
  readonly client: Client;
  readonly session: Session;
  readonly arrivals: Arrival[];
  readonly notices: Notice[];
  readonly prompts: string[][]; // What the agent command was run with, last argument the prompt.
}

async function person(hub: string, name: string): Promise<Person> {
  const home = join(root, `home-${name}`);
  const dev = join(root, `dev-${name}`);
  checkout(dev, "uploader");
  await joinHub(home, hub, name, TOKEN, "fake-agent --flag", http);
  const client = loadClient(home, http, () => Date.now() / 1000);
  assert.ok(client !== null);
  const arrivals: Arrival[] = [];
  const notices: Notice[] = [];
  const prompts: string[][] = [];
  const session = new Session(
    client,
    dev,
    {
      changed: () => undefined,
      notice: (notice) => {
        notices.push(notice);
      },
      arrived: (arrival) => {
        arrivals.push(arrival);
      },
      confirmClone: () => Promise.resolve(false)
    },
    {
      presence: 1,
      describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: true }),
      runner: (argv, cwd, cancel) => {
        prompts.push([...argv]);
        if (argv.at(-1)?.endsWith("take your time") === true) {
          // An agent that never finishes on its own: it ends when its owner stops it.
          return new Promise((_resolve, reject) => {
            cancel.addEventListener("abort", () => {
              reject(new AgentCancelledError("stopped"));
            });
          });
        }
        return Promise.resolve(`Retries live in ${cwd.slice(root.length)}/queue.py`);
      }
    }
  );
  session.start();
  return { client, session, arrivals, notices, prompts };
}

function messages(view: ChatView): readonly MessageView[] {
  return view.current?.messages ?? [];
}

/** What one session shows of a message. */
function shownTo(session: Session, id: string): MessageView | undefined {
  return messages(session.view()).find((message) => message.id === id);
}

/** Bob takes a request back before jacob has acted on it: jacob's buttons go, and asking to run it now runs nothing. Returns the request's id. */
async function takingBack(jacob: Person, bob: Person): Promise<string> {
  const ran = jacob.prompts.length;
  await bob.session.handle({ do: "send", chat: "jacob", text: "@jacob/uploader never mind this one" });
  const { id } = await until(jacob.session, "the request bob will take back", (view) =>
    messages(view).find((message) => message.body.endsWith("never mind this one") && message.requests[0]?.status.kind === "ready")
  );
  await bob.session.handle({ do: "withdraw", id, owner: "jacob", repo: "uploader" });
  await until(jacob.session, "jacob's buttons gone", () => shownTo(jacob.session, id)?.requests[0]?.status.kind === "withdrawn");
  await jacob.session.handle({ do: "run", id, repo: "uploader", post: true });
  await pause(200);
  assert.deepEqual([jacob.prompts.length, shownTo(bob.session, id)?.requests[0]?.status], [ran, { kind: "withdrawn" }]);
  await assert.rejects(bob.session.handle({ do: "withdraw", id, owner: "jacob", repo: "uploader" }), /still waiting/);
  return id;
}

/** A reaction and an edit from one appear for the other, nobody can edit what someone else wrote, and a reply sits under its message for both, and says so once deleted. */
async function reactingEditingAndReplying(jacob: Person, bob: Person, id: string): Promise<void> {
  await jacob.session.handle({ do: "react", id, emoji: "👍", on: true });
  await until(bob.session, "bob sees jacob's reaction", () => shownTo(bob.session, id)?.reactions.length === 1);
  assert.deepEqual(shownTo(bob.session, id)?.reactions, [{ emoji: "👍", people: ["jacob"] }]);
  await bob.session.handle({ do: "edit", id, text: "never mind this one, sorry" });
  await until(jacob.session, "jacob sees bob's edit", () => shownTo(jacob.session, id)?.edited === true);
  assert.equal(shownTo(jacob.session, id)?.body, "never mind this one, sorry");
  await assert.rejects(jacob.session.handle({ do: "edit", id, text: "forged" }), /only your own messages/);
  await jacob.session.handle({ do: "react", id, emoji: "👍", on: false });
  await until(bob.session, "the reaction taken back", () => shownTo(bob.session, id)?.reactions.length === 0);

  await jacob.session.handle({ do: "reply", root: id, text: "no problem" });
  const thread = await until(bob.session, "bob sees the reply in its thread", () => shownTo(bob.session, id)?.replyCount === 1 && shownTo(bob.session, id));
  assert.deepEqual(
    thread.replies.map((reply) => [reply.sender, reply.body]),
    [["jacob", "no problem"]]
  );
  await jacob.session.handle({ do: "delete", id: thread.replies[0]?.id ?? "" });
  await until(bob.session, "bob sees the reply deleted", () => shownTo(bob.session, id)?.replies[0]?.deleted === true);
  assert.equal(shownTo(bob.session, id)?.replies[0]?.body, "");
}

/** Bob's identity posts a kind neither has heard of: it changes nothing jacob sees, and what comes after it still arrives. */
async function aKindNeitherKnows(jacob: Person, bob: Person, hub: string, about: string): Promise<void> {
  const shown = messages(jacob.session.view());
  const path = "/events";
  const now = Math.floor(Date.now() / 1000);
  const key = loadKey(readFileSync(join(root, "home-bob", "key"), "utf8").trim());
  const unknown = signEvent(key, { author: "bob", to: "jacob", kind: "some.later.kind", content: '{"text":"@jacob/uploader run this"}', ts: now, refs: [about] });
  const posted = await fetch(hub + path, { method: "POST", headers: { Authorization: authHeader(key, "bob", now, "POST", path), "Content-Type": "application/json" }, body: JSON.stringify(unknown) });
  assert.equal(posted.status, 201);
  await bob.session.handle({ do: "send", chat: "jacob", text: "still here" });
  await until(jacob.session, "the message after the unknown kind", (view) => messages(view).at(-1)?.body === "still here");
  assert.deepEqual(messages(jacob.session.view()).slice(0, -1), shown);
}

/** The hub in this process, or the one PLAYER_TWO_TEST_HUB names: a container from the image, say, started with TOKEN as its join token and PLAYER_TWO_REPOS=https://dev.azure.com/acme/. */
async function startHub(): Promise<{ readonly url: string; readonly close: () => Promise<unknown> }> {
  const given = process.env["PLAYER_TWO_TEST_HUB"] ?? "";
  if (given !== "") {
    return { url: given, close: () => Promise.resolve() };
  }
  const server = createHub({ joinToken: TOKEN, db: join(root, "hub.db"), repos: "https://dev.azure.com/acme/", downloads: "" });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const close = (): Promise<unknown> =>
    new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  return { url: `http://127.0.0.1:${String(address.port)}`, close };
}

await test("two people, their agents and a channel, through the real hub", { timeout: 60_000 }, async () => {
  const { url: hub, close } = await startHub();
  const people: Person[] = [];
  after(async () => {
    await Promise.all(people.map((each) => each.session.stop()));
    await close();
    rmSync(root, { recursive: true, force: true });
  });

  const jacob = await person(hub, "jacob");
  const bob = await person(hub, "bob");
  people.push(jacob, bob);

  // Each sees the other, here now, and both have shared their checkout of uploader.
  await until(jacob.session, "jacob sees bob and both uploaders", (view) => view.rows.some((row) => row.chat === "bob" && row.here === true) && view.team.length === 2);
  await until(bob.session, "bob's chat with jacob opens", (view) => view.current?.chat === "jacob" && view.myRepos.includes("uploader"));

  // Bob tags Jacob's agent: nothing runs, Bob sees it waiting, Jacob is told and can run it.
  jacob.session.attend(false);
  await bob.session.handle({ do: "send", chat: "jacob", text: "@jacob/uploader does your retry change handle 429s?" });
  const waiting = await until(bob.session, "bob sees his request waiting", (view) => messages(view).find((message) => message.requests[0]?.status.kind === "waiting"));
  assert.deepEqual(waiting.requests[0]?.status, { kind: "waiting", away: false });
  const asked = await until(jacob.session, "jacob can run it", (view) => messages(view).find((message) => message.requests[0]?.status.kind === "ready"));
  assert.deepEqual(asked.requests, [{ id: asked.id, owner: "jacob", repo: "uploader", mine: true, accepted: null, status: { kind: "ready", before: "", canDecline: true } }]);
  assert.equal(jacob.prompts.length, 0);
  await until(jacob.session, "the message counts as unread and waiting while jacob looks away", (view) => view.unread === 1 && view.waiting === 1);
  assert.deepEqual(
    jacob.arrivals.map((arrival) => [arrival.title, arrival.forMe, arrival.rings]),
    [["bob tagged your uploader agent", true, true]]
  );
  jacob.session.attend(true);
  assert.equal(jacob.session.view().unread, 0);

  // Jacob runs it for review: the agent gets the command's own words plus the prompt, in his checkout, and its answer waits as a draft.
  await jacob.session.handle({ do: "run", id: asked.id, repo: "uploader", post: false });
  const draft = await until(jacob.session, "the draft is ready", (view) => view.current?.drafts[0]);
  assert.equal(draft.text, "Retries live in /dev-jacob/uploader/queue.py");
  assert.deepEqual(jacob.prompts[0]?.slice(0, 2), ["fake-agent", "--flag"]);
  assert.match(jacob.prompts[0][2] ?? "", /bob, a teammate, tagged you in a direct chat with bob .* jacob will review/);
  await until(bob.session, "bob still sees nothing posted", (view) => messages(view).length === 1);

  // He edits it and sends it: Bob sees the answer, marked as the agent's, with the branch it ran on, and the request is settled.
  await jacob.session.handle({ do: "sendDraft", chat: "bob", id: asked.id, repo: "uploader", text: `${draft.text} (edited)` });
  const answer = await until(bob.session, "bob sees the answer", (view) => messages(view).find((message) => message.agent === "uploader"));
  assert.deepEqual(
    { ...answer, id: "", seq: 0, ts: 0 },
    {
      id: "",
      seq: 0,
      ts: 0,
      sender: "jacob",
      agent: "uploader",
      branch: "main ±",
      commit: COMMIT,
      trusted: true,
      body: "Retries live in /dev-jacob/uploader/queue.py (edited)",
      edited: false,
      deleted: false,
      reactions: [],
      quote: "bob: @jacob/uploader does your retry change handle 429s?",
      header: true,
      requests: [],
      replyCount: 0,
      replies: []
    }
  );
  await until(bob.session, "the request under bob's message is settled", (view) => messages(view).every((message) => message.requests.length === 0));
  assert.equal(jacob.session.view().busy.unsent, 0);

  // Jacob tags his own agent from his own window: it runs at once and posts without a draft.
  await jacob.session.handle({ do: "send", chat: "bob", text: "@jacob/uploader and the tests?" });
  await until(bob.session, "the own-tag answer is posted", (view) => messages(view).filter((message) => message.agent === "uploader").length === 2);
  assert.match(jacob.prompts[1]?.[2] ?? "", /jacob tagged you in a direct chat with bob .* nobody reviewing it first/);
  assert.match(jacob.prompts[1]?.[2] ?? "", /Earlier messages in this chat/);

  // His own tag sent any other way waits for his click, wherever it came from: here, from the command line, and in what his desk loads when it starts again.
  await jacob.client.publish("bob", "message", { text: "@jacob/uploader from the command line", via: "cli" });
  const ready = { kind: "ready", before: "", canDecline: false };
  const fromCommand = (view: ChatView): MessageView | undefined => messages(view).find((message) => message.body === "@jacob/uploader from the command line");
  await until(jacob.session, "the command line's tag waiting for jacob", (view) => fromCommand(view)?.requests[0]?.status.kind === "ready");
  const restarted = await person(hub, "jacob");
  people.push(restarted);
  await until(restarted.session, "the same tag waiting after a restart", (view) => fromCommand(view)?.requests[0]?.status.kind === "ready");
  await pause(300);
  assert.deepEqual([fromCommand(jacob.session.view())?.requests[0]?.status, fromCommand(restarted.session.view())?.requests[0]?.status], [ready, ready]);
  assert.deepEqual([jacob.prompts.length, restarted.prompts.length], [2, 0]);
  await restarted.session.stop();

  // A declined request says so to the asker.
  await bob.session.handle({ do: "send", chat: "jacob", text: "@jacob/uploader one more" });
  const second = await until(jacob.session, "the second request arrives", (view) =>
    messages(view).find((message) => message.body.endsWith("one more") && message.requests[0]?.status.kind === "ready")
  );
  await jacob.session.handle({ do: "decline", id: second.id, repo: "uploader" });
  await until(bob.session, "bob sees it declined", (view) => messages(view).some((message) => message.requests[0]?.status.kind === "declined"));

  // A run its owner stops is reported as stopped, and leaves no draft.
  await bob.session.handle({ do: "send", chat: "jacob", text: "@jacob/uploader take your time" });
  const slow = await until(jacob.session, "the slow request arrives", (view) =>
    messages(view).find((message) => message.body.endsWith("take your time") && message.requests[0]?.status.kind === "ready")
  );
  await jacob.session.handle({ do: "run", id: slow.id, repo: "uploader", post: false });
  const working = await until(bob.session, "bob sees it working, on the branch it reported", (view) =>
    messages(view).find((message) => message.requests[0]?.status.kind === "working" && message.requests[0].status.branch === "main ±")
  );
  assert.deepEqual(working.requests[0]?.accepted, { branch: "main", commit: COMMIT, dirty: true }); // Where its owner let it run.
  assert.equal(jacob.session.view().busy.working, 1);
  await jacob.session.handle({ do: "stop", id: slow.id, repo: "uploader" });
  await until(bob.session, "bob sees it stopped", (view) => messages(view).some((message) => message.requests[0]?.status.kind === "stopped"));
  await until(jacob.session, "jacob can run it again", (view) => messages(view).some((message) => message.requests[0]?.status.kind === "ready" && message.requests[0].status.before === "stopped"));
  assert.deepEqual(jacob.session.view().busy, { working: 0, unsent: 0 });

  const later = await takingBack(jacob, bob);
  await reactingEditingAndReplying(jacob, bob, later);
  await aKindNeitherKnows(jacob, bob, hub, later);

  // A channel, pinned to a repo: both are members and both have it.
  await jacob.session.handle({ do: "joinChannel", name: "backend" });
  await jacob.session.handle({ do: "pin", chat: "#backend", repo: "uploader" });
  await jacob.session.handle({ do: "send", chat: "#backend", text: "who owns the uploader?" });
  await until(bob.session, "bob can join it", (view) => view.otherChannels.some((channel) => channel.name === "#backend"));
  await bob.session.handle({ do: "joinChannel", name: "#backend" });
  const channel = await until(bob.session, "bob is in the channel with its earlier message", (view) => (view.current?.chat === "#backend" && messages(view).length === 1 ? view.current : undefined));
  assert.deepEqual([channel.members, channel.joined, channel.pinned], [["bob", "jacob"], true, { name: "uploader", have: 2, mine: true }]);
  assert.deepEqual(
    channel.lines.map((line) => [line.who, line.did, line.repo]),
    [
      ["jacob", "joined", ""],
      ["jacob", "pinned", "uploader"],
      ["bob", "joined", ""]
    ]
  );
  await bob.session.handle({ do: "leaveChannel", chat: "#backend" });
  assert.ok(!bob.session.view().rows.some((row) => row.chat === "#backend"));

  assert.deepEqual(
    [...jacob.notices, ...bob.notices].filter((notice) => notice.severity === "error"),
    []
  );
});

await test("a session loads each chat's newest page when it starts, and the page before that when asked", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const alice = await hub.join("alice");
  const bob = await hub.join("bob");
  for (let count = 1; count <= 60; count += 1) {
    await alice.publish("bob", "message", { text: `message ${String(count)}`, via: "cli" });
  }
  const session = new Session(bob, join(hub.dir, "dev"), { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) }, { presence: 1 });
  session.start();
  t.after(() => session.stop());
  const shown = (view: ChatView): readonly [number, string | undefined, boolean | undefined] => [messages(view).length, messages(view)[0]?.body, view.current?.hasOlder];

  assert.deepEqual(shown(await until(session, "the newest page", (view) => messages(view).length > 0 && view)), [50, "message 11", true]);
  await session.handle({ do: "older" });
  assert.deepEqual(shown(session.view()), [60, "message 1", false]);
  await session.handle({ do: "older" }); // Nothing before the first: nothing is asked for.
  assert.deepEqual(shown(session.view()), [60, "message 1", false]);
});

await test("an agent whose run cannot be told to the chat does not start", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const alice = await hub.join("alice");
  const bob = await hub.join("bob");
  const dev = join(hub.dir, "dev-bob");
  checkout(dev, "uploader");
  const notices: Notice[] = [];
  let ran = 0;
  const hooks = {
    changed: () => undefined,
    notice: (notice: Notice) => {
      notices.push(notice);
    },
    arrived: () => undefined,
    confirmClone: () => Promise.resolve(false)
  };
  const options = {
    presence: 1,
    describe: () => Promise.reject(new Error("git cannot say which commit it is at")),
    runner: () => {
      ran += 1;
      return Promise.resolve("done");
    }
  };
  const session = new Session(bob, dev, hooks, options);
  session.start();
  t.after(() => session.stop());

  const { event } = await alice.publish("bob", "message", { text: "@bob/uploader go", via: "cli" });
  await until(session, "the request", (view) => messages(view).find((message) => message.id === event.id)?.requests[0]?.status.kind === "ready");
  await session.handle({ do: "run", id: event.id, repo: "uploader", post: true });
  await until(session, "told it did not start", () => notices.length > 0);
  assert.deepEqual(notices, [{ title: "your uploader agent did not start", body: "git cannot say which commit it is at", severity: "error" }]);
  assert.equal(ran, 0);
  assert.deepEqual(
    (await alice.events({ chat: "bob" })).map((delivered) => delivered.event.kind),
    ["message"]
  ); // Nothing was said in the chat: as far as anyone can tell, it was never accepted.
});
