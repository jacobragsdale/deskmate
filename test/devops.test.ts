/**
 * Azure DevOps in the chat, through sessions against a real hub and the fake Azure DevOps of test/fakeAzure.ts, which the desk is pointed at by the smoke test's address:
 * pull requests a message refers to, a branch room's pull request and build, and opening a pull request, with real git repositories, origin a folder git's configuration names in
 * place of dev.azure.com. The home folder and git's configuration are the test's own.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Client } from "../src/desk/client.ts";
import * as repos from "../src/desk/repos.ts";
import { Session } from "../src/desk/session.ts";
import type { Options } from "../src/desk/session.ts";
import { Database } from "../src/hub/db.ts";
import { commandSchema } from "../src/shared/ipc.ts";
import type { MessageView, Notice, Question } from "../src/shared/ipc.ts";
import { fakeAzure, platform } from "./fakeAzure.ts";
import type { Call, Project, Reply } from "./fakeAzure.ts";
import { checkout, ownHome, startHub, TEAM_REPOS } from "./startHub.ts";

ownHome();
const PAT = "a-personal-access-token";

// Origins on dev.azure.com are bare repositories in this folder, as git's configuration says for every git here, the desk's among them.
const REMOTES = mkdtempSync(join(tmpdir(), "player-two-remotes-"));
appendFileSync(process.env["GIT_CONFIG_GLOBAL"] ?? "", `[url "file://${REMOTES}/"]\n\tinsteadOf = https://dev.azure.com/acme/\n`);

// Every git the desk runs is this one, which notes its arguments in CALLS before running the real git: what is never called is seen not to be.
const SHIM = mkdtempSync(join(tmpdir(), "player-two-git-"));
const CALLS = join(SHIM, "calls");
writeFileSync(join(SHIM, "git"), `#!/bin/sh\necho "$*" >> '${CALLS}'\nexec ${execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()} "$@"\n`, { mode: 0o755 });
writeFileSync(CALLS, "");
process.env["PATH"] = `${SHIM}:${process.env["PATH"] ?? ""}`;

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}
const UPLOADER = { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: `${TEAM_REPOS}Platform/_git/uploader` };

/** Try `find` every 50 ms, for ten seconds, until it finds something. */
async function until<T>(what: string, find: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let tries = 0; tries < 200; tries += 1) {
    const found = await find();
    if (found !== undefined && found !== false) {
      return found;
    }
    await delay(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** The fake Azure DevOps, which every session made after this asks, with a token for it in the environment; `change` may change or hold back what it answers. */
async function azure(
  t: TestContext,
  change: (call: Call, reply: Reply | null) => Reply | null | Promise<Reply | null> = (_call, reply) => reply
): Promise<{ readonly calls: Call[]; readonly project: Project }> {
  const { project, answer } = platform(PAT);
  const fake = await fakeAzure(t, (call) => change(call, answer(call)));
  process.env["PLAYER_TWO_TEST_AZURE"] = fake.base;
  process.env["AZURE_DEVOPS_EXT_PAT"] = PAT;
  return { calls: fake.calls, project };
}

interface Desk {
  readonly session: Session;
  readonly notices: Notice[];
  readonly questions: Question[]; // What the user was asked in a dialog of the system's own.
  readonly reply: { yes: boolean }; // What they answer.
}

/** A session of `client`'s, with its checkouts in `dev`, started and stopped when the test ends, once it has loaded what was there and opened `chat`. */
async function deskOf(t: TestContext, client: Client, dev: string, chat: string, options: Options = {}): Promise<Desk> {
  const notices: Notice[] = [];
  const questions: Question[] = [];
  const reply = { yes: false };
  const hooks = {
    changed: () => undefined,
    notice: (notice: Notice) => {
      notices.push(notice);
    },
    arrived: () => undefined,
    confirmClone: () => Promise.resolve(false),
    confirm: (question: Question) => {
      questions.push(question);
      return Promise.resolve(reply.yes);
    }
  };
  const session = new Session(client, dev, hooks, { presence: 1, ...options });
  session.start();
  t.after(() => session.stop());
  await until("the chats loaded", () => session.view().loaded && session.view().rows.some((row) => row.chat === chat));
  await session.handle({ do: "open", chat });
  return { session, notices, questions, reply };
}

/** What a session shows of a message, once it is there. */
function shownTo(session: Session, id: string): MessageView | undefined {
  return session.view().current?.messages.find((message) => message.id === id);
}

/** The pull requests the fake was asked for one by one, as repo and id. */
function asked(calls: readonly Call[]): string[] {
  return calls.flatMap((call) => {
    const found = /\/repositories\/([^/]+)\/pullrequests\/([0-9]+)$/.exec(call.path);
    return found === null ? [] : [`${found[1] ?? ""} ${found[2] ?? ""}`];
  });
}

await test("!123 in a channel pinned to a repo on Azure DevOps, and a pasted address in any chat, are looked up once a minute, five a message at most, and shown as Azure DevOps answered; what it cannot find is left as text", async (t) => {
  const { calls } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#team", "channel.join", {});
  }
  await bob.publish("#team", "channel.pin", { repo: UPLOADER, branch: null });
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#team");

  const pasted = "https://dev.azure.com/acme/Platform/_git/api/pullrequest/20";
  const said = await bob.publish("#team", "message", { text: `see !22 and !999, ${pasted} and https://dev.azure.com.example.com/acme/Platform/_git/api/pullrequest/21`, via: "cli" });
  const shown = await until("both found", () => (shownTo(session, said.event.id)?.pulls.length === 2 ? shownTo(session, said.event.id) : undefined));
  assert.deepEqual(
    shown.pulls.map(({ ref, pull }) => [ref, pull.id, pull.title, pull.status, pull.web]),
    [
      ["!22", 22, "A new feature", "active", "https://dev.azure.com/acme/platform/_git/uploader/pullrequest/22"],
      [pasted, 20, "Updated pull request title", "completed", "https://dev.azure.com/acme/platform/_git/api/pullrequest/20"]
    ]
  );
  await until("!999 answered", () => asked(calls).length === 3);
  await delay(200);
  session.view();
  assert.deepEqual(asked(calls), ["uploader 22", "uploader 999", "api 20"]); // Each once, and the address on another host never.
  assert.ok(calls.every((call) => call.authorization === `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`));

  // Six in one message: the first five are looked up. And in a direct chat, which nothing is pinned to, !22 refers to nothing, while an address still does.
  const many = await bob.publish("#team", "message", { text: "!1 !2 !3 !4 !5 !6", via: "cli" });
  await until("the first five asked", () => shownTo(session, many.event.id) !== undefined && asked(calls).length === 8);
  await delay(200);
  assert.deepEqual(asked(calls).slice(3), ["uploader 1", "uploader 2", "uploader 3", "uploader 4", "uploader 5"]);
  assert.deepEqual(
    shownTo(session, many.event.id)?.pulls.map((each) => each.ref),
    ["!1"]
  );
  const direct = await bob.publish("jacob", "message", { text: `!22, or ${pasted}`, via: "cli" });
  await session.handle({ do: "open", chat: "bob" });
  await until("the address in the direct chat", () => shownTo(session, direct.event.id)?.pulls.length === 1);
  assert.deepEqual(shownTo(session, direct.event.id)?.pulls[0]?.ref, pasted);
  assert.equal(asked(calls).length, 8);

  // A minute on, each is asked again as it is drawn, and what was found is shown meanwhile.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.equal(shownTo(session, direct.event.id)?.pulls[0]?.ref, pasted);
  await until("the address asked again", () => shownTo(session, direct.event.id) !== undefined && asked(calls).length === 9);
  t.mock.timers.reset();
});

await test("no more than a hundred answers are kept fresh at once, and while they are, nothing more is asked; the newest message's are asked first, and none while the user looks away", async (t) => {
  const { calls } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#team", "channel.join", {});
  }
  await bob.publish("#team", "channel.pin", { repo: UPLOADER, branch: null });
  for (let message = 0; message < 20; message += 1) {
    await bob.publish("#team", "message", { text: [1, 2, 3, 4, 5].map((each) => `!${String(1000 + message * 5 + each)}`).join(" "), via: "cli" });
  }
  const newest = await bob.publish("#team", "message", { text: "!22 is the one on screen", via: "cli" });
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#team");
  await until("a hundred asked", () => session.view().current !== null && asked(calls).length === 100);
  await delay(300);
  session.view();
  await delay(300);
  assert.equal(asked(calls).length, 100);
  // The newest message's first, so it has its chip; what is left over is the oldest message's last.
  await until("the newest message's chip", () => shownTo(session, newest.event.id)?.pulls.length === 1);
  assert.deepEqual([asked(calls).includes("uploader 1004"), asked(calls).includes("uploader 1005")], [true, false]);

  // Looking away, a minute on, nothing is asked however often the view is drawn, and what was found stays; back, it is all asked again.
  session.attend(false);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  for (let drawn = 0; drawn < 3; drawn += 1) {
    session.view();
    await delay(100);
  }
  assert.deepEqual([asked(calls).length, shownTo(session, newest.event.id)?.pulls.length], [100, 1]);
  session.attend(true);
  await until("asked again", () => asked(calls).length === 200);
  t.mock.timers.reset();
});

