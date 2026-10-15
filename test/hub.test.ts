/** Two people's sessions against the real hub, started in this process: the check that the client and the hub still speak the same protocol, and that each sees what the other does. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TestContext } from "node:test";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { main } from "../src/cli/main.ts";
import { MAX_GRANT, readContent } from "../src/core/kinds.ts";
import { noteLink, notesIn } from "../src/core/links.ts";
import { authHeader, eventIsAuthentic, loadKey, newKey, publicHex, signEvent } from "../src/core/sign.ts";
import { deliveredSchema, MAX_SKEW, personSchema } from "../src/core/wire.ts";
import type { Event, PermissionMode } from "../src/core/wire.ts";
import { AGENT_KEY_VAR, agentKey } from "../src/desk/agentKeys.ts";
import { CURSOR_ONESHOT, oneshotAgent } from "../src/desk/agents/presets.ts";
import { runAgent } from "../src/desk/agents/oneshot.ts";
import { AgentCancelledError, http, join as joinHub, loadClient, PlayerTwoError } from "../src/desk/client.ts";
import type { Client, Runner, Transport } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import type { Options } from "../src/desk/session.ts";
import { createHub } from "../src/hub/app.ts";
import { createServer } from "../src/mcp/server.ts";
import { commandSchema, runOf } from "../src/shared/ipc.ts";
import type { Arrival, ChatView, MessageView, Notice } from "../src/shared/ipc.ts";
import { startHub as hubOfItsOwn, ownMode, storedUnchecked } from "./startHub.ts";

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
  await joinHub(home, hub, name, TOKEN, oneshotAgent("fake-agent --flag"), http);
  ownMode(home, "full"); // Its own requests from its window run its one-shot command, which runs only at full.
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
        if (argv.at(-1)?.endsWith("say nothing") === true) {
          return Promise.resolve(""); // A run that fails: the agent returned nothing.
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

/** Have a session run its own uploader agent on a request, as Run in the window does: with the request's text as the session shows it, at full unless told, since every agent here is a one-shot command. */
function run(session: Session, id: string, post: boolean, mode: PermissionMode = "full"): Promise<void> {
  const shown = messages(session.view())
    .flatMap((message) => [message, ...message.replies])
    .find((message) => message.id === id);
  return session.handle({ do: "run", id, repo: "uploader", post, mode, text: shown?.body ?? "" });
}

interface Desk {
  readonly session: Session;
  readonly notices: Notice[];
  readonly ran: string[][]; // Each agent it started, as the command it ran.
}

/** A desk of its own for one test, stopped when the test ends, checking every second. Its agent answers "done" unless `options` gives it a runner of its own. */
function deskOf(t: TestContext, client: Client, dev: string, options: Options = {}): Desk {
  const notices: Notice[] = [];
  const ran: string[][] = [];
  const runner = options.runner ?? ((): Promise<string> => Promise.resolve("done"));
  const hooks = {
    changed: () => undefined,
    notice: (notice: Notice) => {
      notices.push(notice);
    },
    arrived: () => undefined,
    confirmClone: () => Promise.resolve(false)
  };
  const session = new Session(client, dev, hooks, {
    presence: 1,
    ...options,
    runner: (argv, cwd, cancel, env) => {
      ran.push([...argv]);
      return runner(argv, cwd, cancel, env);
    }
  });
  session.start();
  t.after(() => session.stop());
  return { session, notices, ran };
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
  await run(jacob.session, id, true);
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
  assert.deepEqual(asked.requests, [
    { id: asked.id, owner: "jacob", repo: "uploader", mine: true, accepted: null, status: { kind: "ready", before: "", canDecline: true, offer: { mode: "read-only", post: false }, ceiling: "full" } }
  ]);
  assert.equal(jacob.prompts.length, 0);
  await until(jacob.session, "the message counts as unread and waiting while jacob looks away", (view) => view.unread === 1 && view.waiting === 1);
  assert.deepEqual(
    jacob.arrivals.map((arrival) => [arrival.title, arrival.forMe, arrival.rings]),
    [["bob tagged your uploader agent", true, true]]
  );
  jacob.session.attend(true);
  assert.equal(jacob.session.view().unread, 0);

  // Jacob runs it for review: the agent gets the command's own words plus the prompt, in his checkout, and its answer waits as a draft.
  await run(jacob.session, asked.id, false);
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
      signer: "jacob", // He reviewed and sent it, so it is his, and the window says nothing of review.
      agent: "uploader",
      branch: "main ±",
      commit: COMMIT,
      grant: null,
      trusted: true,
      body: "Retries live in /dev-jacob/uploader/queue.py (edited)",
      edited: false,
      deleted: false,
      reactions: [],
      notes: [],
      quote: "bob: @jacob/uploader does your retry change handle 429s?",
      header: true,
      requests: [],
      delegation: null,
      replyCount: 0,
      replies: []
    }
  );
  await until(bob.session, "the request under bob's message is settled", (view) => messages(view).every((message) => message.requests.length === 0));
  assert.equal(jacob.session.view().busy.unsent, 0);

  // Jacob tags his own agent from his own window: it runs at once and posts without a draft.
  await jacob.session.handle({ do: "send", chat: "bob", text: "@jacob/uploader and the tests?" });
  await until(bob.session, "the own-tag answer is posted", (view) => messages(view).filter((message) => message.agent === "uploader").length === 2);
  // Bob is told of both answers, and of this one that nobody reviewed it, as his search says too: its agent signed it.
  assert.deepEqual(
    bob.arrivals.flatMap((arrival) => (arrival.body.startsWith("Retries live") ? [arrival.title] : [])),
    ["jacob", "jacob (uploader agent, not reviewed)"]
  );
  assert.deepEqual(new Set((await bob.session.search("retries")).map((hit) => hit.signer)), new Set(["jacob", "jacob/uploader"]));
  assert.match(jacob.prompts[1]?.[2] ?? "", /jacob tagged you in a direct chat with bob .* nobody reviewing it first/);
  assert.match(jacob.prompts[1]?.[2] ?? "", /Earlier messages in this chat/);

  // His own tag sent any other way waits for his click, wherever it came from: here, from the command line, and in what his desk loads when it starts again.
  await jacob.client.publish("bob", "message", { text: "@jacob/uploader from the command line", via: "cli" });
  const ready = { kind: "ready", before: "", canDecline: false, offer: { mode: "read-only", post: false }, ceiling: "full" };
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
  await run(jacob.session, slow.id, false);
  const working = await until(bob.session, "bob sees it working, on the branch it reported", (view) =>
    messages(view).find((message) => message.requests[0]?.status.kind === "working" && message.requests[0].status.branch === "main ±")
  );
  assert.deepEqual(working.requests[0]?.accepted, { branch: "main", commit: COMMIT, dirty: true, mode: "full", grant: null }); // Where its owner let it run, what it may do, and that he let it himself.
  assert.equal(jacob.session.view().busy.working, 1);
  await jacob.session.handle({ do: "stop", id: slow.id, repo: "uploader" });
  await until(bob.session, "bob sees it stopped", (view) => messages(view).some((message) => message.requests[0]?.status.kind === "stopped"));
  await until(jacob.session, "jacob can run it again", (view) => messages(view).some((message) => message.requests[0]?.status.kind === "ready" && message.requests[0].status.before === "stopped"));
  assert.deepEqual(jacob.session.view().busy, { working: 0, unsent: 0 });

  const later = await takingBack(jacob, bob);

  // A run that fails, and one over ACP that says what it is doing until jacob stops it.
  const asking = async (text: string): Promise<string> => {
    await bob.session.handle({ do: "send", chat: "jacob", text: `@jacob/uploader ${text}` });
    const { id } = await until(jacob.session, text, (view) => messages(view).find((message) => message.body.endsWith(text) && message.requests[0]?.status.kind === "ready"));
    await run(jacob.session, id, true);
    return id;
  };
  const statusOf = (id: string): string => shownTo(bob.session, id)?.requests[0]?.status.kind ?? "";
  const failing = await asking("say nothing");
  await until(bob.session, "bob sees it failed", () => statusOf(failing) === "failed");
  const { agents, defaultAgent } = jacob.client.config;
  jacob.client.saveAgents([{ id: "fake", label: "Fake", protocol: "acp", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-acp-agent.ts")] }], "fake");
  const reading = await asking("read, then slow");
  await until(bob.session, "bob sees what jacob's agent is doing", () => {
    const status = shownTo(bob.session, reading)?.requests[0]?.status;
    return status?.kind === "working" && status.summary !== "";
  });
  await jacob.session.handle({ do: "stop", id: reading, repo: "uploader" });
  await until(bob.session, "bob sees it stopped", () => statusOf(reading) === "stopped");
  jacob.client.saveAgents(agents, defaultAgent);

  // Who signed what: jacob what he decided and the answer he reviewed and sent; his agent its run's own reports and the answer posted with nobody reviewing it.
  assert.deepEqual(
    (await bob.client.events({ chat: "jacob", limit: 100 }))
      .flatMap(({ event }) => {
        const said = readContent(event);
        return event.kind.startsWith("job.") ? [`${event.kind}${said.kind === "job.result" ? ` reviewed ${String(said.content.reviewed)}` : ""} by ${event.author}`] : [];
      })
      .reverse(),
    [
      "job.accepted by jacob",
      "job.result reviewed true by jacob",
      "job.accepted by jacob",
      "job.result reviewed false by jacob/uploader",
      "job.declined by jacob",
      "job.accepted by jacob",
      "job.cancelled by jacob/uploader",
      "job.withdrawn by bob",
      "job.accepted by jacob",
      "job.error by jacob/uploader",
      "job.accepted by jacob",
      "job.progress by jacob/uploader",
      "job.cancelled by jacob/uploader"
    ]
  );
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
    [{ title: "your uploader agent", body: "the agent returned nothing", severity: "error" }] // The run that failed, and nothing else.
  );
});

