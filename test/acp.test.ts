/**
 * The ACP runner against a scripted agent, test/fixtures/fake-acp-agent.ts, run with node: its answer, signing in, what each mode allows, asks and refuses, stopping,
 * follow-ups, also through a session against a real hub, and that nothing the agent started is left behind. Then the phase's two-session scenario, with what the hub stores after it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { eventIsAuthentic, publicHex } from "../src/core/sign.ts";
import type { Agent, Delivered, PermissionMode } from "../src/core/wire.ts";
import { acpRunner } from "../src/desk/agents/acp.ts";
import { agentEnv, agentKey } from "../src/desk/agentKeys.ts";
import { permissionTests } from "../src/desk/doctor.ts";
import { Feed } from "../src/desk/agents/activity.ts";
import type { FollowUp, PermissionAsk, RunHandlers } from "../src/desk/agents/runner.ts";
import { AgentCancelledError, AgentTimedOutError } from "../src/desk/client.ts";
import type { Client } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import type { Options } from "../src/desk/session.ts";
import { runOf } from "../src/shared/ipc.ts";
import type { ActivityItem, Arrival, Notice, RequestView } from "../src/shared/ipc.ts";
import { checkout as gitCheckout, NOW, ownHome, startHub, TEAM_REPOS } from "./startHub.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");
const never = new AbortController().signal;
ownHome(); // A teammate's run above read-only goes on a clean copy, under ~/.player-two/worktrees.

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
  feed.update({ sessionUpdate: "tool_call", toolCallId: "t6", title: "Terminal", kind: "execute", status: "completed", rawOutput: "x".repeat(10_000) });
  assert.equal(detail("t6"), "x".repeat(8_000)); // At most 8 KB of it.
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
  "an ACP agent's answer is its messages, a blank line between each, its session has Player Two's MCP server without --allow-send when it is told who it is and none when not, and nothing it started is left once it has answered",
  { timeout: 20_000 },
  async (t) => {
    const dir = folder(t);
    const { handlers, items } = recorder();
    const answer = await acpRunner(fake()).run("mcp, and read", dir, "full", handlers, never);
    assert.equal(answer, "turn 1: read; servers []"); // As under a grant: no environment, and no MCP server.
    // In a run its owner let go, the agent and its MCP server are both told which agent it is, so both sign as the agent.
    const env = agentEnv(dir, "alice", "uploader");
    const server = { name: "player-two", command: "player-two", args: ["mcp"], env: Object.entries(env).map(([name, value]) => ({ name, value })) };
    assert.equal(await acpRunner(fake()).run("mcp, and whoami", dir, "full", handlers, never, undefined, env), `turn 1: servers ${JSON.stringify([server])}; as alice/uploader`);
    assert.deepEqual(server.env, [
      { name: "PLAYER_TWO_AGENT", value: "alice/uploader" },
      { name: "PLAYER_TWO_AGENT_KEY_FILE", value: join(dir, "agents", "uploader.key") }
    ]);
    assert.deepEqual(
      items.filter((item) => item.kind === "tool").map((item) => [item.id, item.kind, item.title, item.status, item.quiet]),
      [
        ["read", "tool", "Read README.md", "running", true],
        ["read", "tool", "Read README.md", "done", true]
      ]
    );
    assert.deepEqual(await left(dir), []);
    // Each message the agent sends in its turn is in the answer, a blank line between them.
    assert.equal(await acpRunner(fake()).run("twice", dir, "full", handlers, never), "Looking at it.\n\nturn 1: said twice");
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

await test("a stop ends a wait for the owner's answer at once, telling the agent its request is cancelled", { timeout: 30_000 }, async (t) => {
  const dir = folder(t);
  const stop = new AbortController();
  let gone: AbortSignal | undefined;
  const owner: RunHandlers = {
    activity: () => undefined,
    permission: (_ask, signal) => {
      gone = signal;
      setTimeout(() => {
        stop.abort();
      }, 50);
      return new Promise(() => {
        // Bob never answers.
      });
    }
  };
  const stoppedAt = Date.now() + 50;
  await assert.rejects(acpRunner(fake()).run("edit", dir, "supervised", owner, stop.signal), AgentCancelledError);
  assert.ok(Date.now() - stoppedAt < 1500, `took ${String(Date.now() - stoppedAt)} ms`); // Not the two seconds after which an agent still at work is killed.
  assert.equal(gone?.aborted, true);
  assert.deepEqual(await left(dir), []);
});

await test("a tool call's title, and an ask's, is one line of at most 200 characters", { timeout: 20_000 }, async (t) => {
  const { handlers, items, asks } = recorder();
  assert.equal(await acpRunner(fake()).run("long", folder(t), "supervised", handlers, never), "turn 1: long refused");
  const title = `Edit ${"x".repeat(194)}…`;
  assert.deepEqual(
    asks.map((ask) => ask.title),
    [title]
  );
  assert.deepEqual(
    items.filter((item) => item.kind === "tool" || item.kind === "permission").map((item) => [item.kind, item.title]),
    [
      ["tool", title],
      ["permission", title],
      ["permission", title],
      ["tool", title]
    ]
  );
});

await test("a request to act from another session than the run's is refused as cancelled, whatever the mode allows", { timeout: 20_000 }, async (t) => {
  assert.equal(await acpRunner(fake()).run("stray", folder(t), "full", recorder("allow-once").handlers, never), "turn 1: stray cancelled");
});

await test("a run that answers after its runner was closed keeps nothing for a follow-up", { timeout: 20_000 }, async (t) => {
  const dir = folder(t);
  const runner = acpRunner(fake(), { limit: 60, idle: 60 });
  let closed: Promise<void> = Promise.resolve();
  const owner: RunHandlers = {
    activity: () => undefined,
    permission: () => {
      closed = runner.close(); // While the run is going, as when the agent that answers changes or the desk stops.
      return delay(200).then((): "allow-once" => "allow-once");
    }
  };
  assert.equal(await runner.run("edit", dir, "supervised", owner, never, { key: "root alice uploader", text: "edit" }), "turn 1: edit allowed");
  await closed;
  assert.deepEqual(await left(dir), []);
});

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
      await session.handle({ do: "run", id, repo: "uploader", post: true, mode: "read-only", text }); // In the checkout: a run on a clean copy keeps no session.
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
  readonly bob: Client;
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
  for (const person of [alice, bob]) {
    await person.publish("#team", "channel.join", {});
  }
  const dev = join(hub.dir, "dev-bob");
  const checkout = gitCheckout(dev, "uploader");
  bob.saveAgents([fake(`--pids=${join(checkout, "pids")}`, ...args)], "fake"); // Here, whether it runs in the checkout or on a clean copy.
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
  return { alice, bob, session, checkout, ask, answer };
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
  "a run let ask other agents neither leaves a session to follow up in nor goes on in one: the user's own reply in its thread, which runs let ask others as their own does, starts afresh",
  { timeout: 60_000 },
  async (t) => {
    const { session, answer } = await bobsDesk(t);
    /** Bob asks his own agent from his window, in the thread of `root` when given: it runs at once, let ask others. Resolves with the request's id. */
    const own = async (text: string, root?: string): Promise<string> => {
      await session.handle(root === undefined ? { do: "send", chat: "#team", text } : { do: "reply", root, text });
      const sent = await until("bob's own request", () =>
        session
          .view()
          .current?.messages.flatMap((message) => [message, ...message.replies])
          .find((message) => message.body === text)
      );
      return sent.id;
    };
    const first = await own("@bob/uploader read");
    assert.match(await answer(first, true), /^turn 1: /);
    assert.match(await answer(await own("@bob/uploader read again", first), true), /^turn 1: /); // In a session the first left open it would be its second turn.
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
    /** Whether the chat has been told what bob's agent is doing, `summary` when given, at `since` or later. */
    const told = async (since: number, summary?: string): Promise<boolean> =>
      (await alice.events({ chat: "#team" })).some((each) => {
        const said = readContent(each.event);
        return each.event.ts >= since && said.kind === "job.progress" && (summary === undefined || said.content.summary === summary);
      });
    // Told that it waits before the clock moves, so that what the chat is told after that can only be the same again.
    for (let tries = 0; tries < 200 && !(await told(NOW, "waiting for approval")); tries += 1) {
      await delay(50);
    }
    const later = NOW + STALE - 60; // Bob has left the card for fifteen minutes.
    clock = later;
    for (let tries = 0; tries < 200 && !(await told(later)); tries += 1) {
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
  "a run that ends while its agent still asks takes the ask out of the view; on a clean copy, which keeps no session, its agent ends with it, the ask cancelled",
  { timeout: 30_000 },
  async (t) => {
    const { session, ask, answer } = await bobsDesk(t);
    const id = await ask("@bob/uploader leave", "supervised", true);
    assert.match(await answer(id, true), /left$/);
    await until("the run is over", () => session.view().current?.running === false);
    assert.deepEqual(session.view().current?.asks, []);
    await until("the ask, cancelled", () => session.view().current?.activity.some((item) => item.kind === "permission" && item.title === "Edit left.txt" && item.outcome === "cancelled"));
  }
);