await test("a branch room on Azure DevOps shows its branch's pull request, an active one first, and its latest build, looked at again while it is open and the user looks, and not otherwise", async (t) => {
  const { calls } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const chat of ["#room", "#whole", "#odd"]) {
    for (const person of [bob, jacob]) {
      await person.publish(chat, "channel.join", {});
    }
  }
  await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: "npaulk/my_work" });
  await bob.publish("#whole", "channel.pin", { repo: UPLOADER, branch: null });
  await bob.publish("#odd", "channel.pin", { repo: UPLOADER, branch: "x&$top=500#y" });
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#room", { rooms: 0.2 });
  const found = await until("the pull request and the build", () => session.view().current?.pinned?.azure ?? undefined);
  assert.ok(found.ok);
  assert.deepEqual(
    [found.pull?.id, found.pull?.status, found.pull?.web, found.build],
    [
      22,
      "active",
      "https://dev.azure.com/acme/platform/_git/uploader/pullrequest/22",
      { id: 391, name: "AnotherRepository-CI", status: "completed", result: "failed", web: "https://dev.azure.com/acme/platform/_build/results?buildId=391" }
    ]
  ); // Pull request 20, from the same branch, is completed.

  // Looked at again while it is open and the user looks; not while they look away, and again once they are back.
  const builds = (): number => calls.filter((call) => call.path.endsWith("/build/builds")).length;
  await until("looked at again", () => builds() >= 3);
  session.attend(false);
  await delay(300); // For a look under way to end.
  const away = builds();
  await delay(600);
  assert.equal(builds(), away);
  session.attend(true);
  await until("looked at once the user is back", () => builds() > away);

  // Not in a room about the whole repo.
  await session.handle({ do: "open", chat: "#whole" });
  await delay(300);
  const left = builds();
  await delay(600);
  assert.deepEqual([builds(), session.view().current?.pinned?.azure], [left, null]);

  // A branch goes to Azure DevOps as one value of the query, whatever it holds; and with no pull request from it, there is none.
  await session.handle({ do: "open", chat: "#odd" });
  const odd = await until("the odd branch's room", () => (session.view().current?.pinned?.azure?.ok === true ? session.view().current?.pinned?.azure : undefined));
  assert.equal(odd?.ok === true ? odd.pull : undefined, null);
  const asked = calls.findLast((call) => call.path.endsWith("/pullrequests"));
  assert.deepEqual([asked?.query.get("searchCriteria.sourceRefName"), asked?.query.get("$top")], ["refs/heads/x&$top=500#y", "5"]);
});

