/**
 * The ACP runner against a scripted agent, test/fixtures/fake-acp-agent.ts, run with node: its answer, signing in, what each mode allows, asks and refuses, stopping,
 * follow-ups, also through a session against a real hub, and that nothing the agent started is left behind. Then the phase's two-session scenario, with what the hub stores after it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

import { ChatLog, STALE } from "../src/core/chat.ts";
import { readContent, SUMMARIES } from "../src/core/kinds.ts";
import type { Summary } from "../src/core/kinds.ts";
import type { Agent, PermissionMode } from "../src/core/wire.ts";
import { acpRunner } from "../src/desk/agents/acp.ts";
import { permissionTests } from "../src/desk/doctor.ts";
import { Feed } from "../src/desk/agents/activity.ts";
import type { FollowUp, PermissionAsk, RunHandlers } from "../src/desk/agents/runner.ts";
import { AgentCancelledError, AgentTimedOutError } from "../src/desk/client.ts";
import type { Client } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import type { Options } from "../src/desk/session.ts";
import { runOf } from "../src/shared/ipc.ts";
import type { ActivityItem, Arrival, RequestView } from "../src/shared/ipc.ts";
import { NOW, startHub, TEAM_REPOS } from "./startHub.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");
const never = new AbortController().signal;

function fake(...more: string[]): Agent {
  return { id: "fake", label: "Fake", protocol: "acp", command: process.execPath, args: [FAKE, ...more] };
}

await test("the feed names each step as a person would: one item for a message as it grows, a tool call that changes in place, a file by its path in the checkout, a command by its first line, and the agent's own title for what it cannot name", () => {
  const reported: (readonly [ActivityItem, Summary])[] = [];
  const checkout = "/home/bob/dev/uploader";
  const feed = new Feed(checkout, (item, doing) => {
    reported.push([item, doing]);
  });
  const updates: acp.SessionUpdate[] = [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me look" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " at the queue." } },
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "in_progress", locations: [{ path: `${checkout}/src/queue.py` }] },
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Edit file",
      kind: "edit",
      status: "pending",
      content: [{ type: "diff", path: `${checkout}/src/queue.py`, oldText: "a\nb\nc\n", newText: "a\nB\nB2\nc\n" }]
    },
    { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" },
    { sessionUpdate: "tool_call", toolCallId: "t3", title: "Terminal", kind: "execute", status: "in_progress", rawInput: { command: "npm test\n  -- --watch" } },
    { sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed", rawOutput: { exitCode: 1 } },
    { sessionUpdate: "tool_call", toolCallId: "t4", title: "Edit /etc/hosts", kind: "edit", status: "failed" },
    { sessionUpdate: "tool_call", toolCallId: "t5", title: "Something new", kind: "switch_mode", status: "completed" },
    { sessionUpdate: "current_mode_update", currentModeId: "code" },
    {
      sessionUpdate: "plan",
      entries: [
        { content: "Fix the retry", priority: "high", status: "completed" },
        { content: "Run the tests", priority: "low", status: "pending" }
      ]
    },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: " } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "it retries." } }
  ];
  for (const update of updates) {
    feed.update(update);
  }
  const newest = new Map(reported.map(([item, doing]) => [item.id, [item.title, item.outcome, item.status, item.quiet, item.loud, doing]])); // Each item in the place it first took.
  assert.deepEqual(
    [...newest],
    [
      ["thought 1", ["Let me look at the queue.", "", "done", true, false, "thinking"]],
      ["t1", ["Read src/queue.py", "done", "done", true, false, "reading"]],
      ["t2", ["Edited src/queue.py", "+2 −1", "done", false, true, "editing files"]],
      ["t3", ["Ran npm test", "exit 1", "done", false, true, "running a command"]],
      ["t4", ["Edit /etc/hosts", "failed", "failed", false, true, "editing files"]], // No path given: the agent's own title, not a guess.
      ["t5", ["Something new", "done", "done", false, false, "thinking"]],
      ["plan", ["Planned 2 steps", "1 of 2 done", "running", false, false, "thinking"]],
      ["message 2", ["Done: it retries.", "", "done", false, false, "thinking"]]
    ]
  );
  const detail = (id: string): string => reported.findLast(([item]) => item.id === id)?.[0].detail ?? "";
  assert.equal(detail("t2"), "--- src/queue.py\n+++ src/queue.py\n@@ line 2 @@\n-b\n+B\n+B2");
  assert.equal(detail("t3"), `${JSON.stringify({ command: "npm test\n  -- --watch" }, null, 1)}\n\n${JSON.stringify({ exitCode: 1 }, null, 1)}`);
  assert.equal(detail("plan"), "[x] Fix the retry\n[ ] Run the tests");
  assert.equal(feed.detailOf({ toolCallId: "t9", content: [{ type: "diff", path: "/elsewhere/notes.txt", newText: "one\n" }] }), "+++ /elsewhere/notes.txt (new)\n+one");
});

/** A checkout of its own for one test, removed when the test ends. */
function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "player-two-acp-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The processes the fake agent started in `dir` that are there now. */
function alive(dir: string): number[] {
  return readFileSync(join(dir, "pids"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(Number)
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
}

/** The processes the fake agent started in `dir` that are still there, given a moment to go. */
async function left(dir: string): Promise<number[]> {
  for (let tries = 0; tries < 20 && alive(dir).length > 0; tries += 1) {
    await delay(50);
  }
  return alive(dir);
}

/** Handlers that keep what the runner reports, and answer every ask with `answer`. */
function recorder(answer: "allow-once" | "allow-run" | "refuse" = "refuse"): { readonly handlers: RunHandlers; readonly items: ActivityItem[]; readonly asks: PermissionAsk[] } {
  const items: ActivityItem[] = [];
  const asks: PermissionAsk[] = [];
  const handlers: RunHandlers = {
    activity: (item) => {
      items.push(item);
    },
    permission: (ask) => {
      asks.push(ask);
      return Promise.resolve(answer);
    }
  };
  return { handlers, items, asks };
}

await test(
  "an ACP agent's answer is its message, its session has Player Two's MCP server without --allow-send, and nothing it started is left once it has answered",
  { timeout: 20_000 },
  async (t) => {
    const dir = folder(t);
    const { handlers, items } = recorder();
    const answer = await acpRunner(fake()).run("mcp, and read", dir, "full", handlers, never);
    assert.equal(answer, `turn 1: read; servers ${JSON.stringify([{ name: "player-two", command: "player-two", args: ["mcp"], env: [] }])}`);
    assert.deepEqual(
      items.filter((item) => item.kind === "tool").map((item) => [item.id, item.kind, item.title, item.status, item.quiet]),
      [
        ["read", "tool", "Read README.md", "running", true],
        ["read", "tool", "Read README.md", "done", true]
      ]
    );
    assert.deepEqual(await left(dir), []);
  }
);

await test("an agent that needs signing in ends saying how, and one whose program is not there says so", { timeout: 20_000 }, async (t) => {
  const dir = folder(t);
  await assert.rejects(acpRunner(fake("--signed-out")).run("hello", dir, "full", recorder().handlers, never), {
    message: "Fake is not signed in. Sign in once in a terminal where your repos are, inside WSL on Windows, with Fake's own sign-in, then try again"
  });
  assert.deepEqual(await left(dir), []);
  await assert.rejects(acpRunner({ ...fake(), command: "no-such-agent-program" }).run("hello", dir, "full", recorder().handlers, never), {
    message: `could not start Fake's program "no-such-agent-program": spawn no-such-agent-program ENOENT. Check it on the Setup page`
  });
});

await test(
  "the desk answers an agent's permission requests by the run's mode: reads at once, and edits and commands allowed, refused or asked of the owner as the table says",
  { timeout: 60_000 },
  async (t) => {
    const runner = acpRunner(fake());
    const cases = [
      ["read-only", "allow-once", "read; edit refused; run refused", []],
      ["supervised", "refuse", "read; edit refused; run refused", ["edit", "execute"]],
      ["supervised", "allow-once", "read; edit allowed; run allowed", ["edit", "execute"]],
      ["auto-edits", "refuse", "read; edit allowed; run refused", ["execute"]],
      ["full", "refuse", "read; edit allowed; run allowed", []]
    ] as const;
    for (const [mode, answer, said, asked] of cases) {
      const dir = folder(t);
      const { handlers, asks } = recorder(answer);
      assert.equal(await runner.run("read, edit and run", dir, mode, handlers, never), `turn 1: ${said}`, mode);
      assert.deepEqual(
        asks.map((ask) => ask.action),
        asked,
        mode
      );
      assert.equal(existsSync(join(dir, "edited.txt")), said.includes("edit allowed"), mode);
      assert.deepEqual(await left(dir), [], mode);
    }
    const { handlers, asks } = recorder();
    await runner.run("edit", folder(t), "supervised", handlers, never);
    assert.deepEqual(asks, [{ action: "edit", title: "Edit edited.txt", detail: JSON.stringify({ title: "Edit edited.txt" }, null, 1) }]);
    // The agent switching its own mode, which may take it to one that asks about less, is refused below full without asking the owner.
    const switching = recorder("allow-once");
    assert.equal(await runner.run("switch", folder(t), "auto-edits", switching.handlers, never), "turn 1: switch refused");
    assert.deepEqual(switching.asks, []);
    assert.equal(await runner.run("switch", folder(t), "full", switching.handlers, never), "turn 1: switched");
  }
);

await test(
  "allowing an action for the run allows that kind without asking until the run ends and not after, and an agent that offers to be allowed only always is refused",
  { timeout: 30_000 },
  async (t) => {
    const runner = acpRunner(fake());
    const first = recorder("allow-run");
    assert.equal(await runner.run("edit, edit, run", folder(t), "supervised", first.handlers, never), "turn 1: edit allowed; edit allowed; run allowed");
    assert.deepEqual(
      first.asks.map((ask) => ask.action),
      ["edit", "execute"]
    );
    assert.deepEqual(
      first.items.filter((item) => item.kind === "permission").map((item) => [item.id, item.outcome, item.status]),
      [
        ["permission edit-1-0", "", "running"],
        ["permission edit-1-0", "allowed", "done"],
        ["permission edit-1-1", "allowed", "done"],
        ["permission run-1", "", "running"],
        ["permission run-1", "allowed", "done"]
      ]
    );
    const second = recorder("refuse");
    assert.equal(await runner.run("edit", folder(t), "supervised", second.handlers, never), "turn 1: edit refused");
    assert.equal(second.asks.length, 1);
    assert.equal(await acpRunner(fake("--always-only")).run("edit", folder(t), "full", recorder().handlers, never), "turn 1: edit refused");
  }
);

/** Wait until the fake agent in `dir` has said it started `count` processes. */
async function started(dir: string, count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (existsSync(join(dir, "pids")) && readFileSync(join(dir, "pids"), "utf8").trim().split("\n").length >= count) {
      return;
    }
    await delay(25);
  }
  throw new Error(`the fake agent never started ${String(count)} processes`);
}

await test(
  "a stop asks the agent to end its turn and kills it two seconds later if it has not, ending as stopped within three seconds either way, with nothing it started left",
  { timeout: 30_000 },
  async (t) => {
    for (const word of ["slow", "deaf"]) {
      const dir = folder(t);
      const stop = new AbortController();
      const running = acpRunner(fake()).run(word, dir, "full", recorder().handlers, stop.signal);
      await started(dir, 2); // The agent, and the child it started.
      const stoppedAt = Date.now();
      stop.abort();
      await assert.rejects(running, AgentCancelledError);
      const took = Date.now() - stoppedAt;
      assert.ok(took < 3000 && (word === "slow" ? took < 1500 : took >= 2000), `${word} took ${String(took)} ms to stop`);
      assert.deepEqual(await left(dir), [], word);
    }
  }
);

await test("the time limit ends a run, and time spent waiting for the owner's answer does not count against it", { timeout: 30_000 }, async (t) => {
  const runner = acpRunner(fake(), { limit: 1, idle: 60 });
  const slowOwner: RunHandlers = { activity: () => undefined, permission: () => delay(1500).then((): "allow-once" => "allow-once") };
  assert.equal(await runner.run("edit", folder(t), "supervised", slowOwner, never), "turn 1: edit allowed");
  const dir = folder(t);
  await assert.rejects(runner.run("deaf", dir, "full", recorder().handlers, never), (error) => error instanceof AgentTimedOutError && error.message === "the agent did not finish within 1 seconds");
  assert.deepEqual(await left(dir), []);
});

await test(
  "a follow-up goes on in the session its key left open, with only its text, until that has been idle too long or the runner is closed; anything else starts afresh",
  { timeout: 30_000 },
  async (t) => {
    const dir = folder(t);
    const runner = acpRunner(fake(), { limit: 60, idle: 2 });
    t.after(() => runner.close());
    const { handlers } = recorder();
    const thread = (text: string): FollowUp => ({ key: "root alice uploader", text });
    assert.equal(await runner.run("read", dir, "full", handlers, never, thread("not this")), "turn 1: read"); // Afresh: the whole prompt.
    assert.equal(await runner.run("not this", dir, "full", handlers, never, thread("read")), "turn 2: read"); // Followed up: only its text.
    assert.equal(await runner.run("read", dir, "full", handlers, never, { key: "root carol uploader", text: "not this" }), "turn 1: read");
    assert.equal(await runner.run("read", dir, "full", handlers, never), "turn 1: read"); // Nothing to follow: ended at once.
    assert.equal(alive(dir).length, 2);
    await delay(2500);
    assert.deepEqual(await left(dir), []); // Idle too long: what follows starts afresh, with the whole prompt.
    assert.equal(await runner.run("read", dir, "full", handlers, never, thread("not this")), "turn 1: read");
    assert.equal(alive(dir).length, 1);
    await runner.close();
    assert.deepEqual(await left(dir), []);
  }
);

await test(
  "in a session, a reply in a request's thread from the same asker to the same ACP agent goes on in that agent's session; any other request starts one, and quitting ends them all",
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHub(t, () => Date.now() / 1000);
    const [alice, carol, bob] = [await hub.join("alice"), await hub.join("carol"), await hub.join("bob")];
    bob.saveAgents([fake()], "fake");
    for (const person of [alice, carol, bob]) {
      await person.publish("#team", "channel.join", {});
    }
    const dev = join(hub.dir, "dev-bob");
    const checkout = join(dev, "uploader");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${TEAM_REPOS}Platform/_git/uploader\n`);
    writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
    const hooks = { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) };
    const session = new Session(bob, dev, hooks, { presence: 1, describe: () => Promise.resolve({ branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: false }) });
    session.start();
    t.after(() => session.stop());

    /** Ask bob's agent in #team, have bob run it and post the answer, and read the answer. */
    const answer = async (asker: Client, text: string, root: string | null = null): Promise<{ readonly id: string; readonly said: string }> => {
      const { id } = (await asker.publish("#team", "message", { text, via: "cli" }, root === null ? [] : [root])).event;
      for (let tries = 0; tries < 200 && session.view().waiting === 0; tries += 1) {
        await delay(50);
      }
      await session.handle({ do: "run", id, repo: "uploader", post: true, mode: "full", text });
      for (let tries = 0; tries < 200; tries += 1) {
        const result = (await asker.events({ chat: "#team" })).find((delivered) => delivered.event.kind === "job.result" && delivered.event.refs[0] === id);
        const said = result === undefined ? null : readContent(result.event);
        if (said?.kind === "job.result") {
          return { id, said: said.content.text };
        }
        await delay(50);
      }
      throw new Error(`no answer to ${text}`);
    };
    const first = await answer(alice, "@bob/uploader read");
    assert.equal(first.said, "turn 1: read");
    assert.equal((await answer(alice, "@bob/uploader read again", first.id)).said, "turn 2: read");
    assert.equal((await answer(carol, "@bob/uploader read it too", first.id)).said, "turn 1: read"); // Another asker.
    assert.equal((await answer(alice, "@bob/uploader read once more")).said, "turn 1: read"); // Another thread.
    assert.equal(alive(checkout).length, 3);
    await session.stop();
    assert.deepEqual(await left(checkout), []);
  }
);

/** Try `find` every 50 ms, for ten seconds, until it finds something. */
async function until<T>(what: string, find: () => T | undefined | false): Promise<T> {
  for (let tries = 0; tries < 200; tries += 1) {
    const found = find();
    if (found !== undefined && found !== false) {
      return found;
    }
    await delay(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** What bobsDesk gives a test. */
interface Desk {
  readonly alice: Client;
  readonly session: Session; // Bob's.
  readonly checkout: string; // Bob's checkout of uploader, where his agent works.
  // Alice asks in #team, in the thread of `root` when given, and bob lets his agent run it at `mode`, posting its answer or reviewing it. Resolves with the request's id.
  readonly ask: (text: string, mode: PermissionMode, post: boolean, root?: string) => Promise<string>;
  // What bob's agent answered a request: the answer posted, or the draft, which is then thrown away.
  readonly answer: (id: string, post: boolean) => Promise<string>;
}

/** Alice and bob in #team on a hub of their own, and bob's desk, with his checkout of uploader, answering with the scripted agent started with `args`. */
async function bobsDesk(t: TestContext, args: readonly string[] = [], options: Options = {}, now: () => number = () => Date.now() / 1000): Promise<Desk> {
  const hub = await startHub(t, now);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  bob.saveAgents([fake(...args)], "fake");
  for (const person of [alice, bob]) {
    await person.publish("#team", "channel.join", {});
  }
  const dev = join(hub.dir, "dev-bob");
  const checkout = join(dev, "uploader");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${TEAM_REPOS}Platform/_git/uploader\n`);
  writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  const hooks = { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) };
  const session = new Session(bob, dev, hooks, { presence: 1, describe: () => Promise.resolve({ branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: false }), ...options });
  session.start();
  t.after(() => session.stop());
  await until("bob's chats loaded", () => session.view().rows.some((row) => row.chat === "#team"));
  await session.handle({ do: "open", chat: "#team" });
  const ask = async (text: string, mode: PermissionMode, post: boolean, root?: string): Promise<string> => {
    const { id } = (await alice.publish("#team", "message", { text, via: "cli" }, root === undefined ? [] : [root])).event;
    await until("bob can run it", () =>
      session
        .view()
        .current?.messages.flatMap((message) => [message, ...message.replies])
        .some((message) => message.id === id && message.requests[0]?.status.kind === "ready")
    );
    await session.handle({ do: "run", id, repo: "uploader", post, mode, text });
    return id;
  };
  const answer = async (id: string, post: boolean): Promise<string> => {
    if (!post) {
      const draft = await until("bob's draft", () => session.view().current?.drafts.find((each) => each.id === id));
      await session.handle({ do: "discardDraft", chat: "#team", id, repo: "uploader" });
      return draft.text;
    }
    for (let tries = 0; tries < 200; tries += 1) {
      const result = (await alice.events({ chat: "#team" })).find((delivered) => delivered.event.kind === "job.result" && delivered.event.refs[0] === id);
      const said = result === undefined ? null : readContent(result.event);
      if (said?.kind === "job.result") {
        return said.content.text;
      }
      await delay(50);
    }
    throw new Error(`no answer to ${id}`);
  };
  return { alice, session, checkout, ask, answer };
}