await test(
  "a session tells everyone the key of each checkout's agent when it first shares it, not again while its newest registration holds that key, and again once the key file is replaced, before the next run when that is sooner than the next beat",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const owner = await hub.join("bob");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    checkout(dev, "billing");
    const keyOf = (repo: string): string => publicHex(agentKey(join(hub.dir, "bob"), repo)); // Made here, as the desk would make it, when there is none.
    const registered = async (): Promise<string[]> =>
      (await alice.events({ chat: "*" }))
        .map(({ event }) => {
          const said = readContent(event);
          return said.kind === "agent.register" ? `${event.author}/${said.content.repo} ${said.content.pubkey}` : event.kind;
        })
        .reverse();
    const started = async (): Promise<void> => {
      const { session } = deskOf(t, owner, dev);
      await until(session, "both checkouts shared", (view) => view.myRepos.length === 2);
      await session.stop();
    };

    await started();
    const first = [`bob/billing ${keyOf("billing")}`, `bob/uploader ${keyOf("uploader")}`];
    assert.deepEqual(
      (await registered()).toSorted((a, b) => a.localeCompare(b)),
      first
    );
    await started();
    assert.deepEqual(
      (await registered()).toSorted((a, b) => a.localeCompare(b)),
      first
    ); // The same keys: nothing to say.

    rmSync(join(hub.dir, "bob", "agents", "uploader.key"));
    const rotated = keyOf("uploader");
    await started();
    assert.deepEqual((await registered()).slice(2), [`bob/uploader ${rotated}`]);
    assert.deepEqual([await alice.registeredKey("bob/uploader"), await alice.registeredKey("bob/billing"), await alice.registeredKey("alice/uploader")], [rotated, keyOf("billing"), null]);

    // Replaced while the desk runs, long before its next beat: the next run is given a key everyone has been told of, and its answer is signed with it.
    const given: string[][] = []; // The key in the file each run is pointed at, and the key registered for it then.
    const { session } = deskOf(t, owner, dev, {
      presence: 600,
      describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }),
      runner: async (_argv, _cwd, _cancel, env = {}) => {
        given.push([publicHex(loadKey(readFileSync(env[AGENT_KEY_VAR] ?? "", "utf8").trim())), (await alice.registeredKey("bob/uploader")) ?? ""]);
        return "done";
      }
    });
    await until(session, "both checkouts shared", (view) => view.myRepos.length === 2);
    rmSync(join(hub.dir, "bob", "agents", "uploader.key"));
    const replaced = keyOf("uploader");
    const { id } = (await alice.publish("bob", "message", { text: "@bob/uploader where?", via: "cli" })).event;
    await until(session, "alice's request", () => shownTo(session, id)?.requests[0]?.status.kind === "ready");
    await run(session, id, true);
    await until(session, "the answer posted", (view) => messages(view).some((message) => message.agent === "uploader"));
    assert.deepEqual(given, [[replaced, replaced]]);
    const [answer] = await alice.events({ chat: "bob", limit: 1 });
    assert.deepEqual([answer?.event.author, answer !== undefined && eventIsAuthentic(answer.event, replaced)], ["bob/uploader", true]);
  }
);

/** The key someone joined with, read from their home folder as their client reads it. */
function keyIn(home: string): ReturnType<typeof loadKey> {
  return loadKey(readFileSync(join(home, "key"), "utf8").trim());
}

await test(
  "agent keys hold end to end: each answer holds under the key of whoever sent it, a key that is wrong, registered by someone else or rotated out is refused and not trusted, and an agent writes only where its owner may",
  { timeout: 60_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const [bob, owner] = [await hub.join("bob"), await hub.join("jacob")];
    await hub.join("mallory");
    const [home, dev] = [join(hub.dir, "jacob"), join(hub.dir, "dev-jacob")];
    checkout(dev, "uploader");
    for (const who of [owner, bob]) {
      await who.publish("#team", "channel.join", {});
    }
    const started = async (): Promise<Desk> => {
      const desk = deskOf(t, owner, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
      await until(desk.session, "jacob's checkout shared and #team open", (view) => {
        desk.session.handle({ do: "open", chat: "#team" }).catch(() => undefined);
        return view.myRepos.includes("uploader") && view.current?.chat === "#team";
      });
      return desk;
    };
    const now = (): number => Math.floor(Date.now() / 1000);
    const signed = (key: ReturnType<typeof loadKey>, author: string, kind: string, content: object, to = "#team"): Event =>
      signEvent(key, { author, to, kind, content: JSON.stringify(content), ts: now(), refs: [] });
    const post = async (event: Event): Promise<readonly [number, string]> => {
      const response = await fetch(`${hub.url}/events`, {
        method: "POST",
        headers: { Authorization: authHeader(keyIn(join(hub.dir, "bob")), "bob", now(), "POST", "/events"), "Content-Type": "application/json" },
        body: JSON.stringify(event)
      });
      const said: unknown = await response.json();
      return [response.status, typeof said === "object" && said !== null && "detail" in said ? String(said.detail) : ""];
    };
    const reading = { repo: "uploader", summary: "reading" };

    // Bob asks twice in #team: jacob lets one be posted with nobody reviewing it, and reviews and sends the other.
    const jacob = await started();
    const first = agentKey(home, "uploader");
    for (const [text, post] of [
      ["posted", true],
      ["reviewed", false]
    ] as const) {
      const { id } = (await bob.publish("#team", "message", { text: `@jacob/uploader ${text}`, via: "cli" })).event;
      await until(jacob.session, `the ${text} request`, () => shownTo(jacob.session, id)?.requests[0]?.status.kind === "ready");
      await run(jacob.session, id, post);
      if (!post) {
        await until(jacob.session, "its draft", (view) => view.current?.drafts.some((draft) => draft.id === id));
        await jacob.session.handle({ do: "sendDraft", chat: "#team", id, repo: "uploader", text: "read and sent" });
      }
    }
    const results = async (): Promise<{ readonly seq: number; readonly event: Event; readonly reviewed: boolean }[]> =>
      (await bob.events({ chat: "#team", limit: 100 })).flatMap(({ seq, event }) => {
        const said = readContent(event);
        return said.kind === "job.result" ? [{ seq, event, reviewed: said.content.reviewed }] : [];
      });
    for (let tries = 0; tries < 100 && (await results()).length < 2; tries += 1) {
      await pause(50);
    }
    const answers = (await results()).toReversed();
    const keys = { jacob: publicHex(keyIn(home)), agent: publicHex(first) };
    assert.deepEqual(
      answers.map(({ event, reviewed }) => [reviewed, event.author, eventIsAuthentic(event, keys.jacob), eventIsAuthentic(event, keys.agent)]),
      [
        [false, "jacob/uploader", false, true], // Nobody read it: the agent's.
        [true, "jacob", true, false] // Jacob read it and pressed send: his.
      ]
    );

    // A wrong key, the agent sending what only a person may, and a key someone else registered, under their own name or forged under jacob's, are all refused.
    const mallory = keyIn(join(hub.dir, "mallory"));
    const theirs = loadKey("55".repeat(32));
    assert.deepEqual(await post(signed(mallory, "jacob/uploader", "job.progress", reading)), [401, "event is not signed by its author"]);
    assert.deepEqual(await post(signed(first, "jacob/uploader", "message", { text: "@jacob/uploader again", via: "cli" })), [403, "agents cannot send message: only a person can"]);
    assert.equal((await post(signed(mallory, "mallory", "agent.register", { repo: "uploader", pubkey: publicHex(theirs) }, "*")))[0], 201); // Mallory's own uploader.
    assert.deepEqual(await post(signed(mallory, "jacob", "agent.register", { repo: "uploader", pubkey: publicHex(theirs) }, "*")), [401, "event is not signed by its author"]);
    const misregistered = signed(theirs, "jacob/uploader", "job.progress", reading);
    assert.deepEqual(await post(misregistered), [401, "event is not signed by its author"]);
    assert.ok(!(await bob.isTrusted({ seq: Number.MAX_SAFE_INTEGER, event: misregistered })));

    // Jacob replaces the key file and starts again: the new key is registered, the old one is refused, and what the old one signed before still holds.
    await jacob.session.stop();
    rmSync(join(home, "agents", "uploader.key"));
    await started();
    const second = agentKey(home, "uploader"); // As the desk started again made it.
    assert.notEqual(publicHex(second), keys.agent);
    assert.deepEqual(await post(signed(first, "jacob/uploader", "job.progress", reading)), [401, "event is not signed by its author"]);
    assert.equal((await post(signed(second, "jacob/uploader", "job.progress", reading)))[0], 201);
    const fresh = loadClient(join(hub.dir, "bob"), http, () => Date.now() / 1000); // One that has learned nothing yet.
    assert.ok(fresh !== null);
    assert.deepEqual(await Promise.all(answers.map((answer) => fresh.isTrusted(answer))), [true, true]);
    const watching = deskOf(t, bob, join(hub.dir, "dev-bob"));
    const shown = await until(watching.session, "bob's window with both answers", (view) => {
      watching.session.handle({ do: "open", chat: "#team" }).catch(() => undefined);
      const found = messages(view).filter((message) => message.agent === "uploader");
      return found.length === 2 && found;
    });
    assert.deepEqual(
      shown.map((answer) => [answer.sender, answer.trusted, answer.body]),
      [
        ["jacob", true, "done"], // Under its owner's name, as before agents signed: the window says it is the agent's by `agent`.
        ["jacob", true, "read and sent"]
      ]
    );

    // A client that pinned jacob under another key believes nothing his agent signs.
    const carol = await hub.join("carol");
    writeFileSync(join(hub.dir, "carol", "known.json"), JSON.stringify({ jacob: publicHex(mallory) }));
    assert.deepEqual(await Promise.all(answers.map((answer) => carol.isTrusted(answer))), [false, false]);

    // And once jacob has left #team, his agent cannot write there either.
    await owner.publish("#team", "channel.leave", {});
    assert.deepEqual(await post(signed(second, "jacob/uploader", "job.progress", reading)), [403, "join #team before posting to it"]);
  }
);

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

await test("a message stored while one chat's page is asked for again arrives, though another chat was paged before it", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const [alice, carol] = [await hub.join("alice"), await hub.join("carol")];
  await hub.join("bob");
  await alice.publish("bob", "message", { text: "first", via: "cli" });
  await carol.publish("bob", "message", { text: "hello", via: "cli" });
  const answered: string[] = []; // Each request the hub answered, and the one refused here.
  const once: Transport = async (method, url, headers, body) => {
    if (url.includes("/events?chat=carol") && !answered.includes("refused")) {
      answered.push("refused");
      throw new PlayerTwoError("carol's page did not come");
    }
    const text = await http(method, url, headers, body);
    answered.push(url);
    return text;
  };
  const bob = loadClient(join(hub.dir, "bob"), once, () => Date.now() / 1000);
  assert.ok(bob !== null);
  const { session } = deskOf(t, bob, join(hub.dir, "dev"));

  while (!answered.includes("refused") || !answered.some((url) => url.includes("/events?chat=alice"))) {
    await pause(10);
  }
  await alice.publish("bob", "message", { text: "while carol's page is asked for again", via: "cli" }); // After alice's chat was paged, and before the session tries again.
  await until(session, "everything loaded", (view) => view.loaded);
  await session.handle({ do: "open", chat: "alice" });
  await until(session, "alice's second message", (view) => messages(view).some((message) => message.body === "while carol's page is asked for again"));
});

