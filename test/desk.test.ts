/** The desk, driven the only way the window can drive it: by lines. First in this process on two streams against a real hub, then as the built program. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { text } from "node:stream/consumers";
import { test } from "node:test";

import { VERSION } from "../src/core/version.ts";
import { configSchema, PROTOCOL } from "../src/core/wire.ts";
import { DEFAULT_PRESET, PRESETS } from "../src/desk/agents/presets.ts";
import { runDesk } from "../src/desk/main.ts";
import { deskLineSchema } from "../src/shared/ipc.ts";
import type { ChatView, DeskLine, Outcome, WindowLine } from "../src/shared/ipc.ts";
import { startHub, TOKEN } from "./startHub.ts";

const BUILT = join(import.meta.dirname, "..", "dist", "player-two.js");

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parse(line: string): DeskLine {
  return deskLineSchema.parse(JSON.parse(line));
}

await test("the desk by lines: the join form, joining, the chats, a message sent and one received, a question, a line it cannot read, and the end", { timeout: 60_000 }, async (t) => {
  const hub = await startHub(t, () => Date.now() / 1000);
  const dev = join(hub.dir, "dev");
  process.env["PLAYER_TWO_HOME"] = join(hub.dir, "desk");
  process.env["PLAYER_TWO_DEV"] = dev;
  process.env["HOME"] = hub.dir; // Where the shell the desk asks for its PATH finds its start-up file.
  writeFileSync(join(hub.dir, ".profile"), `export PATH="${join(hub.dir, "tools")}:$PATH"\n`);
  const bob = await hub.join("bob");
  await bob.advertise([{ name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "main" }]);

  const input = new PassThrough();
  const output = new PassThrough();
  const lines: DeskLine[] = []; // Every line is read with the schema the window reads it with, so one that does not fit fails the test.
  createInterface({ input: output }).on("line", (line) => {
    lines.push(parse(line));
  });
  const done = runDesk(input, output);
  const say = (line: WindowLine): void => {
    input.write(`${JSON.stringify(line)}\n`);
  };
  let at = 0;
  /** Wait for a line `find` accepts, among those the desk has written and this has not looked at yet. */
  const next = async <T>(what: string, find: (line: DeskLine) => T | undefined | false): Promise<T> => {
    for (let tries = 0; tries < 400; tries += 1) {
      for (const line of lines.slice(at)) {
        at += 1;
        const found = find(line);
        if (found !== undefined && found !== false) {
          return found;
        }
      }
      await pause(25);
    }
    throw new Error(`the desk never said: ${what}`);
  };
  const reply = (id: number): Promise<Outcome> => next(`a reply to command ${String(id)}`, (line) => line.t === "reply" && line.id === id && line.outcome);
  const chat = (what: string, find: (view: ChatView) => boolean): Promise<ChatView> => next(what, (line) => line.t === "view" && line.view.kind === "chat" && find(line.view) && line.view);

  // It says which version and protocol it is before anything else, then shows the join form, and until someone has joined it does nothing but join.
  assert.deepEqual(await next("hello", (line) => line), { t: "hello", version: VERSION, protocol: PROTOCOL });
  assert.deepEqual(await next("the join form", (line) => line), { t: "view", view: { kind: "setup", presets: PRESETS } });
  assert.equal(process.env["PATH"]?.split(":")[0], join(hub.dir, "tools")); // By then it has the PATH of the user's own shell, which is what its agents and git are found on.
  say({ t: "command", id: 1, command: { do: "open", chat: "bob" } });
  assert.deepEqual(await reply(1), { ok: false, problem: "join a hub first" });

  // The setup check answers before anyone has joined, with only what needs no identity, and in full after.
  const checked = async (id: number): Promise<string[]> => {
    say({ t: "command", id, command: { do: "doctor" } });
    const outcome = await reply(id);
    return outcome.ok ? (outcome.data ?? []).map((check) => check.id) : [outcome.problem];
  };
  assert.deepEqual(await checked(10), ["node", "dev", "git"]);

  // Joining starts the session: the chats arrive as a view, with bob's open.
  say({ t: "command", id: 2, command: { do: "join", hub: hub.url, name: "alice", token: TOKEN, agent: DEFAULT_PRESET } });
  assert.deepEqual(await reply(2), { ok: true });
  const joined = await chat("the chat with bob", (view) => view.current?.chat === "bob" && view.team.length === 1);
  assert.deepEqual([joined.me, joined.agents, joined.defaultAgent, joined.link, joined.busy], ["alice", [DEFAULT_PRESET], DEFAULT_PRESET.id, { state: "connected" }, { working: 0, unsent: 0 }]);

  // The setup page's agents: one added, of its own, and made the one that answers, kept in config.json; a list whose default is not among them is refused.
  const own = { id: "custom", label: "mine", protocol: "acp", command: "my-agent", args: ["--acp", "two words"] } as const;
  say({ t: "command", id: 7, command: { do: "agents", agents: [DEFAULT_PRESET, own], defaultAgent: "custom" } });
  assert.deepEqual(await reply(7), { ok: true });
  await chat("the agents as changed", (view) => view.defaultAgent === "custom" && view.agents.length === 2 && view.presets.length === PRESETS.length);
  const saved = configSchema.parse(JSON.parse(readFileSync(join(hub.dir, "desk", "config.json"), "utf8")));
  assert.deepEqual([saved.agents, saved.defaultAgent], [[DEFAULT_PRESET, own], "custom"]);
  say({ t: "command", id: 8, command: { do: "agents", agents: [own], defaultAgent: DEFAULT_PRESET.id } });
  assert.deepEqual(await reply(8), { ok: false, problem: "invalid defaultAgent: the default agent is not one of the agents" });

  // A message sent by a command comes back in a later view, and one from bob is announced.
  say({ t: "command", id: 3, command: { do: "send", chat: "bob", text: "lunch at noon?" } });
  assert.deepEqual(await reply(3), { ok: true });
  await chat("the message alice sent", (view) => view.current?.messages.at(-1)?.body === "lunch at noon?");
  say({ t: "attend", attentive: false });
  await bob.publish("alice", "message", { text: "yes", via: "cli" });
  assert.deepEqual(await next("bob's message announced", (line) => line.t === "arrival" && line.arrival), { chat: "bob", title: "bob", body: "yes", forMe: false, rings: true });
  await chat("bob's message unread while alice looks away", (view) => view.unread === 1);
  say({ t: "attend", attentive: true });
  await chat("bob's message read once she is back", (view) => view.unread === 0 && view.current?.messages.at(-1)?.body === "yes");

  // A clone is put to the user first, and a no means nothing is fetched.
  say({ t: "command", id: 4, command: { do: "clone", repo: "uploader" } });
  const asked = await next("the question before a clone", (line) => line.t === "ask" && line);
  assert.deepEqual([asked.question.message, asked.question.confirm], ["Clone this repository?", "Clone"]);
  assert.match(asked.question.detail, new RegExp(`^From https://dev\\.azure\\.com/acme/Platform/_git/uploader\nInto ${join(dev, "uploader")}\n`));
  say({ t: "answer", id: asked.id, ok: false });
  assert.deepEqual(await reply(4), { ok: true });
  assert.ok(!existsSync(dev));

  // A line that is not one of the protocol's is said to be ignored, and the desk carries on.
  for (const bad of ["not json", JSON.stringify({ t: "command", id: 5, command: { do: "dance" } })]) {
    input.write(`${bad}\n`);
    assert.deepEqual(await next("a notice about a bad line", (line) => line.t === "notice" && line.notice), { title: "the desk ignored a line it could not read", body: bad, severity: "error" });
  }
  say({ t: "command", id: 6, command: { do: "open", chat: "bob" } });
  assert.deepEqual(await reply(6), { ok: true });
  assert.deepEqual(await checked(11), ["node", "identity", "hub", "proxy", "protocol", "clock", "dev", "repos", "git", "git-auth", "agent"]);

  // The end of its input is the end of the desk.
  input.end();
  await done;
});

