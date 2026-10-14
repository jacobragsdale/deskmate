/** The ACP runner against a scripted agent, test/fixtures/fake-acp-agent.ts, run with node: its answer, signing in, what each mode allows, asks and refuses, stopping, follow-ups, and that nothing it started is left behind. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Agent } from "../src/core/wire.ts";
import { acpRunner } from "../src/desk/agents/acp.ts";
import { AgentCancelledError } from "../src/desk/client.ts";
import type { PermissionAsk, RunHandlers } from "../src/desk/agents/runner.ts";
import type { ActivityItem } from "../src/shared/ipc.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");
const never = new AbortController().signal;

function fake(...more: string[]): Agent {
  return { id: "fake", label: "Fake", protocol: "acp", command: process.execPath, args: [FAKE, ...more] };
}

/** A checkout of its own for one test, removed when the test ends. */
function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "player-two-acp-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The processes the fake agent started in `dir` that are still there, given a moment to go. */
async function left(dir: string): Promise<number[]> {
  const pids = readFileSync(join(dir, "pids"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(Number);
  const there = (): number[] =>
    pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  for (let tries = 0; tries < 20 && there().length > 0; tries += 1) {
    await delay(50);
  }
  return there();
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
      items.map((item) => [item.id, item.kind, item.title, item.status, item.quiet]),
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
      assert.ok(took < 3000 && (word === "slow" ? took < 1000 : took >= 2000), `${word} took ${String(took)} ms to stop`);
      assert.deepEqual(await left(dir), [], word);
    }
  }
);

await test("the time limit ends a run, and time spent waiting for the owner's answer does not count against it", { timeout: 30_000 }, async (t) => {
  const runner = acpRunner(fake(), 1);
  const slowOwner: RunHandlers = { activity: () => undefined, permission: () => delay(1500).then((): "allow-once" => "allow-once") };
  assert.equal(await runner.run("edit", folder(t), "supervised", slowOwner, never), "turn 1: edit allowed");
  const dir = folder(t);
  await assert.rejects(runner.run("deaf", dir, "full", recorder().handlers, never), { message: "the agent did not finish within 1 seconds" });
  assert.deepEqual(await left(dir), []);
});