await test(
  "a follow-up goes on in its thread's session only at the mode and delivery its earlier run had: an agent that switched its own mode at full cannot carry that into a read-only run, nor a reply told it is posted into one reviewed",
  { timeout: 60_000 },
  async (t) => {
    const { session, checkout, ask, answer } = await bobsDesk(t);
    const first = await ask("@bob/uploader switch", "full", true);
    assert.match(await answer(first, true), /^turn 1: .*switched$/);
    const readOnly = await ask("@bob/uploader edit", "read-only", true, first);
    assert.match(await answer(readOnly, true), /^turn 1: .*edit refused$/); // Afresh, so asked, and refused; in the session switched at full it would have edited without asking.
    assert.equal(existsSync(join(checkout, "edited.txt")), false);
    const reviewed = await ask("@bob/uploader read", "read-only", false, first);
    assert.match(await answer(reviewed, false), /^turn 1: /); // Afresh: the read-only run before it posted.
    const again = await ask("@bob/uploader read", "read-only", false, first);
    assert.equal(await answer(again, false), "turn 2: read"); // The same mode and delivery go on.
    await session.stop();
    assert.deepEqual(await left(checkout), []);
  }
);

await test(
  "a run left waiting on its owner's answer for longer than STALE is still believed working by teammates: the owner's desk tells the chat again, unchanged, what it is doing, and a withdrawal is judged by that",
  { timeout: 30_000 },
  async (t) => {
    let clock = NOW; // Everyone's, and the hub's: it moves only when the test says.
    const { alice, session, ask, answer } = await bobsDesk(t, [], { heartbeat: 0.3 }, () => clock);
    const id = await ask("@bob/uploader edit", "supervised", true);
    const card = await until("bob is asked", () => session.view().current?.asks[0]);
    /** Where alice's window has bob's job, by what the hub holds now. */
    const folded = async (): Promise<[string, string][]> => {
      const log = new ChatLog("alice");
      log.add((await alice.events({ chat: "#team" })).map((delivered) => ({ ...delivered, trusted: true })));
      const message = log.message(id);
      return message === null ? [] : log.requests(message, clock).map((request) => [request.state, request.summary]);
    };
    const later = NOW + STALE - 60; // Bob has left the card for fifteen minutes.
    clock = later;
    for (let tries = 0; tries < 200 && !(await alice.events({ chat: "#team" })).some((each) => each.event.kind === "job.progress" && each.event.ts >= later); tries += 1) {
      await delay(50);
    }
    clock = NOW + STALE + 60;
    assert.deepEqual(await folded(), [["working", "waiting for approval"]]);
    await alice.publish("#team", "job.withdrawn", { agent: "bob/uploader" }, [id]); // Counts for nothing: bob's desk said it is still going.
    assert.deepEqual(await folded(), [["working", "waiting for approval"]]);
    await session.handle({ do: "permit", ask: card.id, answer: "refuse" });
    assert.match(await answer(id, true), /edit refused$/);
  }
);

