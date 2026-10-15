/**
 * Patches, through two sessions against a real hub with the scripted ACP agent and real git repositories: where a teammate's run happens, the patch it hands over, applying one, and reviews.
 * The home folder, where clean copies are made, and git's configuration are the test's own.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { readContent } from "../src/core/kinds.ts";
import { byCodeUnit } from "../src/core/text.ts";
import type { Agent, PermissionMode } from "../src/core/wire.ts";
import { agentKey } from "../src/desk/agentKeys.ts";
import type { Client } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import { runOf } from "../src/shared/ipc.ts";
import type { Notice } from "../src/shared/ipc.ts";
import { checkout, ownHome, startHub } from "./startHub.ts";

ownHome();
const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
}

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

/** Every file in a checkout but .git, with what it holds, and what git says of its index and working tree: what nobody else's request may change. */
function snapshot(path: string): string {
  const files = readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((name) => name !== ".git" && !name.startsWith(".git/") && statSync(join(path, name)).isFile())
    .sort(byCodeUnit)
    .map((name) => [name, readFileSync(join(path, name), "utf8")]);
  return JSON.stringify([files, git(path, "status", "--porcelain=v1", "-uall"), git(path, "diff", "--cached"), git(path, "rev-parse", "HEAD"), git(path, "branch", "--show-current")]);
}

/** Where a run on a clean copy of the request `id` to the agent in `repo` is made. */
function copyOf(id: string, repo: string): string {
  return join(homedir(), ".player-two", "worktrees", createHash("sha256").update(runOf(id, repo)).digest("hex").slice(0, 12));
}

interface Two {
  readonly bob: Client;
  readonly jacob: Client;
  readonly asker: Session; // Bob's.
  readonly owner: Session; // Jacob's, whose agent answers in his checkout of uploader.
  readonly mine: string; // Jacob's checkout.
  readonly notices: Notice[]; // What jacob was told.
  // Bob asks jacob's agent in #team from his window, and jacob lets it run at `mode`, its answer posted or kept for his review. Resolves with the request's id.
  readonly asks: (text: string, mode: PermissionMode, post: boolean) => Promise<string>;
}

/**
 * Bob and jacob in #team, each with a session, and jacob's real checkout of uploader: a README and notes committed, the README changed since and a file nobody has added, as work
 * of his own not committed yet. His agent is the scripted one.
 */
async function two(t: TestContext): Promise<Two> {
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  const agent: Agent = { id: "fake", label: "Fake", protocol: "acp", command: process.execPath, args: [FAKE, "--no-pids"] };
  jacob.saveAgents([agent], "fake");
  for (const person of [bob, jacob]) {
    await person.publish("#team", "channel.join", {});
  }
  const mine = checkout(join(hub.dir, "dev-jacob"), "uploader");
  writeFileSync(join(mine, "README.md"), "# uploader\n");
  writeFileSync(join(mine, "notes.txt"), "one\ntwo\nthree\n");
  git(mine, "add", "-A");
  git(mine, "commit", "-qm", "readme and notes");
  writeFileSync(join(mine, "README.md"), "# uploader\nmy own work, not committed\n");
  writeFileSync(join(mine, "scratch.txt"), "not added\n");
  const notices: Notice[] = [];
  const quiet = { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) };
  const owner = new Session(
    jacob,
    join(hub.dir, "dev-jacob"),
    {
      ...quiet,
      notice: (notice) => {
        notices.push(notice);
      }
    },
    { presence: 1 }
  );
  const asker = new Session(bob, join(hub.dir, "dev-bob"), quiet, { presence: 1 });
  for (const session of [owner, asker]) {
    session.start();
    t.after(() => session.stop());
  }
  await until("both loaded, and jacob's checkout shared", () => owner.view().loaded && owner.view().myRepos.includes("uploader") && asker.view().rows.some((row) => row.chat === "#team"));
  for (const session of [owner, asker]) {
    await session.handle({ do: "open", chat: "#team" });
  }
  const asks = async (text: string, mode: PermissionMode, post: boolean): Promise<string> => {
    const sent = asker.view().current?.messages.length ?? 0;
    await asker.handle({ do: "send", chat: "#team", text });
    const id = await until(
      "bob's request",
      () =>
        asker
          .view()
          .current?.messages.slice(sent)
          .find((message) => message.body === text)?.id
    );
    await until("jacob can run it", () => owner.view().current?.messages.find((message) => message.id === id)?.requests[0]?.status.kind === "ready");
    await owner.handle({ do: "run", id, repo: "uploader", post, mode, text });
    return id;
  };
  return { bob, jacob, asker, owner, mine, notices, asks };
}