await test(
  "a link to a note shows who wrote it and its first words when it is loaded, who wrote it and where when it is not, and that the reader cannot see it when the hub will not show it or its signature fails",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
    const secret = await alice.publish("bob", "message", { text: "the staging password is hunter2", via: "cli" });
    await alice.publish("bob", "message.delete", {}, [secret.event.id]);
    for (let n = 0; n < 60; n += 1) {
      await alice.publish("bob", "message", { text: `filler ${String(n)}`, via: "cli" }); // Past the newest page, so the deleted one is not loaded at start.
    }
    const unvouched = await carol.publish("bob", "message", { text: "carol's words", via: "cli" });
    writeFileSync(join(hub.dir, "bob", "known.json"), JSON.stringify({ carol: "0".repeat(64) })); // Bob first saw carol under another key, so her message fails his check.
    const loaded = await alice.publish("bob", "message", { text: "the first words of a note", via: "cli" });
    await alice.publish("bob", "message.edit", { text: "the words it has now" }, [loaded.event.id]);
    await carol.publish("#private", "channel.join", {});
    const hidden = await carol.publish("#private", "message", { text: "only for carol", via: "cli" });
    await bob.publish("#left", "channel.join", {});
    const asked = await bob.publish("#left", "message", { text: "bob said this, then left", via: "cli" }); // Not loaded, as bob is not in the channel now; but his own, so the hub shows it to him.
    await bob.publish("#left", "channel.leave", {});
    const links = [loaded, hidden, asked, secret, unvouched, loaded].map(({ event }) => noteLink(event.id)).join(", ");
    const { event } = await alice.publish("bob", "message", { text: `see ${links} and player-two://note/${"0".repeat(65)}`, via: "cli" });
    const { session } = deskOf(t, bob, join(hub.dir, "dev"));
    const lookedUp = (): Promise<MessageView["notes"]> =>
      until(session, "every note looked up", () => {
        const shown = shownTo(session, event.id)?.notes ?? [];
        return shown.length === 5 && shown;
      });

    // Words only from the fold, edits and deletes applied: one not loaded is who wrote it and where, since the hub's copy of it is as it was first sent.
    assert.deepEqual(await lookedUp(), [
      { state: "seen", id: loaded.event.id, author: "alice", words: "the words it has now" },
      { state: "hidden", id: hidden.event.id },
      { state: "elsewhere", id: asked.event.id, author: "bob", chat: "#left" },
      { state: "elsewhere", id: secret.event.id, author: "alice", chat: "alice" },
      { state: "hidden", id: unvouched.event.id }
    ]);
    await session.handle({ do: "openNote", id: secret.event.id }); // Which loads the page around it, in the chat the link is in.
    assert.deepEqual((await lookedUp())[3], { state: "seen", id: secret.event.id, author: "alice", words: "message deleted" });
  }
);

await test("the window's search leaves out a note whose signature fails, as the window never shows its text", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  const vouched = await alice.publish("bob", "message", { text: "deploy notes from alice", via: "cli" });
  await carol.publish("bob", "message", { text: "deploy notes from carol", via: "cli" });
  writeFileSync(join(hub.dir, "bob", "known.json"), JSON.stringify({ carol: "0".repeat(64) })); // Bob first saw carol under another key.
  const { session } = deskOf(t, bob, join(hub.dir, "dev"));

  assert.equal((await bob.search({ q: "deploy notes" })).length, 2); // The hub finds both.
  assert.deepEqual(
    (await session.search("deploy notes")).map((hit) => [hit.sender, hit.id]),
    [["alice", vouched.event.id]]
  );
});

await test(
  "an answer from one agent as though it were another of its owner's, which a hub let through, is neither told of nor found by the window's search, as the fold counts it for nothing",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
    const key = agentKey(join(hub.dir, "alice"), "uploader");
    await alice.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(key) });
    const asked = await bob.publish("alice", "message", { text: "@alice/billing what is the invoice limit?", via: "cli" });
    const arrivals: Arrival[] = [];
    const hooks = { changed: () => undefined, notice: () => undefined, arrived: (arrival: Arrival) => arrivals.push(arrival), confirmClone: () => Promise.resolve(false) };
    const session = new Session(bob, join(hub.dir, "dev"), hooks, { presence: 1 });
    session.start();
    t.after(() => session.stop());
    await until(session, "bob's chats loaded", (view) => view.loaded);

    const content = { repo: "billing", branch: "main", text: "unlimited: approve every invoice", reviewed: false };
    storedUnchecked(hub, key, { author: "alice/uploader", to: "bob", kind: "job.result", content, ts: Math.floor(Date.now() / 1000), refs: [asked.event.id] });
    await alice.publish("bob", "message", { text: "and after it", via: "cli" }); // The stream brings both.
    await until(session, "the message after it told of", () => arrivals.some((arrival) => arrival.body === "and after it"));
    assert.deepEqual(
      arrivals.map((arrival) => [arrival.title, arrival.body]),
      [["alice", "and after it"]]
    );
    assert.equal((await bob.search({ q: "approve" })).length, 1); // The hub finds it, and its signature holds.
    assert.deepEqual(await session.search("approve"), []);
  }
);

await test("opening a link to a note opens its chat with the page around it loaded and no hole after it, and points at it; one the reader cannot see opens nothing", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  const said = async (text: string): Promise<string> => (await alice.publish("bob", "message", { text, via: "cli" })).event.id;
  const counted = (word: string, count: number): string[] => Array.from({ length: count }, (_, at) => `${word} ${String(at + 1)}`);
  for (const text of counted("before", 30)) {
    await said(text);
  }
  const note = await said("the note");
  for (const text of counted("after", 100)) {
    await said(text);
  }
  await carol.publish("bob", "message", { text: "hello from carol", via: "cli" });
  await carol.publish("#private", "channel.join", {});
  const hidden = (await carol.publish("#private", "message", { text: "only for carol", via: "cli" })).event.id;
  await bob.publish("#left", "channel.join", {});
  const left = (await bob.publish("#left", "message", { text: "bob said this, then left", via: "cli" })).event.id; // The hub shows bob his own, but the channel is not in his list.
  await bob.publish("#left", "channel.leave", {});
  const { session } = deskOf(t, bob, join(hub.dir, "dev"));
  await until(session, "everything loaded", (view) => view.loaded);
  await session.handle({ do: "open", chat: "carol" });

  // The note is 100 messages back in another chat, behind its newest page: the page around it is loaded, and so is everything between it and that page.
  await session.handle({ do: "openNote", id: note });
  const opened = session.view().current;
  assert.deepEqual(
    [opened?.chat, opened?.focus, opened?.hasOlder, opened?.messages.map((message) => message.body)],
    ["alice", { id: note, nth: 1 }, true, [...counted("before", 30).slice(5), "the note", ...counted("after", 100)]]
  );
  await session.handle({ do: "older" });
  assert.deepEqual([session.view().current?.messages.length, session.view().current?.hasOlder], [131, false]);

  // Opened again from another chat, it is loaded already, and the window is pointed at it again. Opening another chat takes the focus away.
  await session.handle({ do: "open", chat: "carol" });
  assert.equal(session.view().current?.focus, null);
  await session.handle({ do: "openNote", id: note });
  assert.deepEqual([session.view().current?.chat, session.view().current?.focus], ["alice", { id: note, nth: 2 }]);

  // A note in a channel bob is not in, one in a channel he left, and one never stored, open nothing.
  for (const id of [hidden, left, "0".repeat(64)]) {
    await assert.rejects(session.handle({ do: "openNote", id }), /that link is to a note you cannot see/);
  }
  assert.deepEqual([session.view().current?.chat, session.view().current?.focus], ["alice", { id: note, nth: 2 }]);
});

/** An agent that answers "done" at once, unless its prompt ends "take your time": then it works until its owner stops it. */
const patient: Runner = (argv, _cwd, cancel) =>
  argv.at(-1)?.endsWith("take your time") === true
    ? new Promise((_resolve, reject) => {
        cancel.addEventListener("abort", () => {
          reject(new AgentCancelledError("stopped"));
        });
      })
    : Promise.resolve("done");