await test("an ask the agent takes back goes from its owner's view while the run goes on, and answering it then says it is no longer waiting", { timeout: 30_000 }, async (t) => {
  const { session, checkout, ask } = await bobsDesk(t);
  const id = await ask("@bob/uploader takeback, then slow", "supervised", true);
  const card = await until("bob is asked", () => session.view().current?.asks[0]);
  assert.equal(card.title, "Edit taken-back.txt");
  await until("the card goes", () => session.view().current?.asks.length === 0);
  assert.equal(session.view().current?.running, true); // Taken back by the agent, not by the run's end.
  await assert.rejects(session.handle({ do: "permit", ask: card.id, answer: "allow-once" }), { message: "your agent is no longer waiting for that answer" });
  assert.deepEqual(
    session
      .view()
      .current?.activity.filter((item) => item.kind === "permission")
      .map((item) => [item.title, item.outcome]),
    [["Edit taken-back.txt", "cancelled"]]
  );
  await session.handle({ do: "stop", id, repo: "uploader" });
  await session.stop();
  assert.deepEqual(await left(checkout), []);
});

await test(
  "an agent that fails the permission test is held to no mode from then on, in this session and the next: the view says why for every mode but full, and a run at any of them is refused",
  { timeout: 30_000 },
  async (t) => {
    const hub = await startHub(t, () => Date.now() / 1000);
    const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
    bob.saveAgents([fake("--no-pids", "--no-asking")], "fake");
    const dev = join(hub.dir, "dev-bob");
    mkdirSync(join(dev, "uploader", ".git"), { recursive: true });
    writeFileSync(join(dev, "uploader", ".git", "config"), `[remote "origin"]\n\turl = ${TEAM_REPOS}Platform/_git/uploader\n`);
    writeFileSync(join(dev, "uploader", ".git", "HEAD"), "ref: refs/heads/main\n");
    const hooks = { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) };
    const session = new Session(bob, dev, hooks, { presence: 1, describe: () => Promise.resolve({ branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: false }) });
    session.start();
    t.after(() => session.stop());

    assert.deepEqual(session.view().cannot, { "read-only": "", supervised: "", "auto-edits": "", full: "" }); // Over ACP, and not tested yet.
    assert.equal((await session.testPermissions("fake")).status, "fail");
    const why = "Fake wrote edited.txt without asking when its permissions were tested, at version 1.2.3, so it cannot be limited: it runs only with full access until it passes the test";
    const cannot = { "read-only": why, supervised: why, "auto-edits": why, full: "" };
    assert.deepEqual(session.view().cannot, cannot);
    assert.deepEqual(new Session(bob, dev, hooks).view().cannot, cannot); // Saved, so the next session knows too.

    const text = "@bob/uploader edit the README";
    const { id } = (await alice.publish("bob", "message", { text, via: "cli" })).event;
    await session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
    for (let tries = 0; tries < 200 && session.view().waiting === 0; tries += 1) {
      await delay(50);
    }
    await assert.rejects(session.handle({ do: "run", id, repo: "uploader", post: true, mode: "supervised", text }), {
      message: `${why}. To run it supervised, make an agent spoken to over ACP, such as Cursor or Copilot, the one that answers on the Setup page, or run it with full access`
    });
    await assert.rejects(session.testPermissions("nobody"), { message: "you have no agent nobody" });
  }
);

