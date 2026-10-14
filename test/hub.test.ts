/** Two people's sessions against the real hub, started in this process: the check that the client and the hub still speak the same protocol. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { AgentCancelledError, http, join as joinHub, loadClient } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import { createHub } from "../src/hub/app.ts";
import type { Arrival, ChatView, MessageView, Notice } from "../src/shared/ipc.ts";

const TOKEN = "a-join-token-for-tests";
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
      describe: () => Promise.resolve({ branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: true }),
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
  return { session, arrivals, notices, prompts };
}

function messages(view: ChatView): readonly MessageView[] {
  return view.current?.messages ?? [];
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
  assert.deepEqual(asked.requests, [{ id: asked.id, owner: "jacob", repo: "uploader", mine: true, status: { kind: "ready", before: "", canDecline: true } }]);
  assert.equal(jacob.prompts.length, 0);
  await until(jacob.session, "the note counts as unread and waiting while jacob looks away", (view) => view.unread === 1 && view.waiting === 1);
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
      trusted: true,
      body: "Retries live in /dev-jacob/uploader/queue.py (edited)",
      quote: "bob: @jacob/uploader does your retry change handle 429s?",
      header: true,
      requests: []
    }
  );
  await until(bob.session, "the request under bob's note is settled", (view) => messages(view).every((message) => message.requests.length === 0));
  assert.equal(jacob.session.view().busy.unsent, 0);

  // Jacob tags his own agent from his own window: it runs at once and posts without a draft.
  await jacob.session.handle({ do: "send", chat: "bob", text: "@jacob/uploader and the tests?" });
  await until(bob.session, "the own-tag answer is posted", (view) => messages(view).filter((message) => message.agent === "uploader").length === 2);
  assert.match(jacob.prompts[1]?.[2] ?? "", /jacob tagged you in a direct chat with bob .* nobody reviewing it first/);
  assert.match(jacob.prompts[1]?.[2] ?? "", /Earlier messages in this chat/);

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
  await until(bob.session, "bob sees it working, on the branch it reported", (view) =>
    messages(view).some((message) => message.requests[0]?.status.kind === "working" && message.requests[0].status.branch === "main ±")
  );
  assert.equal(jacob.session.view().busy.working, 1);
  await jacob.session.handle({ do: "stop", id: slow.id, repo: "uploader" });
  await until(bob.session, "bob sees it stopped", (view) => messages(view).some((message) => message.requests[0]?.status.kind === "stopped"));
  await until(jacob.session, "jacob can run it again", (view) => messages(view).some((message) => message.requests[0]?.status.kind === "ready" && message.requests[0].status.before === "stopped"));
  assert.deepEqual(jacob.session.view().busy, { working: 0, unsent: 0 });

  // A channel, pinned to a repo: both are members and both have it.
  await jacob.session.handle({ do: "joinChannel", name: "backend" });
  await jacob.session.handle({ do: "pin", chat: "#backend", repo: "uploader" });
  await jacob.session.handle({ do: "send", chat: "#backend", text: "who owns the uploader?" });
  await until(bob.session, "bob can join it", (view) => view.otherChannels.some((channel) => channel.name === "#backend"));
  await bob.session.handle({ do: "joinChannel", name: "#backend" });
  const channel = await until(bob.session, "bob is in the channel with its earlier note", (view) => (view.current?.chat === "#backend" && messages(view).length === 1 ? view.current : undefined));
  assert.deepEqual([channel.members, channel.joined, channel.pinned], [["bob", "jacob"], true, { name: "uploader", have: 2, mine: true }]);
  await bob.session.handle({ do: "leaveChannel", chat: "#backend" });
  assert.ok(!bob.session.view().rows.some((row) => row.chat === "#backend"));

  assert.deepEqual(
    [...jacob.notices, ...bob.notices].filter((notice) => notice.severity === "error"),
    []
  );
});