await test("a teammate changing a room's pin again and again sets no pace: the desk looks again no sooner than five seconds on, whatever the room", async (t) => {
  const { calls } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#room", "channel.join", {});
  }
  await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: "npaulk/my_work" });
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#room");
  await until("the first look", () => session.view().current?.pinned?.azure ?? undefined);
  const lists = (): Call[] => calls.filter((call) => call.path.endsWith("/pullrequests"));

  // Twenty-one changes, each drawn as the window draws a change, the last to feature/retry: looked at once the five seconds are up, and then only that room.
  for (let change = 0; change <= 20; change += 1) {
    await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: change % 2 === 0 ? "feature/retry" : "npaulk/my_work" });
    session.view();
  }
  await until("the last pin read", () => session.view().current?.pinned?.branch === "feature/retry");
  assert.equal(lists().length, 1);
  await until("the room as it is pinned now looked at", () => session.view().current?.pinned?.azure?.ok === true && lists().length === 2);
  assert.equal(lists().at(-1)?.query.get("searchCriteria.sourceRefName"), "refs/heads/feature/retry");
});

await test("a look at a room still under way when its pin changes ends before the room as pinned now is looked at", async (t) => {
  const { promise: held, resolve: release } = Promise.withResolvers<undefined>();
  const { calls } = await azure(t, (call, reply) => (call.path.endsWith("/build/builds") ? held.then(() => reply) : reply)); // Every build, until released.
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#room", "channel.join", {});
  }
  await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: "npaulk/my_work" });
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#room", { rooms: 0.1 });
  const lists = (): Call[] => calls.filter((call) => call.path.endsWith("/pullrequests"));
  await until("the first look waiting on its build", () => calls.some((call) => call.path.endsWith("/build/builds")));
  await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: "feature/retry" });
  await until("the pin read", () => session.view().current?.pinned?.branch === "feature/retry");
  for (let drawn = 0; drawn < 5; drawn += 1) {
    session.view();
    await delay(100);
  }
  assert.equal(lists().length, 1);
  release(undefined);
  await until("the room as pinned now looked at", () => lists().length === 2);
  assert.equal(lists().at(-1)?.query.get("searchCriteria.sourceRefName"), "refs/heads/feature/retry");
});