await test(
  "stopping the desk ends a permission test still going, whether it is greeting the agent or the agent is at work, waits until the agent has gone, and saves nothing",
  { timeout: 30_000 },
  async (t) => {
    const hub = await startHub(t, () => Date.now() / 1000);
    const bob = await hub.join("bob");
    const dev = join(hub.dir, "dev-bob");
    mkdirSync(dev);
    const dir = folder(t);
    const pids = join(dir, "pids");
    const mute: Agent = { id: "mute", label: "Mute", protocol: "acp", command: "sh", args: ["-c", `echo $$ >> '${pids}'; exec sleep 60`] }; // Never says a word of ACP, so greeting it waits.
    const hooks = { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) };
    // The scripted agent with --deaf is greeted, then works on the test's request with a child of its own, taking no notice of a stop until it is killed two seconds later:
    // four processes by then, counting the mute one.
    for (const [agent, count] of [
      [mute, 1],
      [fake(`--pids=${pids}`, "--deaf"), 4]
    ] as const) {
      bob.saveAgents([agent], agent.id);
      const session = new Session(bob, dev, hooks, { presence: 1 });
      session.start();
      const testing = session.testPermissions(agent.id);
      await started(dir, count);
      await session.stop();
      assert.deepEqual(await left(dir), [], agent.label); // Gone once stop() is done, given a moment for the system to take them away.
      assert.equal((await testing).status, "fail", agent.label);
    }
    assert.deepEqual(permissionTests(bob.home), {});
  }
);