await test("the built command run as `player-two desk` says hello, shows the join form, writes nothing but protocol lines, and exits when its input ends", { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "player-two-desk-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  assert.ok(existsSync(BUILT), "dist/player-two.js is not there: `npm test` builds it before the tests run, and so does `npm run build`");
  const desk = spawn(process.execPath, [BUILT, "desk"], { env: { ...process.env, PLAYER_TWO_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    desk.kill("SIGKILL");
  });
  const exited = new Promise<number | null>((resolve) => {
    desk.once("close", resolve); // Once it has gone and everything it wrote has been read.
  });
  const errors = text(desk.stderr);
  const lines: string[] = [];
  let told = 0;
  createInterface({ input: desk.stdout }).on("line", (line) => {
    lines.push(line);
    if (lines.length === 2) {
      told = Date.now();
      desk.stdin.end(); // The join form is up, so it is listening: the end of its input is all it takes to stop it.
    }
  });

  assert.equal(await exited, 0, await errors);
  assert.ok(Date.now() - told < 3000, `took ${String(Date.now() - told)} ms to exit`);
  assert.deepEqual(lines.map(parse), [
    { t: "hello", version: VERSION, protocol: PROTOCOL },
    { t: "view", view: { kind: "setup", presets: PRESETS } }
  ]);
});