/** What the hub holds of `kind` about the request `id`, as bob reads #team, oldest first: what each event says. */
async function said(bob: Client, id: string, kind: string): Promise<ReturnType<typeof readContent>[]> {
  return (await bob.events({ chat: "#team", limit: 200 }))
    .filter(({ event }) => event.kind === kind && event.refs[0] === id)
    .map(({ event }) => readContent(event))
    .reverse();
}

await test(
  "a teammate's request let do more than read runs on a clean copy of the commit the checkout is on, and leaves the owner's working tree as it was; read-only runs in the checkout, and so does the owner's own request at any mode",
  { timeout: 60_000 },
  async (t) => {
    const { bob, owner, mine, asks } = await two(t);
    const before = snapshot(mine);
    const head = git(mine, "rev-parse", "HEAD").trim();

    // At auto-edits the agent writes a file without asking: on the clean copy, made at jacob's commit without his uncommitted work, and removed once the run has ended.
    const edit = await asks("@jacob/uploader edit the README", "auto-edits", true);
    await until("the answer", async () => (await said(bob, edit, "job.result")).length > 0);
    assert.equal(snapshot(mine), before);
    assert.deepEqual(await said(bob, edit, "job.accepted"), [
      { kind: "job.accepted", content: { repo: "uploader", branch: "main", commit: head, dirty: false, delivery: "post", mode: "auto-edits", delegate: false, by: "owner" } }
    ]);
    const read = owner.view().current?.activity.find((item) => item.run === runOf(edit, "uploader") && item.title === "Read README.md");
    assert.equal(read?.detail, JSON.stringify({ path: join(copyOf(edit, "uploader"), "README.md") }, null, 1)); // Where the agent was: the clean copy.
    await until("the clean copy removed", () => owner.view().busy.working === 0 && !existsSync(copyOf(edit, "uploader")));
    assert.equal(snapshot(mine), before);
    assert.deepEqual(git(mine, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);

    // Read-only, it runs in the checkout itself, where it can see the uncommitted work, and its acceptance says there is some.
    const look = await asks("@jacob/uploader read", "read-only", true);
    await until("the read-only answer", async () => (await said(bob, look, "job.result")).length > 0);
    const looked = owner.view().current?.activity.find((item) => item.run === runOf(look, "uploader") && item.title === "Read README.md");
    assert.equal(looked?.detail, JSON.stringify({ path: join(mine, "README.md") }, null, 1));
    assert.deepEqual(await said(bob, look, "job.accepted"), [
      { kind: "job.accepted", content: { repo: "uploader", branch: "main", commit: head, dirty: true, delivery: "post", mode: "read-only", delegate: false, by: "owner" } }
    ]);
    assert.equal(snapshot(mine), before);

    // Jacob's own request from his window runs at once, at auto-edits, in his checkout.
    await owner.handle({ do: "send", chat: "#team", text: "@jacob/uploader edit the notes" });
    await until("his own edit, in his checkout", () => existsSync(join(mine, "edited.txt")));
  }
);

await test(
  "a run on a clean copy that changed something hands it over as a patch, refers to the request, before the answer: posted signed by the agent, or kept beside the draft until its owner sends both; a run that changed nothing hands over none",
  { timeout: 60_000 },
  async (t) => {
    const { bob, jacob, asker, owner, mine, asks } = await two(t);
    const head = git(mine, "rev-parse", "HEAD").trim();
    const kinds = async (id: string): Promise<string[]> =>
      (await bob.events({ chat: "#team", limit: 200 }))
        .filter(({ event }) => event.refs[0] === id && event.kind !== "job.progress")
        .map(({ event }) => `${event.kind} by ${event.author}`)
        .reverse();

    // A run that changed nothing sends no patch. First, as the agent acts on every word of its prompt, earlier messages among them.
    const nothing = await asks("@jacob/uploader read", "auto-edits", true);
    await until("the answer", async () => (await said(bob, nothing, "job.result")).length > 0);
    assert.deepEqual(await kinds(nothing), ["job.accepted by jacob", "job.result by jacob/uploader"]);

    // Posted directly: the patch, then the answer, each signed by jacob's agent. It names the repo, the commit and branch the copy was made on, the answer's first line, and the change.
    const posted = await asks("@jacob/uploader edit the README", "auto-edits", true);
    await until("the answer", async () => (await said(bob, posted, "job.result")).length > 0);
    assert.deepEqual(await kinds(posted), ["job.accepted by jacob", "patch by jacob/uploader", "job.result by jacob/uploader"]);
    const [patch] = await said(bob, posted, "patch");
    assert.ok(patch?.kind === "patch");
    assert.deepEqual(
      { ...patch.content, diff: "" },
      {
        repo: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" },
        base: head,
        branch: "main",
        title: "turn 1: read; edit allowed",
        diff: ""
      }
    );
    assert.match(patch.content.diff, /^diff --git a\/edited\.txt b\/edited\.txt\nnew file mode 100644\n.*\n--- \/dev\/null\n\+\+\+ b\/edited\.txt\n@@ -0,0 \+1 @@\n\+edited\n$/);
    // Bob sees it where an answer would be: from jacob's agent, not reviewed, the title its text.
    const shown = await until("bob sees the patch", () => asker.view().current?.messages.find((message) => message.patch !== null));
    assert.deepEqual([shown.sender, shown.signer, shown.agent, shown.body, shown.quote], ["jacob", "jacob/uploader", "uploader", "turn 1: read; edit allowed", "bob: @jacob/uploader edit the README"]);
    assert.deepEqual(shown.patch, { repo: "uploader", base: head, branch: "main", title: "turn 1: read; edit allowed", diff: patch.content.diff });

    // Kept for review: nothing is sent while the draft waits, and the patch is beside it; sending sends the patch and then the answer, both signed by jacob.
    const reviewed = await asks("@jacob/uploader edit the README", "auto-edits", false);
    const draft = await until("jacob's draft", () => owner.view().current?.drafts.find((each) => each.id === reviewed));
    assert.match(draft.patch?.diff ?? "", /^\+edited$/m);
    assert.deepEqual(await kinds(reviewed), ["job.accepted by jacob"]);
    await owner.handle({ do: "sendDraft", chat: "#team", id: reviewed, repo: "uploader", text: "Done, see the patch." });
    await until("the answer", async () => (await said(bob, reviewed, "job.result")).length > 0);
    assert.deepEqual(await kinds(reviewed), ["job.accepted by jacob", "patch by jacob", "job.result by jacob"]);

    // Thrown away, neither goes.
    const discarded = await asks("@jacob/uploader edit the README", "auto-edits", false);
    await until("jacob's draft", () => owner.view().current?.drafts.find((each) => each.id === discarded));
    await owner.handle({ do: "discardDraft", chat: "#team", id: discarded, repo: "uploader" });
    await until("the decline", async () => (await said(bob, discarded, "job.declined")).length > 0);
    assert.deepEqual(await kinds(discarded), ["job.accepted by jacob", "job.declined by jacob"]);

    // An agent sends a patch only about its own repo, as any report of its run.
    const agent = jacob.as("jacob/uploader", agentKey(jacob.home, "uploader"));
    const content = { ...patch.content, repo: { ...patch.content.repo, name: "billing" } };
    await assert.rejects(agent.publish("#team", "patch", content, [posted]), /jacob\/uploader reports only on its own repo, uploader/);
  }
);