/**
 * The phase's two-session scenario: alice asks bob's agent, the scripted one, from her window, and bob lets it run at a mode. Each step is in a channel of its own, so that no earlier request
 * reaches the agent's prompt as context: the agent acts on every word of the prompt it knows. Bob reviews what it drafts, as a teammate's request is first offered, except where it posts.
 */
await test(
  "two sessions and the scripted agent: a teammate's request accepted read-only cannot write a file; accepted supervised it asks the owner and writes only once allowed, the owner seeing each step as it happens and the teammate only the coarse summary; the owner's own runs at the mode for their own; and Stop ends a run within three seconds",
  { timeout: 60_000 },
  async (t) => {
    const hub = await startHub(t, () => Date.now() / 1000);
    const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
    bob.saveAgents([fake()], "fake");
    const channels = ["#readonly", "#supervised", "#own", "#stop"];
    for (const person of [alice, bob]) {
      for (const channel of channels) {
        await person.publish(channel, "channel.join", {});
      }
    }
    const dev = join(hub.dir, "dev-bob");
    const checkout = join(dev, "uploader");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${TEAM_REPOS}Platform/_git/uploader\n`);
    writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
    const hooks = { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) };
    const arrivals: Arrival[] = [];
    const told = {
      ...hooks,
      arrived: (arrival: Arrival) => {
        arrivals.push(arrival);
      }
    };
    const owner = new Session(bob, dev, told, { presence: 1, progress: 0.2, describe: () => Promise.resolve({ branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: false }) });
    const asker = new Session(alice, join(hub.dir, "dev-alice"), hooks, { presence: 1 });
    for (const session of [owner, asker]) {
      session.start();
      t.after(() => session.stop());
    }
    const edited = join(checkout, "edited.txt");

    /** What a session shows of the request with this id, in the chat it opens. */
    const shown = (session: Session, chat: string, id: string): RequestView | undefined => {
      session.handle({ do: "open", chat }).catch(() => undefined);
      return session
        .view()
        .current?.messages.find((message) => message.id === id)
        ?.requests.at(0);
    };
    const until = async <T>(what: string, find: () => T | undefined | false): Promise<T> => {
      for (let tries = 0; tries < 200; tries += 1) {
        const found = find();
        if (found !== undefined && found !== false) {
          return found;
        }
        await delay(50);
      }
      throw new Error(`never happened: ${what}`);
    };
    /** Alice asks from her window; bob, once he sees it, lets it run at `mode`. */
    const asked = async (chat: string, text: string, mode: PermissionMode, post: boolean): Promise<string> => {
      await until("alice's chats loaded", () => asker.view().rows.some((row) => row.chat === chat));
      await asker.handle({ do: "open", chat });
      await asker.handle({ do: "send", chat, text });
      const id = await until("alice's request", () => asker.view().current?.messages.find((message) => message.body === text)?.id);
      await until("bob can run it", () => shown(owner, chat, id)?.status.kind === "ready");
      await owner.handle({ do: "run", id, repo: "uploader", post, mode, text });
      return id;
    };
    /** The mode the one run in a chat was accepted at, as alice reads it. */
    const accepted = async (chat: string): Promise<string> => {
      const said = (await alice.events({ chat })).map((delivered) => readContent(delivered.event)).find((each) => each.kind === "job.accepted");
      return said?.kind === "job.accepted" ? said.content.mode : "";
    };

    // Accepted read-only, as a teammate's request is first offered, the agent is refused every edit it asks for, and writes nothing.
    const readOnly = await asked("#readonly", "@bob/uploader edit the README", "read-only", false);
    const draft = await until("bob's draft", () => owner.view().current?.drafts.find((each) => each.id === readOnly));
    assert.match(draft.text, /^turn 1: read; edit refused; edit refused$/); // One edit is the request's, one the prompt's "may edit" before it is sent.
    assert.equal(existsSync(edited), false);
    assert.equal(await accepted("#readonly"), "read-only");
    await owner.handle({ do: "discardDraft", chat: "#readonly", id: readOnly, repo: "uploader" });

    // Accepted supervised, the agent's edit waits for bob's answer, in his view and as an arrival for when he is not looking, and the file is written only once he allows it. Alice sees no ask.
    const supervised = await asked("#supervised", "@bob/uploader edit the README", "supervised", true);
    const ask = await until("bob is asked", () => owner.view().current?.asks[0]);
    /** Bob's view of the supervised run's activity, each item as its kind, title, status and outcome. */
    const steps = (): string[][] =>
      (owner.view().current?.activity ?? []).filter((item) => item.run === runOf(supervised, "uploader")).map((item) => [item.kind, item.title, item.status, item.outcome]);
    assert.deepEqual(steps(), [
      ["state", "Started Fake, supervised", "done", ""],
      ["tool", "Read README.md", "done", "done"],
      ["tool", "Edit edited.txt", "running", ""],
      ["permission", "Edit edited.txt", "running", ""]
    ]); // As it happens: the edit waits on his answer.
    assert.deepEqual({ ...ask, id: "" }, { id: "", run: runOf(supervised, "uploader"), action: "edit", title: "Edit edited.txt", detail: JSON.stringify({ title: "Edit edited.txt" }, null, 1) });
    assert.deepEqual(arrivals.at(-1), { chat: "#supervised", title: "Your uploader agent is waiting for your answer", body: "Edit edited.txt", forMe: true, rings: true });
    await delay(300);
    assert.equal(existsSync(edited), false);
    // Alice sees only the coarse summary: no ask, and nothing of what the agent is doing beyond that.
    const coarse = await until("alice sees what it is doing", () => {
      const status = shown(asker, "#supervised", supervised)?.status;
      return status?.kind === "working" && status.summary === "waiting for approval" && status;
    });
    assert.deepEqual(coarse, { kind: "working", branch: "main", summary: "waiting for approval" });
    assert.deepEqual([asker.view().current?.asks, asker.view().current?.activity], [[], []]);
    assert.ok(!JSON.stringify(asker.view()).includes("edited.txt"));
    await owner.handle({ do: "permit", ask: ask.id, answer: "allow-once" });
    await until("the answer, posted", () => asker.view().current?.messages.some((message) => message.agent === "uploader" && message.body === "turn 1: read; edit allowed"));
    assert.equal(existsSync(edited), true);
    assert.deepEqual(owner.view().current?.asks, []);
    await until("bob's feed of the run to its end", () => steps().at(-1)?.[1] === "Answered");
    assert.deepEqual(steps(), [
      ["state", "Started Fake, supervised", "done", ""],
      ["tool", "Read README.md", "done", "done"],
      ["tool", "Edit edited.txt", "done", "done"],
      ["permission", "Edit edited.txt", "done", "allowed"],
      ["message", "turn 1: read; edit allowed", "done", ""],
      ["state", "Answered", "done", ""]
    ]);
    await assert.rejects(owner.handle({ do: "permit", ask: ask.id, answer: "allow-once" }), { message: "your agent is no longer waiting for that answer" });
    rmSync(edited);

    // Bob's own request from his window runs at once, at the mode for his own requests, "auto-edits" when he joined: it edits without asking.
    await owner.handle({ do: "open", chat: "#own" });
    await owner.handle({ do: "send", chat: "#own", text: "@bob/uploader edit the README" });
    await until("bob's own answer", () => owner.view().current?.messages.some((message) => message.agent === "uploader" && message.body === "turn 1: read; edit allowed"));
    assert.equal(existsSync(edited), true);
    assert.equal(await accepted("#own"), "auto-edits");

    // Stop ends a run within three seconds, for the owner and for whoever asked.
    const ran = readFileSync(join(checkout, "pids"), "utf8").trim().split("\n").length;
    const slow = await asked("#stop", "@bob/uploader slow", "read-only", true);
    await started(checkout, ran + 2);
    const stoppedAt = Date.now();
    await owner.handle({ do: "stop", id: slow, repo: "uploader" });
    await until("bob sees it stopped", () => shown(owner, "#stop", slow)?.status.kind === "ready");
    await until("alice sees it stopped", () => shown(asker, "#stop", slow)?.status.kind === "stopped");
    assert.ok(Date.now() - stoppedAt < 3000, `took ${String(Date.now() - stoppedAt)} ms to stop`);
    assert.deepEqual(
      owner.view().current?.activity.map((item) => item.title),
      ["Started Fake, read-only", "Read README.md", "Stopped"]
    );
    await owner.stop(); // And the sessions the answered runs kept for a follow-up with it.
    assert.deepEqual(await left(checkout), []);

    // Nothing the agent did reached the hub beyond those few words: no item, path or command is in any event it stores.
    const stored = new DatabaseSync(join(hub.dir, "hub.db"), { readOnly: true });
    const rows = z.array(z.object({ kind: z.string(), content: z.string(), refs: z.string() })).parse(stored.prepare("SELECT kind, content, refs FROM events ORDER BY seq").all());
    stored.close();
    const progress = rows.filter((row) => row.kind === "job.progress").map((row) => ({ request: row.refs, summary: z.object({ summary: z.string() }).parse(JSON.parse(row.content)).summary }));
    const said = progress.map((each) => each.summary);
    assert.ok(said.includes("waiting for approval") && said.every((summary) => SUMMARIES.some((each) => each === summary)), said.join(", "));
    assert.ok(
      progress.every((each, index) => index === 0 || progress[index - 1]?.request !== each.request || progress[index - 1]?.summary !== each.summary),
      said.join(", ")
    ); // Only when it changed.
    for (const leak of ["README.md", "edited.txt", "npm test", "Started Fake", checkout]) {
      assert.deepEqual(
        rows.filter((row) => JSON.stringify(row).includes(leak)),
        [],
        leak
      );
    }
  }
);
