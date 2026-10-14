/** The ACP runner against a scripted agent, test/fixtures/fake-acp-agent.ts, run with node: its answer, signing in, what each mode allows, asks and refuses, stopping, follow-ups, and that nothing it started is left behind. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Agent } from "../src/core/wire.ts";
import { acpRunner } from "../src/desk/agents/acp.ts";
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
