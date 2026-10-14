/** The window's hold on its desk: first on the real desk, started as a process and spoken to in lines, then on stand-ins that go away, speak another protocol, or cannot be started. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { DeskProcess } from "../src/window/main/deskProcess.ts";
import type { Launch } from "../src/window/main/deskProcess.ts";
import type { Notice, View } from "../src/shared/ipc.ts";

const COMMAND = join(import.meta.dirname, "..", "src", "cli", "main.ts");

// A desk that marks each time it is started, says what the test tells it to, and goes.
const STAND_IN = `
  require("node:fs").appendFileSync(process.env.STARTS, "x");
  for (const line of JSON.parse(process.env.SAYS)) console.log(typeof line === "string" ? line : JSON.stringify(line));
  process.stdin.once("data", () => { console.error("the desk fell over"); process.exit(3); });
  if (process.env.STAYS !== "yes") process.stdin.emit("data");
`;

interface Held {
  readonly desk: DeskProcess;
  readonly views: View[];
  readonly notices: Notice[];
  readonly starts: () => number; // How many times a stand-in has been started.
}

/** Start a desk from `launch` and keep what it says. It is stopped when the test ends. */
function hold(t: TestContext, launch: (dir: string) => Launch): Held {
  const dir = mkdtempSync(join(tmpdir(), "player-two-desk-process-"));
  const views: View[] = [];
  const notices: Notice[] = [];
  const handlers = {
    view: (view: View): void => {
      views.push(view);
    },
    notice: (notice: Notice): void => {
      notices.push(notice);
    },
    arrival: (): void => undefined,
    ask: (): void => undefined
  };
  const desk = new DeskProcess(launch(dir), handlers, 5);
  t.after(async () => {
    await desk.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  desk.start();
  return { desk, views, notices, starts: () => readFileSync(join(dir, "starts"), "utf8").length };
}

function standIn(says: readonly unknown[], stays = "no"): (dir: string) => Launch {
  return (dir) => ({ command: process.execPath, args: ["-e", STAND_IN], env: { ...process.env, STARTS: join(dir, "starts"), SAYS: JSON.stringify(says), STAYS: stays } });
}

async function until<T>(what: string, find: () => T | undefined | false): Promise<T> {
  for (let tries = 0; tries < 400; tries += 1) {
    const found = find();
    if (found !== undefined && found !== false) {
      return found;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`never happened: ${what}`);
}

await test("the real desk is started, each command gets its own reply, and stopping it ends it", { timeout: 30_000 }, async (t) => {
  const { desk, views, notices } = hold(t, (dir) => ({ command: process.execPath, args: [COMMAND, "desk"], env: { ...process.env, PLAYER_TWO_HOME: dir } }));

  await until("the join form", () => views.length > 0);
  desk.attend(false);
  const [first, second] = await Promise.all([
    desk.send({ do: "join", hub: "nowhere", name: "alice", token: "", agent: "" }),
    desk.send({ do: "open", chat: "bob" }) // Answered first, since nothing has to be looked up to refuse it: the replies are matched by id, not by order.
  ]);
  await desk.stop();

  assert.deepEqual(views, [{ kind: "setup", defaultAgent: "claude -p" }]);
  assert.deepEqual([first.ok, second], [false, { ok: false, problem: "join a hub first" }]);
  assert.match(first.ok ? "" : first.problem, /^invalid hub: /);
  assert.deepEqual(await desk.send({ do: "open", chat: "bob" }), { ok: false, problem: "the desk is not running" });
  assert.deepEqual(notices, []);
});

await test("a desk that goes away unasked is started again three times, then the window shows why it gave up", { timeout: 30_000 }, async (t) => {
  const { views, notices, starts } = hold(t, standIn([{ t: "hello", version: "0.4.0", protocol: 1 }, "not a line of the protocol"]));

  const stopped = await until("the stopped view", () => views.find((view) => view.kind === "stopped"));

  assert.equal(stopped.problem, "the desk keeps stopping with status 3. The last it said:\nthe desk fell over");
  assert.equal(starts(), 4);
  assert.deepEqual(notices[0], { title: "the window ignored a line from the desk it could not read", body: "not a line of the protocol", severity: "error" });
});

await test("a desk that goes with a command unanswered has it answered for it, and one that had shown something is started again however often it goes", { timeout: 30_000 }, async (t) => {
  const { desk, views, starts } = hold(
    t,
    standIn(
      [
        { t: "hello", version: "0.4.0", protocol: 1 },
        { t: "view", view: { kind: "setup", defaultAgent: "an-agent" } }
      ],
      "yes"
    )
  );

  for (let round = 1; round <= 6; round += 1) {
    await until(`start ${String(round)}`, () => views.length === round);
    assert.deepEqual(await desk.send({ do: "open", chat: "bob" }), { ok: false, problem: "the desk stopped before it answered" }); // The stand-in goes at the first thing it is sent.
  }

  assert.equal(starts(), 6);
  assert.ok(views.every((view) => view.kind === "setup"));
});

await test("a desk that speaks another protocol is refused and not started again, and one that cannot be started is given up on", { timeout: 30_000 }, async (t) => {
  const newer = hold(
    t,
    standIn(
      [
        { t: "hello", version: "9.0.0", protocol: 99, more: "than this window knows" },
        { t: "view", view: { kind: "setup", defaultAgent: "an-agent" } }
      ],
      "yes"
    )
  );
  const missing = hold(t, () => ({ command: join(import.meta.dirname, "no-such-program"), args: [], env: {} }));

  await until("the newer desk refused", () => newer.views.length > 0);
  await until("the missing desk given up on", () => missing.views.length > 0);
  await new Promise((resolve) => {
    setTimeout(resolve, 100); // Long enough for a desk that was going to be started again to have been.
  });

  assert.deepEqual(newer.views, [{ kind: "stopped", problem: "the desk speaks protocol 99 and this window speaks protocol 1: update the window" }]);
  assert.equal(newer.starts(), 1);
  assert.equal(missing.views.length, 1);
  assert.match(missing.views[0]?.kind === "stopped" ? missing.views[0].problem : "", /^the desk keeps stopping with status -2\. The last it said:\nspawn .*no-such-program ENOENT$/);
});