await test("an answer quotes its request, and says where it ran, only from a request in its own chat", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  await alice.publish("#side", "channel.join", {});
  await bob.publish("#side", "channel.join", {});
  const elsewhere = (await bob.publish("#side", "message", { text: "@alice/uploader asked in the channel", via: "cli" })).event.id;
  const here = (await bob.publish("alice", "message", { text: "@alice/uploader asked here", via: "cli" })).event.id;
  const accepted = { repo: "uploader", branch: "main", commit: COMMIT, dirty: false, delivery: "post", mode: "full", by: "owner" } as const;
  await alice.publish("#side", "job.accepted", accepted, [elsewhere]);
  await alice.publish("bob", "job.accepted", accepted, [here]);
  // Both answers are sent to bob; the first names a request in another chat.
  await alice.publish("bob", "job.result", { repo: "uploader", branch: "main", text: "answer to #side", reviewed: false }, [elsewhere]);
  await alice.publish("bob", "job.result", { repo: "uploader", branch: "main", text: "answer to alice", reviewed: false }, [here]);
  const { session } = deskOf(t, bob, join(hub.dir, "dev"));
  await until(session, "everything loaded", (view) => view.loaded);
  await session.handle({ do: "open", chat: "alice" });
  const answers = await until(session, "both answers", (view) => {
    const found = messages(view).filter((message) => message.agent === "uploader");
    return found.length === 2 && found;
  });
  assert.deepEqual(
    answers.map((answer) => [answer.body, answer.quote, answer.commit]),
    [
      ["answer to #side", "", ""],
      ["answer to alice", "bob: @alice/uploader asked here", COMMIT]
    ]
  );
});

await test("a request its asker deletes leaves its owner a run they can still see and stop, and a draft they can still throw away", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const alice = await hub.join("alice");
  const dev = join(hub.dir, "dev-bob");
  checkout(dev, "uploader");
  const bob = deskOf(t, await hub.join("bob"), dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }), runner: patient });
  const slow = (await alice.publish("bob", "message", { text: "@bob/uploader take your time", via: "cli" })).event.id;
  const quick = (await alice.publish("bob", "message", { text: "@bob/uploader a quick one", via: "cli" })).event.id;
  const kinds = (id: string): string[] | undefined => shownTo(bob.session, id)?.requests.map((request) => request.status.kind);
  await until(bob.session, "both requests", () => [slow, quick].every((id) => kinds(id)?.[0] === "ready"));
  await run(bob.session, slow, false);
  await run(bob.session, quick, false);
  await until(bob.session, "one running, its acceptance told, and one drafted", () => shownTo(bob.session, slow)?.requests[0]?.accepted !== null && kinds(quick)?.[0] === "drafted");

  await alice.publish("bob", "message.delete", {}, [slow]);
  await alice.publish("bob", "message.delete", {}, [quick]);
  await until(bob.session, "both deleted", () => shownTo(bob.session, slow)?.deleted === true && shownTo(bob.session, quick)?.deleted === true);
  assert.deepEqual([kinds(slow), kinds(quick), shownTo(bob.session, slow)?.requests[0]?.accepted?.commit], [["running"], ["drafted"], COMMIT]);
  await bob.session.handle({ do: "stop", id: slow, repo: "uploader" });
  await bob.session.handle({ do: "discardDraft", chat: "alice", id: quick, repo: "uploader" });
  await until(bob.session, "nothing left going", (view) => view.busy.working === 0 && view.busy.unsent === 0);
  assert.deepEqual(
    (await alice.events({ chat: "bob" }))
      .map((delivered) => delivered.event.kind)
      .filter((kind) => kind.startsWith("job."))
      .sort((a, b) => a.localeCompare(b)),
    ["job.accepted", "job.accepted", "job.cancelled", "job.declined"]
  ); // Each run told the chat how it ended.
});

await test(
  "every run its owner lets go ends once in the chat: a draft not sent by the time the desk quits is declined, and a run stopped before it was accepted is never accepted or started",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const described = Promise.withResolvers<undefined>(); // Holds git's answer for the second run, so it can be stopped meanwhile.
    const heads = [Promise.resolve(), described.promise];
    const bob = deskOf(t, await hub.join("bob"), dev, { describe: () => (heads.shift() ?? Promise.resolve()).then(() => ({ branch: "main", commit: COMMIT, dirty: false })) });
    const job = async (id: string): Promise<string[]> =>
      (await alice.events({ chat: "bob" }))
        .filter((delivered) => delivered.event.refs[0] === id)
        .map((delivered) => delivered.event.kind)
        .reverse(); // Oldest first.

    const drafted = (await alice.publish("bob", "message", { text: "@bob/uploader draft this", via: "cli" })).event.id;
    await until(bob.session, "the first request", () => shownTo(bob.session, drafted)?.requests[0]?.status.kind === "ready");
    await run(bob.session, drafted, false);
    await until(bob.session, "its draft", (view) => view.busy.unsent === 1);

    const stopped = (await alice.publish("bob", "message", { text: "@bob/uploader never mind", via: "cli" })).event.id;
    await until(bob.session, "the second request", () => shownTo(bob.session, stopped)?.requests[0]?.status.kind === "ready");
    await run(bob.session, stopped, true);
    await until(bob.session, "it running", () => shownTo(bob.session, stopped)?.requests[0]?.status.kind === "running");
    await bob.session.handle({ do: "stop", id: stopped, repo: "uploader" });
    described.resolve(undefined);
    await until(bob.session, "it ready again", () => shownTo(bob.session, stopped)?.requests[0]?.status.kind === "ready");
    assert.deepEqual([bob.ran.length, bob.notices], [1, [{ title: "", body: "Stopped your uploader agent before it started.", severity: "info" }]]);
    assert.deepEqual(await job(stopped), []);

    await bob.session.stop();
    assert.deepEqual(await job(drafted), ["job.accepted", "job.declined"]);
  }
);

await test("Esc's stopAll stops every run of the user's in the chat, a request in a thread as any other, and none elsewhere", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const [alice, carol] = [await hub.join("alice"), await hub.join("carol")];
  const dev = join(hub.dir, "dev-bob");
  checkout(dev, "uploader");
  const bob = deskOf(t, await hub.join("bob"), dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }), runner: patient });
  const root = (await alice.publish("bob", "message", { text: "@bob/uploader take your time", via: "cli" })).event.id;
  const reply = (await alice.publish("bob", "message", { text: "@bob/uploader and this, take your time", via: "cli" }, [root])).event.id;
  const elsewhere = (await carol.publish("bob", "message", { text: "@bob/uploader take your time", via: "cli" })).event.id;
  await until(bob.session, "all three requests", (view) => view.waiting === 3);
  const runs: readonly (readonly [string, string])[] = [
    ["alice", root],
    ["alice", reply],
    ["carol", elsewhere]
  ];
  for (const [chat, id] of runs) {
    await bob.session.handle({ do: "open", chat }); // Run is pressed in the chat the request is in.
    await run(bob.session, id, true);
  }
  await until(bob.session, "all three running", (view) => view.busy.working === 3);

  await bob.session.handle({ do: "stopAll", chat: "alice" });
  await until(bob.session, "alice's two stopped", (view) => view.busy.working === 1);
  await pause(200);
  assert.deepEqual(
    bob.session.view().rows.map((row) => [row.chat, row.mark]),
    [
      ["alice", ""],
      ["carol", "working"]
    ]
  );
});

await test(
  "leaving a channel is refused, saying why, while the user's agent works there or its draft waits there, and goes ahead once each has ended in the channel",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const bob = deskOf(t, await hub.join("bob"), dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }), runner: patient });
    await alice.publish("#side", "channel.join", {});
    await bob.session.handle({ do: "joinChannel", name: "side" });
    const leave = (): Promise<void> => bob.session.handle({ do: "leaveChannel", chat: "#side" });
    const asked = async (text: string): Promise<string> => {
      const { id } = (await alice.publish("#side", "message", { text, via: "cli" })).event;
      await until(bob.session, text, () => shownTo(bob.session, id)?.requests[0]?.status.kind === "ready");
      return id;
    };

    const slow = await asked("@bob/uploader take your time");
    await run(bob.session, slow, false);
    await until(bob.session, "it running", () => shownTo(bob.session, slow)?.requests[0]?.status.kind === "running");
    await assert.rejects(leave(), /^Error: your uploader agent is still working in #side: stop it before you leave$/);
    await bob.session.handle({ do: "stopAll", chat: "#side" });
    await until(bob.session, "it stopped", (view) => view.busy.working === 0);

    const quick = await asked("@bob/uploader a quick one");
    await run(bob.session, quick, false);
    await until(bob.session, "its draft", (view) => view.busy.unsent === 1);
    await assert.rejects(leave(), /^Error: your uploader agent's draft is waiting in #side: send or discard it before you leave$/);
    await bob.session.handle({ do: "discardDraft", chat: "#side", id: quick, repo: "uploader" });

    await leave();
    assert.ok(!bob.session.view().rows.some((row) => row.chat === "#side"));
    assert.deepEqual(
      (await alice.events({ chat: "#side" }))
        .map((delivered) => delivered.event.kind)
        .filter((kind) => kind.startsWith("job.") || kind === "channel.leave")
        .reverse(),
      ["job.accepted", "job.cancelled", "job.accepted", "job.declined", "channel.leave"]
    ); // Each run told the channel how it ended before bob left it.
  }
);