await test("the chat is told what a run is doing at once, then no sooner than the least time between two tellings, and nothing once the run has ended", { timeout: 30_000 }, async (t) => {
  const { alice, ask, answer } = await bobsDesk(t, [], { progress: 2 });
  const id = await ask("@bob/uploader read, edit and run", "full", true); // Each step a change of what it is doing, all within the two seconds.
  assert.match(await answer(id, true), /read; edit allowed; run allowed$/);
  await delay(2500); // Past when the chat would next have been told.
  const told = (await alice.events({ chat: "#team" })).filter((each) => each.event.kind === "job.progress" && each.event.refs[0] === id);
  assert.equal(told.length, 1);
});

await test("the session keeps the newest 500 items of a run, and the activity of the 20 runs that ended last", { timeout: 60_000 }, async (t) => {
  const { session, ask, answer } = await bobsDesk(t);
  const first = await ask("@bob/uploader many", "read-only", true); // In the checkout, where a session is kept for the runs that follow.
  assert.match(await answer(first, true), /read many$/);
  const items = await until("the run's end in its feed", () => {
    const kept = session.view().current?.activity ?? [];
    return kept.at(-1)?.title === "Answered" && kept;
  });
  assert.equal(items.length, 500); // Of its 604: started, the prompt's read, 600 more, its message and its end.
  assert.deepEqual(items[0]?.title, "Read README.md");
  // Twenty-one more runs, each in the first one's thread, so that each goes on in its agent's session and takes no time to start.
  const ids = [first];
  for (let index = 0; index < 21; index += 1) {
    await until("the run before is over", () => session.view().current?.running === false);
    const id = await ask("@bob/uploader read", "read-only", true, first);
    await answer(id, true);
    ids.push(id);
  }
  await until("the last run is over", () => session.view().current?.running === false);
  assert.deepEqual(
    [...new Set(session.view().current?.activity.map((item) => item.run))],
    ids.slice(1).map((id) => runOf(id, "uploader"))
  ); // The first run's is gone: when the last started, the twenty-one before it had ended, one more than are kept.
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
    const channels = ["#readonly", "#supervised", "#own", "#stop"];
    for (const person of [alice, bob]) {
      for (const channel of channels) {
        await person.publish(channel, "channel.join", {});
      }
    }
    const dev = join(hub.dir, "dev-bob");
    const checkout = gitCheckout(dev, "uploader");
    bob.saveAgents([fake(`--pids=${join(checkout, "pids")}`)], "fake"); // Here, whether it runs in the checkout or on a clean copy.
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

    // Accepted supervised, the agent's edit waits for bob's answer, in his view and as an arrival for when he is not looking, and the file is written only once he allows it; then so does its command.
    // Alice sees no ask. It runs on a clean copy of bob's checkout, which the file is never written to.
    const supervised = await asked("#supervised", "@bob/uploader edit the README, then run the tests", "supervised", true);
    const copy = join(homedir(), ".player-two", "worktrees", createHash("sha256").update(runOf(supervised, "uploader")).digest("hex").slice(0, 12));
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
    const command = await until("bob is asked again", () => owner.view().current?.asks.find((each) => each.id !== ask.id));
    assert.deepEqual(
      { ...command, id: "" },
      { id: "", run: runOf(supervised, "uploader"), action: "execute", title: "Run npm test", detail: JSON.stringify({ command: "npm test", cwd: copy }, null, 1) }
    );
    await owner.handle({ do: "permit", ask: command.id, answer: "allow-once" });
    await until("the answer, posted", () => asker.view().current?.messages.some((message) => message.agent === "uploader" && message.body === "turn 1: read; edit allowed; run allowed"));
    assert.equal(existsSync(edited), false);
    assert.deepEqual(owner.view().current?.asks, []);
    await until("bob's feed of the run to its end", () => steps().at(-1)?.[1] === "Answered");
    assert.deepEqual(steps(), [
      ["state", "Started Fake, supervised", "done", ""],
      ["tool", "Read README.md", "done", "done"],
      ["tool", "Edit edited.txt", "done", "done"],
      ["permission", "Edit edited.txt", "done", "allowed"],
      ["tool", "Ran npm test", "done", "done"],
      ["permission", "Run npm test", "done", "allowed"],
      ["message", "turn 1: read; edit allowed; run allowed", "done", ""],
      ["state", "Answered", "done", ""]
    ]);
    const fed = JSON.stringify(owner.view().current?.activity); // Everything the leak check below looks for, bob's own feed has.
    await assert.rejects(owner.handle({ do: "permit", ask: ask.id, answer: "allow-once" }), { message: "your agent is no longer waiting for that answer" });

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

    // Nothing the agent did reached the hub beyond those few words, and the change its supervised run made, as the one patch: no item, path or command is in any other event it stores.
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
    const patches = rows.filter((row) => row.kind === "patch");
    assert.deepEqual(
      patches.map((row) => z.object({ diff: z.string() }).parse(JSON.parse(row.content)).diff.split("\n")[0]),
      ["diff --git a/edited.txt b/edited.txt"]
    );
    for (const leak of ["README.md", "edited.txt", "npm test", "Started Fake", copy]) {
      assert.ok(fed.includes(leak), leak);
      assert.deepEqual(
        rows.filter((row) => row.kind !== "patch" && JSON.stringify(row).includes(leak)),
        [],
        leak
      );
    }
  }
);