/**
 * Jacob's checkout of uploader in `dev`, on feature/retry with two commits of his on main, and its origin, a bare repository that has main as master, which Azure DevOps names its
 * default. Returns where each is.
 */
function uploader(dev: string): { readonly mine: string; readonly origin: string } {
  const mine = checkout(dev, "uploader");
  const origin = join(REMOTES, "Platform", "_git", "uploader");
  rmSync(origin, { recursive: true, force: true }); // An earlier test's.
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(mine, "push", "-q", origin, "main:master");
  git(mine, "fetch", "-q", "origin");
  git(mine, "checkout", "-q", "-b", "feature/retry");
  git(mine, "commit", "-q", "--allow-empty", "-m", "Retry once more");
  git(mine, "commit", "-q", "--allow-empty", "-m", "Back off longer");
  return { mine, origin };
}

await test("a pull request from a branch room's branch is filled from its commits, into the default branch Azure DevOps names, pushed first only once the user says yes, and said in the room with its link", async (t) => {
  const { project } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#room", "channel.join", {});
  }
  await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: "feature/retry" });
  const { mine, origin } = uploader(join(hub.dir, "dev-jacob"));
  const { session, questions, reply } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#room", { rooms: 0.2 });

  const from = { room: "#room" };
  assert.deepEqual(await session.pullForm(from), { repo: "uploader", branch: "feature/retry", target: "master", title: "Retry once more", description: "- Retry once more\n- Back off longer" });

  // Origin has no feature/retry, so the user is asked first: no, and nothing is pushed or opened.
  const opened = { do: "openPull", from, title: "Retry once more", description: "Two commits.", draft: true } as const;
  await session.handle(opened);
  assert.deepEqual(questions, [
    {
      message: "Push feature/retry to origin?",
      detail: [
        "Origin has no branch feature/retry, and a pull request is opened from what origin has.",
        "",
        `Repo: uploader, in ${mine}`,
        "Branch: feature/retry",
        `Remote: origin, file://${origin}`,
        "",
        "This runs git push -u origin feature/retry, with your own git credentials."
      ].join("\n"),
      confirm: "Push"
    }
  ]);
  assert.deepEqual([git(origin, "branch", "--list", "feature/retry"), project.made], ["", []]);

  // Yes: pushed, tracked, opened as asked, and said in the room, where its pull request is shown.
  reply.yes = true;
  await session.handle(opened);
  assert.equal(git(origin, "rev-parse", "feature/retry"), git(mine, "rev-parse", "HEAD"));
  assert.equal(git(mine, "rev-parse", "--abbrev-ref", "feature/retry@{upstream}"), "origin/feature/retry");
  assert.deepEqual(project.made, [{ sourceRefName: "refs/heads/feature/retry", targetRefName: "refs/heads/master", title: "Retry once more", description: "Two commits.", isDraft: true }]);
  const said = (await jacob.events({ chat: "#room" })).find(({ event }) => event.kind === "message" && event.author === "jacob");
  assert.deepEqual(JSON.parse(said?.event.content ?? "{}"), { text: "Opened pull request 101: https://dev.azure.com/acme/Platform/_git/uploader/pullrequest/101", via: "window" });
  await until("its pull request in the room", () => {
    const azure = session.view().current?.pinned?.azure;
    return azure?.ok === true && azure.pull?.id === 101;
  });

  // Pushed already, it is not asked again; with a commit origin lacks, it is.
  await session.handle(opened);
  assert.equal(questions.length, 2);
  git(mine, "commit", "-q", "--allow-empty", "-m", "And once more");
  reply.yes = false;
  await session.handle(opened);
  assert.equal(questions.length, 3);
  assert.match(questions[2]?.detail ?? "", /^Origin's branch lacks commits of your feature\/retry, /);
  assert.equal(project.made.length, 2);
});