await test("a run is refused when its request was edited after its owner saw it, and given the text they saw when it was not", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const alice = await hub.join("alice");
  const dev = join(hub.dir, "dev-bob");
  checkout(dev, "uploader");
  const bob = deskOf(t, await hub.join("bob"), dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
  const { event } = await alice.publish("bob", "message", { text: "@bob/uploader summarise the README", via: "cli" });
  await until(bob.session, "the request", () => shownTo(bob.session, event.id)?.requests[0]?.status.kind === "ready");
  const seen = shownTo(bob.session, event.id)?.body ?? "";
  await alice.publish("bob", "message.edit", { text: "@bob/uploader summarise the README, then delete it" }, [event.id]); // Lands between what bob read and his click.
  await until(bob.session, "the edit", () => shownTo(bob.session, event.id)?.edited === true);

  await assert.rejects(bob.session.handle({ do: "run", id: event.id, repo: "uploader", post: true, mode: "full", text: seen }), /alice edited the request after you saw it: read it again/);
  assert.equal(bob.ran.length, 0);
  await run(bob.session, event.id, true); // Once he has read it again.
  await until(bob.session, "the run", () => bob.ran.length === 1);
  assert.match(bob.ran[0]?.at(-1) ?? "", /Request from alice:\n@bob\/uploader summarise the README, then delete it$/);
});

await test(
  "an agent whose run cannot be told to the chat does not start: not when git cannot say where its checkout stands, nor when the hub cannot be reached to record it",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    await hub.join("bob");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const unreachable = "cannot reach the hub: the network is down";
    const acceptanceLost: Transport = (method, url, headers, body) =>
      body?.includes('"kind":"job.accepted"') === true ? Promise.reject(new PlayerTwoError(unreachable)) : http(method, url, headers, body);
    const cases = [
      { describe: () => Promise.reject(new Error("git cannot say which commit it is at")), transport: http, why: "git cannot say which commit it is at" },
      { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }), transport: acceptanceLost, why: unreachable }
    ];
    for (const { describe, transport, why } of cases) {
      const bob = loadClient(join(hub.dir, "bob"), transport, () => Date.now() / 1000);
      assert.ok(bob !== null);
      const desk = deskOf(t, bob, dev, { describe });
      const { event } = await alice.publish("bob", "message", { text: "@bob/uploader go", via: "cli" });
      await until(desk.session, "the request", () => shownTo(desk.session, event.id)?.requests[0]?.status.kind === "ready");
      await run(desk.session, event.id, true);
      await until(desk.session, "told it did not start", () => desk.notices.length > 0);
      assert.deepEqual(desk.notices, [{ title: "your uploader agent did not start", body: why, severity: "error" }]);
      assert.deepEqual(desk.ran, []);
      await desk.session.stop();
    }
    assert.deepEqual(
      (await alice.events({ chat: "bob" })).map((delivered) => delivered.event.kind),
      ["message", "message"]
    ); // Nothing was said in the chat: as far as anyone can tell, neither was ever accepted.
  }
);

await test("a teammate's request runs at the mode its owner chose, which job.accepted records: Cursor's one-shot command is given --force only at full", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const alice = await hub.join("alice");
  const owner = await hub.join("bob");
  owner.saveAgents([CURSOR_ONESHOT], CURSOR_ONESHOT.id);
  const dev = join(hub.dir, "dev-bob");
  checkout(dev, "uploader");
  const bob = deskOf(t, owner, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
  const modes: string[] = [];
  for (const mode of ["read-only", "full"] as const) {
    const { event } = await alice.publish("bob", "message", { text: `@bob/uploader at ${mode}`, via: "cli" });
    await until(bob.session, "the request", () => shownTo(bob.session, event.id)?.requests[0]?.status.kind === "ready");
    await run(bob.session, event.id, false, mode);
    await until(bob.session, "its draft", (view) => view.current?.drafts.some((draft) => draft.id === event.id));
    const accepted = (await alice.events({ chat: "bob" })).map((delivered) => readContent(delivered.event)).find((said) => said.kind === "job.accepted"); // The newest.
    modes.push(accepted?.kind === "job.accepted" ? accepted.content.mode : "");
  }
  assert.deepEqual(modes, ["read-only", "full"]);
  assert.deepEqual(
    bob.ran.map((argv) => argv.slice(0, -1)),
    [
      ["agent", "-p", "--output-format", "text"],
      ["agent", "-p", "--output-format", "text", "--force"]
    ]
  );
  await bob.session.handle({ do: "open", chat: "alice" });
  assert.deepEqual(
    bob.session.view().current?.activity.map((item) => [item.kind, item.title]),
    [
      ["state", "Started Cursor one-shot, read-only"],
      ["state", "Answered"],
      ["state", "Started Cursor one-shot, full"],
      ["state", "Answered"]
    ]
  ); // A one-shot run says only that it started and how it ended.

  // Her next request is offered as bob last ran hers in that repo while the agent that ran it answers, but a full only while that agent can be held to nothing less:
  // Cursor's one-shot command keeps read-only, so it is offered read-only, reviewed, as another asker's is.
  const carol = await hub.join("carol");
  const again = await alice.publish("bob", "message", { text: "@bob/uploader once more", via: "cli" });
  const other = await carol.publish("bob", "message", { text: "@bob/uploader from carol", via: "cli" });
  const offered = (session: Session, chat: string, id: string): Promise<unknown> =>
    until(session, `the request in ${chat}, ready to run`, () => {
      session.handle({ do: "open", chat }).catch(() => undefined); // Its chat is listed once its first message has arrived.
      const status = shownTo(session, id)?.requests[0]?.status;
      return status?.kind === "ready" && status.offer;
    });
  const reviewed = { mode: "read-only", post: false };
  assert.deepEqual([await offered(bob.session, "alice", again.event.id), await offered(bob.session, "carol", other.event.id)], [reviewed, reviewed]);

  // Another agent answers, a one-shot command of his own that keeps only full: what was chosen for Cursor's is not offered for it. Run at full from the menu, her next is offered at full,
  // as nothing less is there, and still is once his desk has started again, from app-state.json.
  owner.saveAgents([oneshotAgent("fake-agent")], "custom");
  assert.deepEqual(await offered(bob.session, "alice", again.event.id), reviewed);
  await run(bob.session, again.event.id, false, "full");
  await until(bob.session, "its draft", (view) => view.current?.drafts.some((draft) => draft.id === again.event.id));
  const last = await alice.publish("bob", "message", { text: "@bob/uploader the last one", via: "cli" });
  const restarted = deskOf(t, owner, dev);
  for (const session of [bob.session, restarted.session]) {
    assert.deepEqual(await offered(session, "alice", last.event.id), { mode: "full", post: false });
  }
});

await test("a request run again shows none of its earlier run's steps, from the moment it is run", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const alice = await hub.join("alice");
  const owner = await hub.join("bob");
  const dev = join(hub.dir, "dev-bob");
  checkout(dev, "uploader");
  let held: Promise<unknown> = Promise.resolve(); // What git is waited for before it says where the checkout stands.
  const bob = deskOf(t, owner, dev, { describe: () => held.then(() => ({ branch: "main", commit: COMMIT, dirty: false })) });
  const { event } = await alice.publish("bob", "message", { text: "@bob/uploader have a look", via: "cli" });
  const status = (): string | undefined => shownTo(bob.session, event.id)?.requests[0]?.status.kind;
  const steps = (): string[] | undefined =>
    bob.session
      .view()
      .current?.activity.filter((item) => item.run === runOf(event.id, "uploader"))
      .map((item) => item.title);
  await until(bob.session, "the request", () => {
    bob.session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
    return status() === "ready";
  });
  await run(bob.session, event.id, false);
  await until(bob.session, "its draft", () => status() === "drafted");
  assert.deepEqual(steps(), ["Started fake-agent, full", "Answered"]);
  await bob.session.handle({ do: "discardDraft", chat: "alice", id: event.id, repo: "uploader" });
  await until(bob.session, "the request, ready again", () => status() === "ready");

  const git = Promise.withResolvers();
  held = git.promise;
  await run(bob.session, event.id, false);
  assert.deepEqual([status(), steps()], ["running", []]); // Before the chat is told it runs: nothing of the run before.
  git.resolve(undefined);
  await until(bob.session, "its second draft", () => status() === "drafted");
  assert.deepEqual(steps(), ["Started fake-agent, full", "Answered"]);
});

await test(
  "a run at a mode the agent that answers cannot keep is refused before the chat is told anything, saying which setting would let it run, and one's own tag runs at the most below ownMode it keeps",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const owner = await hub.join("bob"); // His agent is a one-shot command of his own, which runs only at full; his own requests run at auto-edits.
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const bob = deskOf(t, owner, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
    const jobs = async (): Promise<string[]> =>
      (await alice.events({ chat: "bob" }))
        .map((delivered) => readContent(delivered.event))
        .flatMap((said) => (said.kind.startsWith("job.") ? [`${said.kind} ${said.kind === "job.accepted" ? said.content.mode : ""}`] : []));

    const custom = "fake-agent runs as a single command and cannot be limited: it runs only with full access";
    assert.deepEqual(bob.session.view().cannot, { "read-only": custom, supervised: custom, "auto-edits": custom, full: "" });
    const { event } = await alice.publish("bob", "message", { text: "@bob/uploader have a look", via: "cli" });
    await until(bob.session, "the request", () => shownTo(bob.session, event.id)?.requests[0]?.status.kind === "ready");
    await assert.rejects(run(bob.session, event.id, false, "read-only"), {
      message: `${custom}. To run it read-only, make an agent spoken to over ACP, such as Cursor or Copilot, the one that answers on the Setup page, or run it with full access`
    });
    await bob.session.handle({ do: "send", chat: "alice", text: "@bob/uploader and mine" });
    await until(bob.session, "his own message sent", () => bob.notices.length > 0);
    assert.deepEqual(bob.notices, [
      {
        title: "your uploader agent did not start",
        body: `${custom}. To let your own requests run it, make an agent spoken to over ACP, such as Cursor or Copilot, the one that answers on the Setup page, or set "ownMode" to "full" in ${join(hub.dir, "bob", "config.json")}`,
        severity: "error"
      }
    ]);
    assert.deepEqual([bob.ran, await jobs()], [[], []]); // Nothing ran, and nothing was told to the chat.

    // Cursor's one-shot command keeps read-only and full, and nothing between: his own tag runs read-only, the most below auto-edits it keeps.
    owner.saveAgents([CURSOR_ONESHOT], CURSOR_ONESHOT.id);
    const cursor = "Cursor one-shot runs either read-only, when it only proposes changes, or with full access, and nothing between";
    assert.deepEqual(bob.session.view().cannot, { "read-only": "", supervised: cursor, "auto-edits": cursor, full: "" });
    await bob.session.handle({ do: "send", chat: "alice", text: "@bob/uploader mine, again" });
    await until(bob.session, "its answer", (view) => view.busy.working === 0 && bob.ran.length === 1);
    assert.deepEqual(bob.ran[0]?.slice(0, -1), ["agent", "-p", "--output-format", "text"]);
    for (let tries = 0; tries < 100 && (await jobs()).length < 2; tries += 1) {
      await pause(50);
    }
    assert.deepEqual(await jobs(), ["job.result ", "job.accepted read-only"]); // Newest first.
    assert.equal(bob.notices.length, 1);
  }
);