/**
 * Phase 4's part of the two-session scenario: jacob lets bob ask his agent, the scripted one, with a grant from his window, and from then on nobody touches jacob's session while bob's requests
 * run, or wait. Each step is in a channel of its own, so that no earlier request reaches the agent's prompt as context.
 */
await test(
  "two sessions and the scripted agent under a grant: bob's request runs read-only with nobody at jacob's desk, drafted for jacob's review or posted signed by the agent as the grant says, and a write in it is refused; once jacob revokes the grant, under a grant that names only carol, under one bob made himself, and once the grant has expired, bob's next request waits for jacob",
  { timeout: 60_000 },
  async (t) => {
    let clock = NOW; // Everyone's, and the hub's: it moves only when the test says.
    const hub = await startHub(t, () => clock);
    const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
    jacob.saveAgents([fake("--no-pids")], "fake"); // No pids file, which the permission test would take for a file it wrote.
    for (const person of [bob, jacob]) {
      for (const channel of ["#review", "#revoked", "#post", "#carol", "#theirs", "#expired"]) {
        await person.publish(channel, "channel.join", {});
      }
    }
    const dev = join(hub.dir, "dev-jacob");
    const checkout = join(dev, "uploader");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${TEAM_REPOS}Platform/_git/uploader\n`);
    writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
    const hooks = { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) };
    const arrivals: Arrival[] = [];
    const notices: Notice[] = [];
    const told = {
      ...hooks,
      arrived: (arrival: Arrival) => {
        arrivals.push(arrival);
      },
      notice: (notice: Notice) => {
        notices.push(notice);
      }
    };
    const owner = new Session(jacob, dev, told, { presence: 1, describe: () => Promise.resolve({ branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: false }) });
    const asker = new Session(bob, join(hub.dir, "dev-bob"), hooks, { presence: 1 });
    for (const session of [owner, asker]) {
      session.start();
      t.after(() => session.stop());
    }
    await until("both loaded, and jacob's checkout shared", () => owner.view().loaded && owner.view().myRepos.includes("uploader") && asker.view().loaded);
    assert.equal((await owner.testPermissions("fake")).status, "ok"); // A grant below full runs an agent over ACP only once it has shown it asks.
    const edited = join(checkout, "edited.txt");

    /** Jacob grants from his window: read-only, to `askers`, for `lasts` seconds. Resolves with the grant's id. */
    const grant = async (askers: readonly string[], delivery: "review" | "post", lasts = 3600): Promise<string> => {
      await owner.handle({ do: "grant", repo: "uploader", askers, mode: "read-only", delivery, lasts, runsPerDay: 20 });
      return owner.view().grants.at(-1)?.id ?? "";
    };
    /** Bob asks in `chat` from his window. Resolves with the request's id. */
    const asks = async (chat: string, text: string): Promise<string> => {
      await until(`bob has ${chat}`, () => asker.view().rows.some((row) => row.chat === chat));
      await asker.handle({ do: "open", chat });
      await asker.handle({ do: "send", chat, text });
      return until("bob's request", () => asker.view().current?.messages.find((message) => message.body === text)?.id);
    };
    /** The job's events in the hub's log, oldest first, but for what the run said it was doing: who sent each, an acceptance with what it let go at and who let it, an answer whether reviewed. */
    const job = async (chat: string, id: string): Promise<string[]> =>
      (await bob.events({ chat, limit: 100 }))
        .filter(({ event }) => event.refs[0] === id && event.kind.startsWith("job.") && event.kind !== "job.progress")
        .map(({ event }) => {
          const said = readContent(event);
          let what = "";
          if (said.kind === "job.accepted") {
            what = ` ${said.content.mode} ${said.content.delivery} ${said.content.by === "owner" ? "by hand" : `under ${said.content.by.grant}`}`;
          } else if (said.kind === "job.result") {
            what = ` reviewed ${String(said.content.reviewed)}`;
          }
          return `${event.kind}${what} by ${event.author}`;
        })
        .reverse();
    /** Bob asks, and the request waits for jacob: nothing runs, the chat is told nothing, and bob sees it waiting. */
    const waits = async (chat: string, waiting: number): Promise<void> => {
      const id = await asks(chat, "@jacob/uploader have a look");
      await until("jacob's desk has it waiting", () => owner.view().waiting === waiting);
      await delay(300);
      assert.deepEqual([owner.view().busy.working, await job(chat, id)], [0, []], chat);
      assert.equal(asker.view().current?.messages.find((message) => message.id === id)?.requests[0]?.status.kind, "waiting", chat);
    };

    // Read-only, for review: bob's request runs, refused every edit it tries, and its answer waits as a draft for jacob, who reads it and sends it.
    const review = await grant(["bob"], "review");
    const first = await asks("#review", "@jacob/uploader edit the README");
    await until("jacob's draft", () => owner.view().busy.unsent === 1);
    assert.deepEqual([arrivals.at(-1)?.chat, arrivals.at(-1)?.title], ["#review", "Your uploader agent's draft is ready to review"]);
    assert.equal(existsSync(edited), false);
    assert.deepEqual(await job("#review", first), [`job.accepted read-only review under ${review} by jacob`]);
    await owner.handle({ do: "open", chat: "#review" });
    const draft = owner.view().current?.drafts[0];
    assert.match(draft?.text ?? "", /^turn 1: read; edit refused; edit refused$/); // One edit is the request's, one the prompt's "may edit".
    await owner.handle({ do: "sendDraft", chat: "#review", id: first, repo: "uploader", text: draft?.text ?? "" });
    const reviewed = await until("bob sees the answer", () => asker.view().current?.messages.find((message) => message.agent === "uploader"));
    assert.deepEqual(reviewed.grant, { id: review, mode: "read-only", expires: NOW + 3600 }); // Bob sees whose grant it ran under, and until when.

    // Revoked from his window, it lets nothing more go, and bob no longer sees it last until then.
    await owner.handle({ do: "revoke", id: review });
    await until("bob sees it revoked", () => asker.view().current?.messages.find((message) => message.id === reviewed.id)?.grant?.expires === null);
    await waits("#revoked", 1);

    // Read-only, posted directly: bob's request runs, refused its edit and its command, and the answer goes out at once, signed by jacob's agent and not by jacob.
    const post = await grant(["bob"], "post");
    const second = await asks("#post", "@jacob/uploader edit the README, then run the tests");
    const posted = await until("the answer, posted", () => asker.view().current?.messages.find((message) => message.agent === "uploader"));
    assert.match(posted.body, /^turn 1: read; edit refused; run refused$/);
    assert.equal(existsSync(edited), false);
    assert.deepEqual(await job("#post", second), [`job.accepted read-only post under ${post} by jacob`, "job.result reviewed false by jacob/uploader"]);
    const answer = (await bob.events({ chat: "#post" })).find(({ event }) => event.kind === "job.result")?.event;
    assert.ok(answer !== undefined);
    const keys = { agent: publicHex(agentKey(jacob.home, "uploader")), jacob: (await bob.users()).find((person) => person.name === "jacob")?.pubkey ?? "" };
    assert.deepEqual([eventIsAuthentic(answer, keys.agent), eventIsAuthentic(answer, keys.jacob)], [true, false]);

    // A grant that names carol does nothing for bob.
    await owner.handle({ do: "revoke", id: post });
    await grant(["carol"], "post");
    await waits("#carol", 2);

    // Nor does one bob makes of jacob's agent himself: only its owner can grant it.
    await bob.publish("*", "grant", { agent: "jacob/uploader", askers: ["bob"], mode: "full", delivery: "post", expires: NOW + 3600, runsPerDay: 20 });
    await waits("#theirs", 3);

    // Nor one jacob made for bob, once it has expired.
    await grant(["bob"], "post", 60);
    clock += 60;
    await waits("#expired", 4);
    assert.deepEqual(notices, []);
  }
);

/** What grantedDesk gives a test. */
interface Granted {
  readonly bob: Client;
  readonly session: Session; // Bob's, with a grant to alice of his agent, read-only, posted directly.
  readonly version: string; // The file whose words the scripted agent says are its version.
  // Alice asks bob's agent in their direct chat, in the thread of `root` when given. Resolves with the request's id.
  readonly ask: (text: string, root?: string) => Promise<string>;
  // The answer bob's agent posted to a request.
  readonly answered: (id: string) => Promise<string>;
  // Alice asks, and the request waits for bob, who is told `why` it did not run under his grant. Resolves with the request's id.
  readonly waits: (text: string, why: string) => Promise<string>;
}

const UNTESTED = "Fake's permissions have not been tested, so nothing shows it keeps to read-only with nobody watching. Run Test permissions on the Setup page";

/** Alice and bob on a hub of their own, and bob's desk, whose scripted agent has not had its permissions tested, with a grant to alice: read-only, posted directly. */
async function grantedDesk(t: TestContext): Promise<Granted> {
  const hub = await startHub(t, () => Date.now() / 1000);
  const [alice, bob] = [await hub.join("alice"), await hub.join("bob")];
  const version = join(hub.dir, "version");
  writeFileSync(version, "1.2.3");
  bob.saveAgents([fake("--no-pids", `--version-file=${version}`)], "fake"); // No pids file, which the permission test would take for a file it wrote.
  const dev = join(hub.dir, "dev-bob");
  mkdirSync(join(dev, "uploader", ".git"), { recursive: true });
  writeFileSync(join(dev, "uploader", ".git", "config"), `[remote "origin"]\n\turl = ${TEAM_REPOS}Platform/_git/uploader\n`);
  writeFileSync(join(dev, "uploader", ".git", "HEAD"), "ref: refs/heads/main\n");
  const notices: Notice[] = [];
  const hooks = {
    changed: () => undefined,
    notice: (notice: Notice) => {
      notices.push(notice);
    },
    arrived: () => undefined,
    confirmClone: () => Promise.resolve(false)
  };
  const session = new Session(bob, dev, hooks, { presence: 1, describe: () => Promise.resolve({ branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: false }) });
  session.start();
  t.after(() => session.stop());
  await until("bob's checkout shared", () => session.view().loaded && session.view().myRepos.includes("uploader"));
  await session.handle({ do: "grant", repo: "uploader", askers: ["alice"], mode: "read-only", delivery: "post", lasts: 3600, runsPerDay: 20 });
  const ask = async (text: string, root?: string): Promise<string> => (await alice.publish("bob", "message", { text: `@bob/uploader ${text}`, via: "cli" }, root === undefined ? [] : [root])).event.id;
  const status = (id: string): string | undefined => {
    session.handle({ do: "open", chat: "alice" }).catch(() => undefined);
    return session
      .view()
      .current?.messages.flatMap((message) => [message, ...message.replies])
      .find((message) => message.id === id)?.requests[0]?.status.kind;
  };
  const answered = async (id: string): Promise<string> => {
    for (let tries = 0; tries < 200; tries += 1) {
      const result = (await alice.events({ chat: "bob" })).find(({ event }) => event.kind === "job.result" && event.refs[0] === id);
      const said = result === undefined ? null : readContent(result.event);
      if (said?.kind === "job.result") {
        return said.content.text;
      }
      await delay(50);
    }
    throw new Error(`no answer to ${id}`);
  };
  const waits = async (text: string, why: string): Promise<string> => {
    const told = notices.length;
    const id = await ask(text);
    await until("its owner told why it waits", () => notices.length > told && status(id) === "ready");
    assert.deepEqual(notices.slice(told), [{ title: "your uploader agent did not run alice's request under your grant", body: why, severity: "error" }]);
    assert.deepEqual(await alice.events({ chat: "bob" }).then((found) => found.filter(({ event }) => event.refs[0] === id)), []);
    return id;
  };
  return { bob, session, version, ask, answered, waits };
}

await test(
  "a grant lets an agent over ACP run below full only once it has passed the permission test, at the version it says it is now: untested, or updated since, the request waits and its owner is told to test it; a run its owner starts is not held back",
  { timeout: 60_000 },
  async (t) => {
    const { session, version, ask, answered, waits } = await grantedDesk(t);

    // Never tested: alice's request waits. Bob can still run it himself, at the mode he chooses, as before.
    const untested = await waits("read", UNTESTED);
    await session.handle({ do: "run", id: untested, repo: "uploader", post: true, mode: "read-only", text: "@bob/uploader read" });
    assert.equal(await answered(untested), "turn 1: read");

    // Tested, then updated in place: the grant waits for the version that passed.
    assert.equal((await session.testPermissions("fake")).status, "ok");
    writeFileSync(version, "1.3.0");
    await waits("read again", "Fake is version 1.3.0 now, and passed its permission test at version 1.2.3. Run Test permissions on the Setup page again");

    // Tested again, it runs.
    assert.equal((await session.testPermissions("fake")).status, "ok");
    assert.equal(await answered(await ask("read once more")), "turn 1: read");
  }
);

await test(
  "a run under a grant is given no Player Two MCP server and is told which agent it is and the one chat it reads, nor goes on in a session its owner let go: one its owner lets go is given the server and its name alone",
  { timeout: 60_000 },
  async (t) => {
    const { bob, session, ask, answered, waits } = await grantedDesk(t);
    const server = { name: "player-two", command: "player-two", args: ["mcp"], env: Object.entries(agentEnv(bob.home, "bob", "uploader")).map(([name, value]) => ({ name, value })) };

    // Bob lets alice's request go himself: his agent is given the MCP server and told it is bob/uploader.
    const first = await waits("mcp whoami", UNTESTED);
    await session.handle({ do: "run", id: first, repo: "uploader", post: true, mode: "read-only", text: "@bob/uploader mcp whoami" });
    assert.equal(await answered(first), `turn 1: servers ${JSON.stringify([server])}; as bob/uploader`);

    // Once its permissions are tested, her reply in that thread runs under the grant, at the same mode and delivery: afresh, not in the session bob's run left open, with no server,
    // told it is bob/uploader, so the command signs as the agent, and that it reads her chat with bob alone; never let ask other agents, so told no request to ask them under.
    assert.equal((await session.testPermissions("fake")).status, "ok");
    const reply = await ask("mcp whoami", first);
    assert.equal(await answered(reply), "turn 1: servers []; as bob/uploader, reading alice only");
    const accepted = (await bob.events({ chat: "alice" })).map(({ event }) => (event.refs[0] === reply ? readContent(event) : null)).find((said) => said?.kind === "job.accepted");
    assert.ok(accepted?.kind === "job.accepted" && accepted.content.by !== "owner" && !accepted.content.delegate, JSON.stringify(accepted));
  }
);

await test(
  "a run its owner lets ask other agents gives its agent's MCP server --job naming the request it was asked, and its acceptance says so; one not let, as by default, gives the server without it and says not",
  { timeout: 60_000 },
  async (t) => {
    const { alice, session, ask, answer } = await bobsDesk(t);
    /** The arguments bob's agent's MCP server was started with for the request `id`, and whether its acceptance lets it ask other agents. */
    const given = async (id: string): Promise<[unknown, boolean | undefined]> => {
      const [, servers = ""] = /servers (.*)$/.exec(await answer(id, true)) ?? [];
      const accepted = (await alice.events({ chat: "#team" })).map(({ event }) => (event.refs[0] === id ? readContent(event) : null)).find((said) => said?.kind === "job.accepted");
      return [z.array(z.object({ args: z.array(z.string()) })).parse(JSON.parse(servers))[0]?.args, accepted?.kind === "job.accepted" ? accepted.content.delegate : undefined];
    };

    const { id } = (await alice.publish("#team", "message", { text: "@bob/uploader mcp", via: "cli" })).event;
    await until("bob can run it", () => session.view().current?.messages.some((message) => message.id === id && message.requests[0]?.status.kind === "ready"));
    await session.handle({ do: "run", id, repo: "uploader", post: true, mode: "read-only", text: "@bob/uploader mcp", delegate: true });
    assert.deepEqual(await given(id), [["mcp", "--job", id], true]);
    const plain = await ask("@bob/uploader mcp", "read-only", true);
    assert.deepEqual(await given(plain), [["mcp"], false]);
    // Bob's own request, from his window, runs at once and may ask others: each of their owners still decides.
    await session.handle({ do: "send", chat: "#team", text: "@bob/uploader mcp, mine" });
    const own = await until("bob's own request", () => session.view().current?.messages.find((message) => message.body === "@bob/uploader mcp, mine"));
    assert.deepEqual(await given(own.id), [["mcp", "--job", own.id], true]);
  }
);

/** Try `find` every 50 ms, for fifteen seconds, until it finds something. */
async function eventually<T>(what: string, find: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 300; tries += 1) {
    const found = await find();
    if (found !== undefined) {
      return found;
    }
    await delay(50);
  }
  throw new Error(`never happened: ${what}`);
}

await test(
  "time a run spends with an agent it asked at work is not its own; and once the root's time has passed since its owner let it ask others it is stopped, taking back what its agent asked that is still open, as is a run under it on another desk, by that desk's own clock, which then starts none",
  { timeout: 60_000 },
  async (t) => {
    const { alice, bob, session } = await bobsDesk(t, [], { limit: 2, rootTime: 6 });
    const agent = bob.as("bob/uploader", agentKey(bob.home, "uploader"));
    /** Alice asks bob's agent to take its time, and bob lets it ask others. Resolves once it has been let go, with the request's id. */
    const run = async (): Promise<string> => {
      const { id } = (await alice.publish("#team", "message", { text: "@bob/uploader slow", via: "cli" })).event;
      await until("bob can run it", () => session.view().current?.messages.some((message) => message.id === id && message.requests[0]?.status.kind === "ready"));
      await session.handle({ do: "run", id, repo: "uploader", post: true, mode: "read-only", text: "@bob/uploader slow", delegate: true });
      await said(id, "bob", "job.accepted");
      return id;
    };
    /** The event of `kind` from `author` about the request `id`, once alice can see it. */
    const said = (id: string, author: string, kind: string): Promise<Delivered> =>
      eventually(`${author}'s ${kind}`, async () => (await alice.events({ chat: "#team" })).find(({ event }) => event.refs[0] === id && event.author === author && event.kind === kind));
    /** Bob's agent asks alice's billing agent, as its MCP server would. */
    const ask = async (id: string): Promise<string> => (await agent.publish("#team", "job.request", { target: "alice/billing", text: "is it yours?", chain: ["bob/uploader"] }, [id, id])).event.id;

    // While alice's agent is asked, bob's outlives its two seconds; once she declines, its time runs again.
    const first = await run();
    const child = await ask(first);
    await delay(3_000);
    assert.equal(session.view().busy.working, 1);
    await alice.publish("#team", "job.declined", { repo: "billing", reason: "" }, [child]);
    const failed = await said(first, "bob/uploader", "job.error");
    assert.ok(failed.event.ts - (await said(child, "alice", "job.declined")).event.ts >= 1);

    // Its child left waiting, the next is stopped once six seconds have passed since bob let it go, and bob's agent takes back what it asked.
    const second = await run();
    const left = await ask(second);
    await said(second, "bob/uploader", "job.cancelled");
    const withdrawn = await said(left, "bob/uploader", "job.withdrawn");
    assert.deepEqual(readContent(withdrawn.event), { kind: "job.withdrawn", content: { agent: "alice/billing" } });

    // Asked by alice's agent, whose desk is gone, bob's agent asks hers in turn and its clock stands still; bob's desk stops it once six seconds have passed since alice let hers go,
    // by its own clock, and takes back what it asked. A request asked meanwhile, waiting for him, can no longer be run then.
    const apiKey = agentKey(alice.home, "api");
    await alice.publish("*", "agent.register", { repo: "api", pubkey: publicHex(apiKey) });
    const api = alice.as("alice/api", apiKey);
    const { id: root } = (await alice.publish("#team", "message", { text: "@alice/api slow", via: "cli" })).event;
    await alice.publish("#team", "job.accepted", { repo: "api", branch: "main", commit: "c0ffee".padEnd(40, "0"), dirty: false, delivery: "post", mode: "read-only", delegate: true, by: "owner" }, [
      root
    ]);
    const asks = async (text: string): Promise<string> => (await api.publish("#team", "job.request", { target: "bob/uploader", text, chain: ["alice/api"] }, [root, root])).event.id;
    const [asked, meanwhile] = [await asks("slow"), await asks("read")];
    await until("bob can run alice's agent's request", () =>
      session.view().current?.messages.some((message) => message.replies.some((reply) => reply.id === asked && reply.requests[0]?.status.kind === "ready"))
    );
    await session.handle({ do: "run", id: asked, repo: "uploader", post: true, mode: "read-only", text: "slow", delegate: true });
    await said(asked, "bob", "job.accepted");
    const below = (await agent.publish("#team", "job.request", { target: "alice/billing", text: "is it yours?", chain: ["alice/api", "bob/uploader"] }, [root, asked])).event.id;
    await said(asked, "bob/uploader", "job.cancelled");
    assert.deepEqual(readContent((await said(below, "bob/uploader", "job.withdrawn")).event), { kind: "job.withdrawn", content: { agent: "alice/billing" } });
    await assert.rejects(session.handle({ do: "run", id: meanwhile, repo: "uploader", post: true, mode: "read-only", text: "read" }), /request may not go: its root has been running for/);
  }
);
