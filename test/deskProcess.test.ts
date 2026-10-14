/** The window's hold on its desk: first on the real desk, started as a process and spoken to in lines, then on stand-ins that go away, speak another protocol, or cannot be started, and last through a stand-in wsl.exe, as on Windows. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { build } from "esbuild";

import { byCodeUnit } from "../src/core/text.ts";
import { DeskProcess, wslLaunch } from "../src/window/main/deskProcess.ts";
import type { Launch } from "../src/window/main/deskProcess.ts";
import type { Result } from "../src/window/main/wsl.ts";
import type { Notice, View } from "../src/shared/ipc.ts";
import { standInWsl } from "./standInWsl.ts";

const ROOT = join(import.meta.dirname, "..");
const COMMAND = join(ROOT, "src", "cli", "main.ts");

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

/** Start a desk the way `prepare` says and keep what it says. It is stopped when the test ends. */
function hold(t: TestContext, prepare: (dir: string) => Promise<Result<Launch>>): Held {
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
  const desk = new DeskProcess(() => prepare(dir), handlers, 5);
  t.after(async () => {
    await desk.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  desk.start();
  return { desk, views, notices, starts: () => readFileSync(join(dir, "starts"), "utf8").length };
}

function ready(launch: Launch): Promise<Result<Launch>> {
  return Promise.resolve({ ok: true, value: launch });
}

function standIn(says: readonly unknown[], stays = "no"): (dir: string) => Promise<Result<Launch>> {
  return (dir) => ready({ command: process.execPath, args: ["-e", STAND_IN], env: { ...process.env, STARTS: join(dir, "starts"), SAYS: JSON.stringify(says), STAYS: stays } });
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
  const { desk, views, notices } = hold(t, (dir) => ready({ command: process.execPath, args: [COMMAND, "desk"], env: { ...process.env, PLAYER_TWO_HOME: dir } }));

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
  const { desk, views, notices, starts } = hold(t, standIn([{ t: "hello", version: "0.4.0", protocol: 1 }, "not a line of the protocol"]));

  const stopped = await until("the stopped view", () => views.find((view) => view.kind === "stopped"));

  assert.match(stopped.problem, /^the desk keeps stopping with status 3\. The last it said:\n/); // What it wrote that was not the protocol, on either stream.
  assert.deepEqual(stopped.problem.split("\n").slice(1).sort(byCodeUnit), ["not a line of the protocol", "the desk fell over"]);
  assert.equal(starts(), 4);
  assert.deepEqual(notices[0], { title: "the window ignored a line from the desk it could not read", body: "not a line of the protocol", severity: "error" });

  // Started afresh, as after the user has fixed what stopped it, it gets its three restarts again.
  await desk.restart();
  await until("the second stopped view", () => views.filter((view) => view.kind === "stopped").length === 2);
  assert.equal(starts(), 8);
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

await test("a desk started afresh while it was still being made ready is started once", { timeout: 30_000 }, async (t) => {
  const says = standIn(
    [
      { t: "hello", version: "0.4.0", protocol: 1 },
      { t: "view", view: { kind: "setup", defaultAgent: "an-agent" } }
    ],
    "yes"
  );
  const slow = (dir: string): Promise<Result<Launch>> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(says(dir));
      }, 100);
    });
  const { desk, views, starts } = hold(t, slow);

  await desk.restart();
  await until("the join form", () => views.length > 0);
  await new Promise((resolve) => {
    setTimeout(resolve, 300); // Long enough for the first start's desk to have come up too, had it been let.
  });

  assert.deepEqual([starts(), views.length], [1, 1]);
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
  const missing = hold(t, () => ready({ command: join(import.meta.dirname, "no-such-program"), args: [], env: {} }));

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

await test("on Windows the runtime the app carries is installed into the distribution and the desk is started from it through wsl.exe", { timeout: 30_000 }, async (t) => {
  const wsl = standInWsl(t);
  // The app's resources: a runtime archive whose launcher starts the real desk, and the digest it was shipped with.
  const resources = join(wsl.windir, "resources");
  mkdirSync(join(resources, "bin"), { recursive: true });
  writeFileSync(join(resources, "bin", "player-two-desk"), `#!/bin/sh\nexec "${process.execPath}" "${COMMAND}" desk\n`, { mode: 0o755 });
  const archive = join(resources, "wsl-runtime.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", resources, "bin"]).status, 0);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const launcher = join(wsl.home, ".player-two", "current", "bin", "player-two-desk");

  // With no digest beside the archive there is nothing to trust, and with the wrong one nothing is installed. Neither is tried again.
  const unshipped = hold(t, () => wslLaunch("Ubuntu", resources));
  await until("the window saying the app has no runtime", () => unshipped.views.length > 0);
  writeFileSync(`${archive}.sha256`, `${"0".repeat(64)}  wsl-runtime.tar.gz\n`);
  const damaged = hold(t, () => wslLaunch("Ubuntu", resources));
  await until("the window saying the archive is damaged", () => damaged.views.length > 0);
  assert.deepEqual(unshipped.views, [{ kind: "stopped", problem: `this copy of Player Two has no Linux runtime to install: ${archive}.sha256 is missing or damaged. Install Player Two again` }]);
  assert.match(damaged.views[0]?.kind === "stopped" ? damaged.views[0].problem : "", /^wsl\.exe failed with status 1: the runtime archive .*wsl-runtime\.tar\.gz is damaged: /);
  assert.ok(!existsSync(join(wsl.home, ".player-two")));

  // A distribution that is not there is said in words.
  writeFileSync(`${archive}.sha256`, `${digest}  wsl-runtime.tar.gz\n`);
  const elsewhere = hold(t, () => wslLaunch("Fedora", resources));
  await until("the window saying there is no such distribution", () => elsewhere.views.length > 0);
  assert.deepEqual(elsewhere.views, [{ kind: "stopped", problem: "WSL has no distribution of that name. In PowerShell, `wsl --list --verbose` shows the ones it has" }]);

  // With everything in place the desk that answers is the one the launcher in the installed runtime started.
  assert.deepEqual(await wslLaunch(null, resources), { ok: true, value: { command: join(wsl.windir, "System32", "wsl.exe"), args: ["--exec", launcher], env: { ...process.env, WSL_UTF8: "1" } } });
  const { desk, views } = hold(t, () => wslLaunch("Ubuntu", resources));
  await until("the join form", () => views.length > 0);
  assert.deepEqual(views, [{ kind: "setup", defaultAgent: "claude -p" }]);
  assert.deepEqual(await desk.send({ do: "open", chat: "bob" }), { ok: false, problem: "join a hub first" });
  assert.ok(existsSync(launcher));
});

await test("nothing of the desk's is built into the window's main process or its preload script: they take its types and no more", async () => {
  const entryPoints = ["src/window/main/main.ts", "src/window/main/preload.ts"];
  const built = await build({
    entryPoints,
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    metafile: true,
    outdir: "dist",
    platform: "node",
    format: "esm",
    external: ["electron"],
    logLevel: "silent"
  });
  const inputs = Object.keys(built.metafile.inputs);

  assert.ok(inputs.includes("src/window/main/deskProcess.ts"), inputs.join("\n"));
  assert.deepEqual(
    inputs.filter((path) => path.startsWith("src/desk/") || path.startsWith("src/hub/") || path.startsWith("src/cli/")),
    []
  );
});