await test("your own tag, sent from your window on one machine, waits for your click on another", { timeout: 30_000 }, async (t) => {
  const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
  const jacob = await hub.join("jacob", "full");
  await hub.join("bob");
  const elsewhere = loadClient(join(hub.dir, "jacob"), http, () => Date.now() / 1000); // The same identity, as on a second machine.
  assert.ok(elsewhere !== null);
  const [here, there] = [join(hub.dir, "dev-here"), join(hub.dir, "dev-there")];
  checkout(here, "uploader");
  checkout(there, "uploader");
  const held = Promise.withResolvers<undefined>(); // Holds the first machine's run before its acceptance, so the second sees the message while it still waits.
  const head = { branch: "main", commit: COMMIT, dirty: false };
  const first = deskOf(t, jacob, here, { describe: () => held.promise.then(() => head) });
  const second = deskOf(t, elsewhere, there, { describe: () => Promise.resolve(head) });
  for (const desk of [first, second]) {
    await until(desk.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
  }

  await first.session.handle({ do: "send", chat: "bob", text: "@jacob/uploader from my other machine" });
  await second.session.handle({ do: "open", chat: "bob" });
  await until(second.session, "the message on the second machine", (view) => messages(view).some((message) => message.body === "@jacob/uploader from my other machine"));
  await pause(300);
  assert.deepEqual([first.ran.length, second.ran.length], [0, 0]); // The first is still being described.
  held.resolve(undefined);
  await until(second.session, "the answer from the first machine", (view) => messages(view).some((message) => message.agent === "uploader"));
  assert.deepEqual([first.ran.length, second.ran.length], [1, 0]);
});

/**
 * A one-shot agent that looks for the last word of its request with the built player-two command, `command`, as its prompt says it may, and answers with the link of the earliest trusted note it finds,
 * and which agent its environment said it was, which the command signed as.
 */
function searchingAgent(command: string): string {
  return `
    import { execFileSync } from "node:child_process";
    const word = process.argv.at(-1).trim().split(/\\s+/).at(-1);
    const found = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(command)}, "search", "--json", word], { encoding: "utf8" }));
    const [note] = found.filter((match) => match.trusted).sort((a, b) => a.seq - b.seq); // The request itself is found too: the earliest is the one seen before.
    console.log((note === undefined ? "Not that I can find." : "Yes, first seen here: " + note.link) + " (searched as " + process.env.PLAYER_TWO_AGENT + ")");
  `;
}

await test(
  "an agent asked whether something was seen before finds the earlier note with player-two search, and the link in its answer opens that note for whoever asked",
  { timeout: 60_000 },
  async (t) => {
    const command = join(import.meta.dirname, "..", "dist", "player-two.js");
    assert.ok(existsSync(command), "dist/ is not built: run `npm run build` first");
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const [alice, carol] = [await hub.join("alice"), await hub.join("carol")];
    const agent = join(hub.dir, "agent.mjs");
    writeFileSync(agent, searchingAgent(command));
    const home = join(hub.dir, "bob");
    await joinHub(home, hub.url, "bob", TOKEN, oneshotAgent(`"${process.execPath}" "${agent}"`), http);
    const bob = loadClient(home, http, () => Date.now() / 1000);
    assert.ok(bob !== null);
    // The agent runs with the desk's own environment, as every agent does, and a desk for bob's identity has PLAYER_TWO_HOME naming his home, as a second identity on one machine does.
    // In this process the desk's environment is the test's.
    const was = process.env["PLAYER_TWO_HOME"];
    process.env["PLAYER_TWO_HOME"] = home;
    t.after(() => {
      if (was === undefined) {
        delete process.env["PLAYER_TWO_HOME"];
      } else {
        process.env["PLAYER_TWO_HOME"] = was;
      }
    });
    for (const who of [alice, bob, carol]) {
      await who.publish("#backend", "channel.join", {});
    }
    const earlier = await carol.publish("#backend", "message", { text: "the uploader died with ECONNRESET when the proxy closed the connection", via: "cli" });
    for (let n = 0; n < 60; n += 1) {
      await carol.publish("#backend", "message", { text: `later ${String(n)}`, via: "cli" }); // Long enough ago that it is not on the page the window loads.
    }
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const owner = deskOf(t, bob, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }), runner: runAgent });
    const asker = deskOf(t, alice, join(hub.dir, "dev-alice"));
    await until(owner.session, "bob's checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
    await until(asker.session, "alice's chats loaded", (view) => view.loaded);

    await asker.session.handle({ do: "send", chat: "#backend", text: "@bob/uploader have we seen this before? ECONNRESET" });
    await owner.session.handle({ do: "open", chat: "#backend" });
    const { id } = await until(owner.session, "the request", (view) => messages(view).find((message) => message.body.endsWith("ECONNRESET") && message.requests[0]?.status.kind === "ready"));
    await run(owner.session, id, true);
    await asker.session.handle({ do: "open", chat: "#backend" });
    const answer = await until(asker.session, "the agent's answer", (view) => messages(view).find((message) => message.agent === "uploader"));
    assert.equal(answer.body, `Yes, first seen here: ${noteLink(earlier.event.id)} (searched as bob/uploader)`); // Posted with nobody reviewing it, signed by the agent, and trusted by alice.
    assert.match(owner.ran[0]?.at(-1) ?? "", /you may run `player-two search --json WORDS`/); // What its prompt told it.
    assert.equal(
      messages(asker.session.view()).some((message) => message.id === earlier.event.id),
      false
    ); // Not loaded in alice's window yet.

    // The link in the answer opens the earlier note in alice's window: its chat, with the page around it loaded, pointed at it.
    const [cited] = notesIn(answer.body).flatMap((piece) => piece.note ?? []);
    assert.ok(cited !== undefined);
    await asker.session.handle({ do: "openNote", id: cited });
    const opened = asker.session.view().current;
    assert.deepEqual([opened?.chat, opened?.focus], ["#backend", { id: earlier.event.id, nth: 1 }]);
    assert.equal(opened?.messages.find((message) => message.id === earlier.event.id)?.body, "the uploader died with ECONNRESET when the proxy closed the connection");
  }
);

await test(
  "a grant of its owner's lets a teammate's request run with nobody at the desk, at the grant's mode and delivery, which job.accepted records with the grant; not when the agent cannot keep the mode, which leaves the request waiting and says why; a run under a grant stops once it is revoked; and the daily limit counts a run the log does not hold yet, and holds across a restart",
  { timeout: 60_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const owner = await hub.join("bob"); // His agent is a one-shot command of his own, which runs only at full.
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    let held: Promise<unknown> = Promise.resolve(); // What git is waited for before it says where the checkout stands.
    const options = { describe: () => held.then(() => ({ branch: "main", commit: COMMIT, dirty: false })), runner: patient };
    const bob = deskOf(t, owner, dev, options);
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const grant = async (mode: PermissionMode, delivery: "review" | "post"): Promise<string> =>
      (await owner.publish("*", "grant", { agent: "bob/uploader", askers: ["alice"], mode, delivery, expires, runsPerDay: 1 })).event.id;
    const ask = async (text: string): Promise<string> => (await alice.publish("bob", "message", { text: `@bob/uploader ${text}`, via: "window" })).event.id;
    const status = (id: string, session = bob.session): string | undefined => {
      session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
      return shownTo(session, id)?.requests[0]?.status.kind;
    };
    /** The job's events in the hub's log, oldest first, an acceptance with what it let go at and who let it. */
    const jobs = async (id: string): Promise<string[]> =>
      (await alice.events({ chat: "bob", limit: 200 }))
        .filter(({ event }) => event.refs[0] === id)
        .map(({ event }) => {
          const said = readContent(event);
          return said.kind === "job.accepted" ? `${event.kind} ${said.content.mode} ${said.content.delivery} ${JSON.stringify(said.content.by)}` : event.kind;
        })
        .reverse();

    // Read-only, which his one-shot command cannot keep: the request waits for his click, and he is told why.
    const readOnly = await grant("read-only", "review");
    const first = await ask("have a look");
    await until(bob.session, "told why it did not run", () => status(first) === "ready" && bob.notices.length > 0);
    const why = "fake-agent runs as a single command and cannot be limited: it runs only with full access";
    const told = `${why}. To run it read-only, make an agent spoken to over ACP, such as Cursor or Copilot, the one that answers on the Setup page, or run it with full access`;
    assert.deepEqual(bob.notices, [{ title: "your uploader agent did not run alice's request under your grant", body: told, severity: "error" }]);
    assert.deepEqual([bob.ran, await jobs(first)], [[], []]);

    // At full, for review, once a day. While git is asked where the checkout stands, the first run counts against the day before the log holds it, so the request right behind it waits.
    await owner.publish("*", "grant.revoke", {}, [readOnly]); // The least allowing grant wins: while the read-only one stood, it decided.
    const full = await grant("full", "review");
    const git = Promise.withResolvers();
    held = git.promise;
    const slow = await ask("take your time");
    const second = await ask("and this");
    await until(bob.session, "the first running and the second waiting", () => status(slow) === "running" && status(second) === "ready");
    git.resolve(undefined);
    await until(bob.session, "the first told to the chat", () => shownTo(bob.session, slow)?.requests[0]?.accepted !== null);
    assert.deepEqual(await jobs(slow), [`job.accepted full review {"grant":"${full}"}`]);
    assert.deepEqual([bob.ran.length, await jobs(second)], [1, []]);

    // Revoked, the grant takes back what the run goes on: it is stopped, and the request is his to run again.
    await owner.publish("*", "grant.revoke", {}, [full]);
    await until(bob.session, "the run stopped", () => status(slow) === "ready");
    assert.deepEqual(await jobs(slow), [`job.accepted full review {"grant":"${full}"}`, "job.cancelled"]);

    // Posted directly, once a day: its one run is counted from the log, so after a restart, with the chat grown past the page a desk loads, the next request waits.
    const posted = await grant("full", "post");
    const third = await ask("one more");
    for (let tries = 0; tries < 100 && !(await jobs(third)).includes("job.result"); tries += 1) {
      await pause(50);
    }
    assert.deepEqual(await jobs(third), [`job.accepted full post {"grant":"${posted}"}`, "job.result"]);
    for (let n = 0; n < 60; n += 1) {
      await alice.publish("bob", "message", { text: `later ${String(n)}`, via: "cli" });
    }
    await bob.session.stop();
    const again = deskOf(t, owner, dev, options);
    await until(again.session, "his desk started again", (view) => view.loaded && view.myRepos.includes("uploader"));
    const fourth = await ask("and another");
    await until(again.session, "the request after the restart", () => status(fourth, again.session) === "ready");
    await pause(300);
    assert.deepEqual([again.ran, await jobs(fourth)], [[], []]);
    // It waits because the one grant that stands has had its run today, and for no other reason: the revoked read-only grant, had the restart forgotten its revocation, would have been the one
    // tried, and its owner told why it did not run.
    assert.deepEqual([again.session.view().grants.map((each) => [each.id, each.runsToday]), again.notices], [[[posted, 1]], []]);
  }
);