await test("a long subject, or a branch of many commits, fills the dialog with no more than it may send back: the title cut, and the subjects that fit with how many more", async (t) => {
  await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#room", "channel.join", {});
  }
  await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: "feature/retry" });
  const { mine } = uploader(join(hub.dir, "dev-jacob"));
  const long = "long".repeat(150);
  git(mine, "reset", "-q", "--hard", "main");
  execFileSync("sh", ["-c", 'git commit -q --allow-empty -m "$1" && for i in $(seq 200); do git commit -q --allow-empty -m "Step $i of a long branch"; done', "sh", long], { cwd: mine });
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#room");

  const form = await session.pullForm({ room: "#room" });
  assert.equal(form.title, `${long.slice(0, 399)}…`);
  const lines = form.description.split("\n");
  assert.ok(form.description.length <= 4000 && form.description.length > 3950, String(form.description.length));
  assert.deepEqual(lines.slice(0, -1), [`- ${long}`, ...Array.from({ length: lines.length - 2 }, (_, at) => `- Step ${String(at + 1)} of a long branch`)]);
  assert.equal(lines.at(-1), `… and ${String(201 - (lines.length - 1))} more`);
  commandSchema.parse({ do: "openPull", from: { room: "#room" }, title: form.title, description: form.description, draft: false }); // As the window sends it back, untouched.
});

await test("a pull request is opened only from the branch the user's checkout is on, and never from a pinned branch git would read as more than a branch, refused in words before git runs", async (t) => {
  await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  const rooms = { "#colon": ":main", "#dash": "-x", "#plus": "+feature/retry", "#other": "other" };
  for (const room of Object.keys(rooms)) {
    for (const person of [bob, jacob]) {
      await person.publish(room, "channel.join", {});
    }
  }
  // Stored as a hub that checked nothing about a branch would store it, as a teammate's text may say anything; the desk reads such a branch as none, a room about the whole repo.
  const db = new Database(join(hub.dir, "hub.db"));
  for (const [room, branch] of Object.entries(rooms)) {
    db.setPin(room, UPLOADER, branch);
  }
  db.close();
  const { mine } = uploader(join(hub.dir, "dev-jacob"));
  const { session, questions } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#other");
  await until("the pins read", () => session.view().current?.pinned?.branch === "other");
  writeFileSync(CALLS, "");
  for (const [room, branch] of Object.entries(rooms)) {
    const why =
      branch === "other"
        ? "your uploader checkout is on feature/retry, not other: switch to it to open its pull request"
        : branch.startsWith("+") // A name git takes for a branch, which a push would read as forcing it.
          ? `${room} is pinned to ${branch}, which git would read as more than a branch: no pull request is opened from it`
          : `${room} is not a room about a branch`;
    await assert.rejects(session.pullForm({ room }), { message: why });
    await assert.rejects(session.handle({ do: "openPull", from: { room }, title: "x", description: "", draft: false }), { message: why });
    if (branch !== "other") {
      await assert.rejects(repos.push(mine, branch), { message: `refusing to push ${JSON.stringify(branch)}: git would read it as more than a branch` }); // And so does pushing, on its own.
    }
  }
  assert.deepEqual(
    readFileSync(CALLS, "utf8")
      .split("\n")
      .filter((line) => / (log|push|ls-remote|remote|merge-base) /.test(` ${line} `)),
    []
  );
  assert.deepEqual(questions, []);
});

await test("a patch applied to a new branch opens its pull request from that branch, with its title, once the push is said yes to, and not before it was applied there", async (t) => {
  const { project } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#team", "channel.join", {});
  }
  const { mine, origin } = uploader(join(hub.dir, "dev-jacob"));
  const diff = "diff --git a/note.txt b/note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+a note\n";
  const sent = await bob.publish("#team", "patch", { repo: UPLOADER, base: git(mine, "rev-parse", "main"), branch: "main", title: "Add a note", diff });
  const { id } = sent.event;
  const { session, questions, reply } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#team");
  await until("the patch", () => shownTo(session, id));
  const from = { patch: id };
  await assert.rejects(session.pullForm(from), { message: `apply it to a new branch first: you have not made player-two/${id.slice(0, 8)} of it` });

  reply.yes = true;
  await session.handle({ do: "applyPatch", id, newBranch: true });
  const branch = `player-two/${id.slice(0, 8)}`;
  await until("applied to its branch", () => shownTo(session, id)?.patch?.applied.some((each) => each.branch === branch));
  assert.deepEqual(await session.pullForm(from), { repo: "uploader", branch, target: "master", title: "Add a note", description: "" });
  await session.handle({ do: "openPull", from, title: "Add a note", description: "", draft: false });
  assert.equal(questions.at(-1)?.message, `Push ${branch} to origin?`);
  assert.equal(git(origin, "rev-parse", branch), git(mine, "rev-parse", branch));
  assert.equal(git(mine, "branch", "--show-current"), "feature/retry"); // Pushed from where Apply to a new branch made it, the checkout left on its own branch.
  assert.deepEqual(project.made, [{ sourceRefName: `refs/heads/${branch}`, targetRefName: "refs/heads/master", title: "Add a note", description: "", isDraft: false }]);
  const said = (await jacob.events({ chat: "#team" })).find(({ event }) => event.kind === "message" && event.author === "jacob");
  assert.deepEqual(JSON.parse(said?.event.content ?? "{}"), { text: "Opened pull request 101: https://dev.azure.com/acme/Platform/_git/uploader/pullrequest/101", via: "window" });
});

await test("the user is told, on their desk alone, once each time the latest build of the branch room they look at changes to failed, and not of one failed when first seen", async (t) => {
  const { project } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#room", "channel.join", {});
  }
  await bob.publish("#room", "channel.pin", { repo: UPLOADER, branch: "npaulk/my_work" });
  const { session, notices } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#room", { rooms: 0.1 });
  const result = (): string | null | undefined => {
    const azure = session.view().current?.pinned?.azure;
    return azure?.ok === true ? azure.build?.result : undefined;
  };
  await until("the build, failed when first seen", () => result() === "failed");
  await delay(300);
  assert.deepEqual(notices, []);

  // Each state, and how many times the user has been told by then: a build that failed after it succeeded, and one that failed after it ran.
  for (const [now, told] of [
    ["succeeded", 0],
    ["failed", 1],
    [null, 1],
    ["failed", 2]
  ] as const) {
    project.result = now;
    await until(`the build ${String(now)}`, () => result() === now);
    await delay(300); // Looked at again, and again, with nothing new.
    assert.equal(notices.length, told);
  }
  assert.deepEqual(notices[0], {
    title: "the build of uploader on npaulk/my_work failed",
    body: "AnotherRepository-CI: failed, https://dev.azure.com/acme/platform/_build/results?buildId=391",
    severity: "error"
  });
  assert.equal((await bob.events({ chat: "#room" })).filter(({ event }) => event.author === "jacob" && event.kind !== "channel.join").length, 0);
});