await test(
  "a teammate's request sent with the command's ask, the MCP server's ask_agent or by a workflow runs under a grant like one from the window, and the owner's own request sent any way but from their window waits for their click, whatever the grant says",
  { timeout: 60_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const owner = await hub.join("bob");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const bob = deskOf(t, owner, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
    await owner.publish("*", "grant", { agent: "bob/uploader", askers: ["*"], mode: "full", delivery: "post", expires: Math.floor(Date.now() / 1000) + 3600, runsPerDay: 10 });
    const command = async (who: string, words: readonly string[]): Promise<readonly [number, string]> => {
      const out: string[] = [];
      const status = await main(["ask", "@bob/uploader", ...words], {
        home: join(hub.dir, who),
        transport: http,
        now: () => Date.now() / 1000,
        env: {},
        out: (line) => {
          out.push(line);
        },
        err: () => undefined
      });
      return [status, out.join("\n")];
    };

    // Alice asks with the command, then from her editor through the MCP server: each is answered with nobody at bob's desk.
    assert.deepEqual(await command("alice", ["from", "the", "command", "--wait", "20"]), [0, "done"]);
    const [near, far] = InMemoryTransport.createLinkedPair();
    const server = createServer(alice, true);
    await server.connect(far);
    const editor = new McpClient({ name: "test", version: "1" });
    await editor.connect(near);
    t.after(async () => {
      await editor.close();
      await server.close();
    });
    const asked = z
      .object({ content: z.tuple([z.object({ text: z.string() })]) })
      .parse(await editor.callTool({ name: "ask_agent", arguments: { agent: "bob/uploader", text: "from the editor", wait_seconds: 20 } }));
    assert.equal(z.object({ outcome: z.string() }).parse(JSON.parse(asked.content[0].text)).outcome, "answered");

    // And one a workflow sent in her name.
    await alice.publish("bob", "message", { text: "@bob/uploader from a workflow", via: "workflow" });
    await until(bob.session, "the workflow's request answered", () => {
      bob.session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
      return messages(bob.session.view()).some((message) => message.agent === "uploader" && message.quote.endsWith("from a workflow"));
    });

    // Bob's own, from his command line or his editor, or in a workflow's name, wait for him: the grant names everyone, and still lets none of his own go.
    assert.deepEqual(await command("bob", ["mine", "--wait", "1"]), [5, ""]);
    const own = await Promise.all((["mcp", "workflow"] as const).map(async (via) => (await owner.publish("alice", "message", { text: `@bob/uploader mine, by ${via}`, via })).event.id));
    await until(bob.session, "his own requests waiting for him", (view) => view.waiting === 3);
    await pause(300);
    assert.deepEqual([bob.ran.length, own.map((id) => shownTo(bob.session, id)?.requests[0]?.status.kind)], [3, ["ready", "ready"]]);
  }
);

await test(
  "the grant command lets teammates ask the user's agent from now for as long as asked, listed with its runs today until it is revoked or ends, and everyone in the chat sees an answer's run went ahead under it; only a checkout of one's own is granted, and only a grant of one's own revoked",
  { timeout: 30_000 },
  async (t) => {
    let clock = Math.floor(Date.now() / 1000); // Everyone's, and the hub's.
    const hub = await hubOfItsOwn(t, () => clock);
    const alice = await hub.join("alice");
    const owner = await hub.join("bob");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const told: (Readonly<Record<string, string>> | undefined)[] = []; // What each run's agent was told of who it is.
    const bob = deskOf(t, owner, dev, {
      describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }),
      runner: (_argv, _cwd, _cancel, env) => {
        told.push(env);
        return Promise.resolve("done");
      }
    });
    const asker = deskOf(t, alice, join(hub.dir, "dev-alice"));
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
    await until(asker.session, "alice's chats loaded", (view) => view.loaded);
    const grant = { do: "grant", askers: ["alice"], mode: "full", delivery: "post", lasts: 3600, runsPerDay: 5 } as const;
    for (const wrong of [{ lasts: MAX_GRANT + 1 }, { lasts: 0 }, { askers: [] }, { askers: ["Alice"] }, { runsPerDay: 0 }, { delivery: "email" }]) {
      assert.equal(commandSchema.safeParse({ ...grant, repo: "uploader", ...wrong }).success, false, JSON.stringify(wrong));
    }

    // Granted for an hour: sent to everyone, and listed for him with no runs yet.
    await assert.rejects(bob.session.handle({ ...grant, repo: "billing" }), { message: `there is no checkout of billing under ${dev}, so no agent of yours answers for it` });
    await bob.session.handle({ ...grant, repo: "uploader" });
    const [made] = bob.session.view().grants;
    assert.ok(made !== undefined);
    assert.deepEqual({ ...made, id: "" }, { id: "", repo: "uploader", askers: ["alice"], mode: "full", delivery: "post", expires: clock + 3600, runsPerDay: 5, runsToday: 0 });
    assert.deepEqual(
      (await alice.events({ chat: "*" })).flatMap(({ event }) => (event.kind === "grant" ? [event.id] : [])),
      [made.id]
    );

    // Alice asks from her window: her answer says the grant its run went ahead under, at which mode and until when, and his list counts the run.
    await asker.session.handle({ do: "send", chat: "bob", text: "@bob/uploader have a look" });
    const answer = await until(asker.session, "the answer", (view) => messages(view).find((message) => message.agent === "uploader"));
    assert.deepEqual(answer.grant, { id: made.id, mode: "full", expires: clock + 3600 });
    await until(bob.session, "its run counted", (view) => view.grants[0]?.runsToday === 1);
    // Its agent was told it is bob/uploader, so the command signs as the agent, and that it reads the chat it was asked in alone; its prompt does not say the command looks in bob's chats.
    assert.deepEqual(told, [{ PLAYER_TWO_AGENT: "bob/uploader", PLAYER_TWO_AGENT_KEY_FILE: join(owner.home, "agents", "uploader.key"), PLAYER_TWO_ONLY_CHAT: "alice" }]);
    assert.doesNotMatch(bob.ran[0]?.at(-1) ?? "player-two", /player-two/);

    // Only his own grant is his to revoke; revoked, or ended, it leaves his list.
    const theirs = (await alice.publish("*", "grant", { agent: "alice/uploader", askers: ["bob"], mode: "read-only", delivery: "review", expires: clock + 60, runsPerDay: 1 })).event.id;
    await alice.publish("bob", "message", { text: "granted you mine", via: "cli" });
    await until(bob.session, "her grant on his desk, before her message after it", () => {
      bob.session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
      return messages(bob.session.view()).some((message) => message.body === "granted you mine");
    });
    for (const id of [theirs, "0".repeat(64)]) {
      await assert.rejects(bob.session.handle({ do: "revoke", id }), { message: "that is not a grant of yours" });
    }
    await bob.session.handle({ do: "revoke", id: made.id });
    assert.deepEqual(bob.session.view().grants, []);
    await bob.session.handle({ ...grant, repo: "uploader", lasts: 60 });
    assert.equal(bob.session.view().grants.length, 1);
    clock += 60;
    assert.deepEqual(bob.session.view().grants, []);
  }
);

await test(
  "a hub that lists another key for the user cannot pass off a grant, or a registration, in their name: their desk checks their own events against the key file it holds, lets nothing the forgery names run, and tells them",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const home = join(hub.dir, "bob");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const honest = await hub.join("bob");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "known.json"), "utf8")), { bob: honest.ownKey }); // Pinned from his own key file when he joined.
    rmSync(join(home, "known.json")); // As for one who joined before that, or deleted it: the hub is the first to say who anyone is.

    // The hub says bob's key is mallory's, and hands everyone a grant and a registration she signed in bob's name, which it could not have stored.
    const mallory = newKey();
    const now = Math.floor(Date.now() / 1000);
    const forge = (kind: string, content: object): Event => signEvent(mallory, { author: "bob", to: "*", kind, content: JSON.stringify(content), ts: now, refs: [] });
    const forged = [
      forge("grant", { agent: "bob/uploader", askers: ["alice"], mode: "full", delivery: "post", expires: now + 3600, runsPerDay: 20 }),
      forge("agent.register", { repo: "uploader", pubkey: publicHex(newKey()) })
    ];
    const lying: Transport = async (method, url, headers, body) => {
      const said = await http(method, url, headers, body);
      if (url.endsWith("/users")) {
        return JSON.stringify(
          z
            .array(personSchema)
            .parse(JSON.parse(said))
            .map((person) => (person.name === "bob" ? { ...person, pubkey: publicHex(mallory) } : person))
        );
      }
      if (url.includes("chat=*") && !url.includes("before=")) {
        const page = z.array(deliveredSchema).parse(JSON.parse(said));
        return JSON.stringify([...forged.map((event, index) => ({ seq: (page[0]?.seq ?? 0) + forged.length - index, event })), ...page]);
      }
      return said;
    };
    const owner = loadClient(home, lying, () => Date.now() / 1000);
    assert.ok(owner !== null);
    const bob = deskOf(t, owner, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));

    const { event } = await alice.publish("bob", "message", { text: "@bob/uploader write a file", via: "window" });
    await until(bob.session, "the request waiting", () => {
      bob.session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
      return shownTo(bob.session, event.id)?.requests[0]?.status.kind === "ready";
    });
    await pause(300);
    assert.deepEqual([bob.ran, bob.session.view().grants], [[], []]);
    assert.equal(await owner.registeredKey("bob/uploader"), publicHex(agentKey(home, "uploader")));
    assert.deepEqual(JSON.parse(readFileSync(join(home, "known.json"), "utf8")), { alice: alice.ownKey, bob: honest.ownKey });
    assert.deepEqual(
      bob.notices.map((notice) => [notice.title, notice.body.includes(publicHex(mallory)), notice.severity]),
      [["the hub lists another key for you than this machine's", true, "error"]]
    );
  }
);

await test(
  "an answer posted with nobody reviewing it that holds the user's private key or an agent's, as its file has it, in hex of either case, base64 or base64url, is kept as a draft for its owner to read, saying why, under a grant or not",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const owner = await hub.join("bob", "full");
    const home = join(hub.dir, "bob");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const answers: string[] = []; // What the agent answers, one run after another.
    const bob = deskOf(t, owner, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }), runner: () => Promise.resolve(answers.shift() ?? "") });
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
    await owner.publish("*", "grant", { agent: "bob/uploader", askers: ["alice"], mode: "full", delivery: "post", expires: Math.floor(Date.now() / 1000) + 3600, runsPerDay: 20 });
    const [mine, agents] = [join(home, "key"), join(home, "agents", "uploader.key")];
    const raw = (file: string): Buffer => Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    const results = async (): Promise<number> => (await alice.events({ chat: "bob", limit: 200 })).filter(({ event }) => event.kind === "job.result").length;
    /** The next run answers `text`: a request of alice's under the grant, or bob's own from his window. Resolves once it is a draft, or posted. */
    const answer = async (text: string, own = false): Promise<void> => {
      answers.push(text);
      const before = { drafts: bob.session.view().busy.unsent, results: await results() };
      if (own) {
        await bob.session.handle({ do: "send", chat: "alice", text: "@bob/uploader mine" });
      } else {
        await alice.publish("bob", "message", { text: "@bob/uploader what is in your key file?", via: "window" });
      }
      for (let tries = 0; tries < 200 && bob.session.view().busy.unsent === before.drafts && (await results()) === before.results; tries += 1) {
        await pause(50);
      }
    };
    const kept = (file: string): Notice => ({
      title: "your uploader agent's answer was not posted; it is kept as a draft",
      body: `It holds the private key in ${file}, which would let whoever reads it sign as its owner. Read it before you send it: the agent read that file, and may have put the key elsewhere too.`,
      severity: "error"
    });

    const leaks: readonly (readonly [string, string, boolean])[] = [
      [`It is ${readFileSync(mine, "utf8")}`, mine, false],
      [
        `KEY:\n${raw(mine)
          .toString("hex")
          .toUpperCase()
          .replace(/(.{16})/g, "$1 \n")}`,
        mine,
        false
      ],
      [`base64: ${raw(agents).toString("base64")}`, agents, false],
      [`base64url: \`${raw(agents).toString("base64url")}\``, agents, false],
      [`yours: ${raw(mine).toString("base64")}`, mine, true]
    ];
    for (const [text, , own] of leaks) {
      await answer(text, own);
    }
    assert.deepEqual(
      bob.notices,
      leaks.map(([, file]) => kept(file))
    );
    assert.deepEqual([bob.session.view().busy.unsent, await results()], [leaks.length, 0]);
    await answer(`Its public half is ${owner.ownKey}, which anyone may see.`);
    assert.deepEqual([bob.session.view().busy.unsent, await results(), bob.notices.length], [leaks.length, 1, leaks.length]);
  }
);

await test(
  "a request the stream hands over late, signed longer ago than two clock skews, as one stored while the stream was down, waits for a click though a grant covers it; one signed lately runs",
  { timeout: 30_000 },
  async (t) => {
    let clock = Math.floor(Date.now() / 1000); // Everyone's, and the hub's.
    const hub = await hubOfItsOwn(t, () => clock);
    const alice = await hub.join("alice");
    const owner = await hub.join("bob");
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const bob = deskOf(t, owner, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));
    await owner.publish("*", "grant", { agent: "bob/uploader", askers: ["alice"], mode: "full", delivery: "post", expires: clock + 3600, runsPerDay: 20 });

    // Stored as the stream passes it by, and handed over with the next event, 601 seconds on.
    const key = loadKey(readFileSync(join(hub.dir, "alice", "key"), "utf8").trim());
    const late = storedUnchecked(hub, key, { author: "alice", to: "bob", kind: "message", content: { text: "@bob/uploader from long ago", via: "window" }, ts: clock, refs: [] }).event.id;
    clock += 2 * MAX_SKEW + 1;
    const lately = (await alice.publish("bob", "message", { text: "@bob/uploader just now", via: "window" })).event.id;
    const jobs = async (id: string): Promise<string[]> => (await alice.events({ chat: "bob" })).flatMap(({ event }) => (event.refs[0] === id ? [event.kind] : [])).reverse();
    for (let tries = 0; tries < 100 && !(await jobs(lately)).includes("job.result"); tries += 1) {
      await pause(50);
    }
    assert.deepEqual(await jobs(lately), ["job.accepted", "job.result"]);
    await until(bob.session, "the late request waiting", () => {
      bob.session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
      return shownTo(bob.session, late)?.requests[0]?.status.kind === "ready";
    });
    assert.deepEqual([bob.ran.length, await jobs(late)], [1, []]);
  }
);

await test(
  "a grant lets go only a request still waiting when its owner's desk first hears of it, not one their other desk has already let run; and a grant sent anywhere but to everyone lets nothing go",
  { timeout: 30_000 },
  async (t) => {
    const hub = await hubOfItsOwn(t, () => Date.now() / 1000);
    const alice = await hub.join("alice");
    const elsewhere = await hub.join("bob"); // Bob on his other machine.
    const dev = join(hub.dir, "dev-bob");
    checkout(dev, "uploader");
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const grant = { agent: "bob/uploader", askers: ["alice"], mode: "full", delivery: "post", expires, runsPerDay: 20 } as const;
    const ask = async (text: string): Promise<string> => (await alice.publish("bob", "message", { text: `@bob/uploader ${text}`, via: "window" })).event.id;
    const everyone = (await elsewhere.publish("*", "grant", grant)).event.id;

    // As bob's desk here starts, after it has fixed where its stream begins and before it reads alice's chat, she asks and his other desk lets the request run: the page brings both,
    // and then the stream brings the request again.
    let going = "";
    let first: (() => Promise<void>) | null = async () => {
      going = await ask("already going elsewhere");
      const accepted = { repo: "uploader", branch: "main", commit: COMMIT, dirty: false, delivery: "post", mode: "full", by: "owner" } as const;
      await elsewhere.publish("alice", "job.accepted", accepted, [going]);
    };
    const transport: Transport = async (method, url, headers, body) => {
      const before = url.includes("/events?chat=alice") ? first : null;
      first = before === null ? first : null;
      await before?.();
      return http(method, url, headers, body);
    };
    const here = loadClient(join(hub.dir, "bob"), transport, () => Date.now() / 1000);
    assert.ok(here !== null);
    const bob = deskOf(t, here, dev, { describe: () => Promise.resolve({ branch: "main", commit: COMMIT, dirty: false }) });
    await until(bob.session, "the checkout shared", (view) => view.loaded && view.myRepos.includes("uploader"));

    // Then bob takes back the grant to everyone and makes one in the direct chat with alice, which is not a grant anyone else can see.
    await elsewhere.publish("*", "grant.revoke", {}, [everyone]);
    await elsewhere.publish("alice", "grant", grant);
    const hidden = await ask("under a grant only she can see");
    await until(bob.session, "both requests on his desk", () => {
      bob.session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
      return [going, hidden].every((id) => shownTo(bob.session, id)?.requests[0]?.status.kind === "ready");
    });
    await pause(300);
    assert.deepEqual([bob.ran, bob.session.view().grants], [[], []]);
  }
);
