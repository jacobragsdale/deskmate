/** The window for real: Electron started on the built app with a home of its own, against a hub in this process, driven over the DevTools protocol the way a person would. It needs a display; CI gives it one with xvfb-run. */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import type { KeyObject } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { z } from "zod";

import { readContent } from "../src/core/kinds.ts";
import { noteLink } from "../src/core/links.ts";
import { newKey, publicHex } from "../src/core/sign.ts";
import { commandLineOf } from "../src/core/wire.ts";
import type { Client } from "../src/desk/client.ts";
import { startHub, TOKEN } from "./startHub.ts";

const ROOT = join(import.meta.dirname, "..");
const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts"); // The scripted ACP agent, which acts on words in its prompt.
const NO_DISPLAY = process.platform === "linux" && (process.env["DISPLAY"] ?? "") === "" && (process.env["WAYLAND_DISPLAY"] ?? "") === "";
const KEYS = {
  Enter: { code: "Enter", keyCode: 13 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  k: { code: "KeyK", keyCode: 75 },
  n: { code: "KeyN", keyCode: 78 },
  w: { code: "KeyW", keyCode: 87 }
} as const;
const ALT = 1; // The DevTools protocol's bits for the Alt and Ctrl keys.
const CTRL = 2;

const replySchema = z.object({ id: z.number(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() });
const eventSchema = z.object({ method: z.string(), params: z.unknown() });
const logEntrySchema = z.object({ entry: z.object({ level: z.string(), text: z.string() }) });
const evaluatedSchema = z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.object({ text: z.string() }).optional() });
const targetsSchema = z.array(z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string() }));
const rectSchema = z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number(), width: z.number(), height: z.number() });
type Rect = z.infer<typeof rectSchema>;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One page over the DevTools protocol: commands with their replies, and what the page logs. */
class Page {
  public readonly problems: string[] = []; // Errors the page logged or threw, a refusal by the content security policy among them.
  private readonly socket: WebSocket;
  private readonly waiting = new Map<number, (reply: z.infer<typeof replySchema>) => void>();
  private next = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (message) => {
      const data: unknown = JSON.parse(String(message.data));
      const reply = replySchema.safeParse(data);
      if (reply.success) {
        this.waiting.get(reply.data.id)?.(reply.data);
        return;
      }
      const event = eventSchema.parse(data);
      if (event.method === "Log.entryAdded") {
        const { entry } = logEntrySchema.parse(event.params);
        if (entry.level === "error") {
          this.problems.push(entry.text);
        }
      } else if (event.method === "Runtime.exceptionThrown") {
        this.problems.push(JSON.stringify(event.params));
      }
    });
  }

  public static async open(url: string): Promise<Page> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    const page = new Page(socket);
    // Both send what was logged before they were enabled, so nothing from the page's first moments is missed.
    await page.send("Log.enable");
    await page.send("Runtime.enable");
    // The test is about where things land, not how they get there. On CI's virtual display an animation sometimes never runs, leaving a toast or
    // a dialog where it started from; asking for reduced motion, which the window honours with none at all, takes them out.
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    return page;
  }

  public async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.next += 1;
    const id = this.next;
    // Bounded, so a page that has gone, or stopped answering, fails the step that asked rather than the whole test's time.
    let timer: NodeJS.Timeout | undefined;
    const reply = await new Promise<z.infer<typeof replySchema>>((resolve, reject) => {
      this.waiting.set(id, resolve);
      timer = setTimeout(reject, 20_000, new Error(`${method} had no answer in 20 seconds: ${JSON.stringify(params).slice(0, 200)}`)).unref();
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    clearTimeout(timer);
    this.waiting.delete(id);
    if (reply.error !== undefined) {
      throw new Error(`${method}: ${reply.error.message}`);
    }
    return reply.result;
  }

  /** Run an expression in the page and return its value. */
  public async eval(expression: string): Promise<unknown> {
    const evaluated = evaluatedSchema.parse(await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
    if (evaluated.exceptionDetails !== undefined) {
      throw new Error(`${expression}: ${evaluated.exceptionDetails.text}`);
    }
    return evaluated.result.value;
  }

  /** Wait until an expression is true in the page. */
  public async until(what: string, expression: string): Promise<void> {
    for (let tries = 0; tries < 200; tries += 1) {
      if ((await this.eval(expression)) === true) {
        return;
      }
      await pause(100);
    }
    throw new Error(`waited 20 seconds for ${what}: ${String(await this.eval("document.body.innerText"))}`);
  }

  /** Where the first element `selector` finds is on the screen, once it has stopped moving: a slow machine is still sliding it in after any fixed pause. */
  public async rect(selector: string): Promise<Rect> {
    const read = async (): Promise<Rect> => rectSchema.parse(await this.eval(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`));
    let last = await read();
    for (let tries = 0; tries < 50; tries += 1) {
      await pause(100);
      const now = await read();
      if (JSON.stringify(now) === JSON.stringify(last)) {
        return now;
      }
      last = now;
    }
    throw new Error(`${selector} was still moving after 5 seconds: ${JSON.stringify(last)}`);
  }

  public async click(selector: string, text = ""): Promise<void> {
    await this.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => each.textContent.includes(${JSON.stringify(text)})).click()`);
  }

  /** Put the cursor in a field and type into it, replacing whatever was there. */
  public async type(selector: string, text: string): Promise<void> {
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await this.send("Input.insertText", { text });
  }

  /** Press a key. One the window's menu takes, as Ctrl+W, goes down raw, as the system sends it, with its native code, which the menu matches, and no character the page could take first. */
  public async press(key: keyof typeof KEYS, modifiers = 0, down: "keyDown" | "rawKeyDown" = "keyDown"): Promise<void> {
    for (const type of [down, "keyUp"]) {
      const native = down === "rawKeyDown" ? { nativeVirtualKeyCode: KEYS[key].keyCode } : {};
      await this.send("Input.dispatchKeyEvent", { type, key, code: KEYS[key].code, windowsVirtualKeyCode: KEYS[key].keyCode, ...native, modifiers });
    }
  }

  /** Double-click what `expression` finds, as the system does: two presses at its middle, the second with a click count of 2, once `between` has resolved after the first. */
  public async doubleClick(expression: string, between: () => Promise<void> = () => Promise.resolve()): Promise<void> {
    const at = z
      .object({ x: z.number(), y: z.number() })
      .parse(await this.eval(`(() => { const box = ${expression}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`));
    for (const clickCount of [1, 2]) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount });
      if (clickCount === 1) {
        await between();
      }
    }
  }

  /** With PLAYER_TWO_SHOTS naming a folder, save what the window shows there as `name`.png, for a person to look at. */
  public async shot(name: string): Promise<void> {
    const folder = process.env["PLAYER_TWO_SHOTS"] ?? "";
    if (folder !== "") {
      const { data } = z.object({ data: z.string() }).parse(await this.send("Page.captureScreenshot"));
      writeFileSync(join(folder, `${name}.png`), Buffer.from(data, "base64"));
    }
  }

  public close(): void {
    this.socket.close();
  }
}

/** A real git repository at `dir`, with one commit and an origin, as a checkout of a team repo is: the desk asks git where it stands before each run. */
function repository(dir: string, origin: string): void {
  mkdirSync(dir);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["-c", "user.name=alice", "-c", "user.email=alice@example.com", "commit", "-q", "--allow-empty", "-m", "first"],
    ["remote", "add", "origin", origin]
  ]) {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  }
}

/** Check that the first element `selector` finds lies wholly within what the open chat shows, once both have stopped moving. */
async function inChat(page: Page, selector: string, what: string): Promise<void> {
  const [found, frame] = [await page.rect(selector), await page.rect("main [data-radix-scroll-area-viewport]")];
  assert.ok(found.height > 0 && found.top >= frame.top && found.bottom <= frame.bottom, `${what} is out of view: ${JSON.stringify({ found, frame })}`);
}

/** The mode the newest run in a chat was let go at, as its job.accepted records it, read by someone in the chat; "" when there is none. */
async function acceptedAt(client: Client, chat: string): Promise<string> {
  const said = (await client.events({ chat })).map((each) => readContent(each.event)).find((each) => each.kind === "job.accepted"); // Newest first.
  return said?.kind === "job.accepted" ? said.content.mode : "";
}

/** On the Setup page, add an agent of the user's own over ACP, a program and its arguments typed in one per row, and choose it to answer. */
async function addAgent(page: Page, program: string, args: readonly string[]): Promise<void> {
  const picker = `[...document.querySelectorAll("label")].find((each) => each.textContent.startsWith("Add an agent")).querySelector("select")`;
  await page.eval(`(() => { const select = ${picker}; select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.until("the program's field", `document.querySelector('input[aria-label="Program"]') !== null`);
  await page.type('input[aria-label="Program"]', program);
  for (const [index, arg] of args.entries()) {
    const field = `input[aria-label="Argument ${String(index + 1)}"]`;
    await page.click("button", "Add an argument");
    await page.until("a row for an argument", `document.querySelector(${JSON.stringify(field)}) !== null`);
    await page.type(field, arg);
  }
  await page.eval(`[...document.querySelectorAll("button")].find((each) => each.textContent === "Add").click()`);
  const answers = `input[aria-label=${JSON.stringify(`${program} answers`)}]`;
  await page.until("the agent added", `document.querySelector(${JSON.stringify(answers)}) !== null`);
  await page.click(answers);
  await page.until("the agent chosen", `document.querySelector(${JSON.stringify(answers)}).checked === true`);
}

/**
 * Agents asking agents, in a channel of its own with bob and carol, so that no earlier message reaches a prompt. Bob's desk is played by hand: his acceptance letting his agent ask others,
 * his agent's request of alice's, signed by it with `bobsAgent`, and the end of its run; alice's desk, her agent and the MCP server it asks through are real.
 */
async function askingAgents(page: Page, bob: Client, carol: Client, bobsAgent: KeyObject, commit: string): Promise<void> {
  // Alice asks bob's agent, and bob lets it run read-only and ask others, as his desk would; it asks hers, signed by it. Under her request is the tree of the jobs under it, one line each,
  // indented by depth. That request, a reply in her request's thread, reads as bob's agent asking hers, says how it came in words before its buttons, and offers the switch that lets
  // her agent ask others too, off as for anyone else's request, beside what that means: she turns it on and runs it, her acceptance says so, and her agent asks carol's through the MCP
  // server it is given for that, in the same thread, and in the tree. Bob's desk is played by hand.
  await bob.publish("#relay", "channel.join", {});
  await carol.publish("#relay", "channel.join", {});
  await page.press("n", CTRL);
  await page.until("the dialog, for #relay", `document.querySelector('[role="dialog"] input[name="name"]') !== null`);
  await page.type('[role="dialog"] input[name="name"]', "relay");
  await page.click('[role="dialog"] button[type="submit"]');
  await page.until("#relay", `document.querySelector("main h1")?.textContent === "#relay"`);
  await page.type('textarea[aria-label="Message #relay"]', "@bob/uploader who calls the retry path?");
  await page.press("Enter");
  const relay = `[...document.querySelectorAll("main [data-seq]")].find((each) => each.querySelector("article")?.innerText.includes("who calls the retry path?"))`; // Her request, and its thread.
  await page.until("her request of bob's agent", `${relay}?.innerText.includes("◌ waiting for bob to approve") === true`);
  const relayRoot = (await bob.events({ chat: "#relay" })).find((each) => each.event.content.includes("who calls the retry path?"))?.event.id;
  assert.ok(relayRoot !== undefined);
  await bob.publish("#relay", "job.accepted", { repo: "uploader", branch: "main", commit, dirty: false, delivery: "post", mode: "read-only", by: "owner", delegate: true }, [relayRoot]);
  await bob.as("bob/uploader", bobsAgent).publish("#relay", "job.request", { target: "alice/billing", text: "ask:carol/api", chain: ["bob/uploader"] }, [relayRoot, relayRoot]);
  const tree = `[...(${relay}?.querySelector("article").querySelectorAll('ul[aria-label="Agents asked under it"] li') ?? [])].map((each) => each.dataset.depth + " " + each.textContent.trim())`;
  await page.until("the tree under her request", `${tree}.length === 2`);
  assert.deepEqual(await page.eval(tree), ["0 bob's uploader agent · working · read-only", "1 ◌ your billing agent · waiting for you"]);
  assert.equal(await page.eval(`${relay}.querySelector('article [aria-live="polite"] ul') !== null`), true);
  await page.until("the thread's summary under her request", `[...${relay}.querySelectorAll("button")].some((each) => each.textContent === "1 reply")`);
  await page.eval(`[...${relay}.querySelectorAll("button")].find((each) => each.textContent === "1 reply").click()`);
  const replyOf = (words: string): string => `[...${relay}.querySelectorAll('section[aria-label="Thread"] article')].find((each) => each.innerText.includes(${JSON.stringify(words)}))`;
  const ofMine = replyOf("bob's uploader agent asked @alice/billing: ask:carol/api");
  const toggle = `${ofMine}?.querySelector('button[role="switch"]')`;
  await page.until("the switch under bob's agent's request of hers", `${toggle}?.getAttribute("aria-checked") === "false"`);
  // How it came, in words, before the buttons.
  assert.match(
    String(await page.eval(`[...${ofMine}.querySelectorAll("p")].find((each) => each.querySelector("button") !== null).innerText`)),
    /^◆ you asked bob's uploader agent, which is asking your billing agent · ▶ Run read-only/
  );
  assert.equal(await page.eval(`${toggle}.labels[0].textContent`), "Let this agent ask other agents");
  assert.match(String(await page.eval(`document.getElementById(${toggle}.getAttribute("aria-describedby")).textContent`)), /posted in the chat as it asks, even when you review its answer/);
  await page.eval(`${toggle}.click()`);
  await page.until("the switch on", `${toggle}?.getAttribute("aria-checked") === "true"`);
  await page.shot("ask-others");
  await page.eval(`[...${ofMine}.querySelectorAll("button")].find((each) => each.textContent === "▶ Run read-only").click()`);
  await page.until("her agent asking carol's, in the thread", `${replyOf("your billing agent asked @carol/api: read")}?.innerText.includes("◌ waiting for carol to approve") === true`);
  await page.until("carol's agent in the tree", `${tree}.length === 3`);
  assert.deepEqual(await page.eval(tree), ["0 bob's uploader agent · working · read-only", "1 your billing agent · working · read-only", "2 ◌ carol's api agent · waiting for carol"]);
  await page.shot("tree");
  const accepted = (await carol.events({ chat: "#relay" }))
    .map(({ event }) => ({ author: event.author, said: readContent(event) }))
    .find((each) => each.author === "alice" && each.said.kind === "job.accepted");
  assert.ok(accepted?.said.kind === "job.accepted" && accepted.said.content.delegate && accepted.said.content.mode === "read-only", JSON.stringify(accepted));

  // Alice has one Withdraw, on her request: what her agent asked is its agent's to take back. It says it ends everything under it, and does: her desk stops her agent's run, asked under
  // hers, and the end of that run takes back what it asked, before bob's desk has done anything; then his stops his agent's, as his desk would on her withdrawal. Every job done, the tree
  // folds to how many agents were involved, and opens again.
  const withdraws = `[...${relay}.querySelectorAll("button")].filter((each) => each.textContent === "↩ Withdraw")`;
  assert.equal(await page.eval(`${withdraws}.length`), 1);
  assert.equal(await page.eval(`${withdraws}[0].closest("article") === ${relay}.querySelector("article")`), true);
  assert.equal(await page.eval(`${withdraws}[0].title`), "Take it back: bob's uploader agent stops, and so does every agent asked under it");
  await page.eval(`${withdraws}[0].click()`);
  await page.until("her request taken back, until bob's desk stops it", `${relay}.querySelector("article").innerText.includes("↩ taken back, until bob's desk stops it")`);
  await page.until("what her agent asked taken back", `${replyOf("↩ the request was taken back")} !== undefined`);
  await page.shot("withdrawn");
  await bob.publish("#relay", "job.cancelled", { repo: "uploader" }, [relayRoot]);
  const folded = `${relay}.querySelector("article details")`;
  await page.until("the tree folded", `${folded}?.querySelector("summary").textContent === "3 agents involved" && !${folded}.open`);
  await page.shot("folded");
  await page.eval(`${folded}.querySelector("summary").click()`);
  await page.until("the tree open again", `${folded}.open`);
  assert.deepEqual(await page.eval(tree), ["0 ■ bob's uploader agent · stopped · read-only", "1 ■ your billing agent · stopped · read-only", "2 ↩ carol's api agent · taken back"]);

  // Her agent's request, its run stopped as what asked it ended, is not offered again: its line says why it may no longer go, in place of the buttons and the switch.
  const stoppedLine = `[...${ofMine}.querySelectorAll("p")].find((each) => each.innerText.startsWith("◆ stopped"))`;
  await page.until("her agent's request, no longer offered", `${stoppedLine}?.innerText.includes("it may no longer go") === true`);
  assert.match(
    String(await page.eval(`${stoppedLine}.innerText`)),
    /^◆ stopped · you asked bob's uploader agent, which is asking your billing agent · it may no longer go: bob\/uploader is not working on what it was asked/
  );
  const offers = `[...${ofMine}.querySelectorAll("button")].some((each) => each.textContent.startsWith("▶") || each.textContent === "× Decline" || each.getAttribute("role") === "switch")`;
  assert.equal(await page.eval(offers), false);
}

/** Patches, from erin in her own chat with alice: one whose title, file names and lines are HTML is drawn as text, each file folded until it is opened, with what it adds and removes. */
async function patches(page: Page, erin: Client): Promise<void> {
  const billing = { name: "billing", key: "dev.azure.com/acme/platform/billing", url: "https://dev.azure.com/acme/Platform/_git/billing" };
  const hostile = [
    "diff --git a/page.html b/page.html",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/page.html",
    "@@ -0,0 +1,2 @@",
    "+<script>window.pwned = 8</script>",
    '+<img src=x onerror="window.pwned = 9">',
    "diff --git a/<b>x</b>.md b/<b>x</b>.md",
    "--- a/<b>x</b>.md",
    "+++ b/<b>x</b>.md",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+<b>new</b>",
    ""
  ].join("\n");
  await erin.publish("alice", "patch", { repo: billing, base: "a".repeat(40), branch: "main", title: 'Tidy <img src=x onerror="window.pwned = 10"> up', diff: hostile });
  await page.until("erin in the chat list", `[...document.querySelectorAll("nav button")].some((each) => each.textContent.includes("erin"))`);
  await page.click("nav button", "erin");
  const card = `document.querySelector('main section[aria-label="Patch"]')`;
  await page.until("erin's patch, as a card", `document.querySelector("main h1")?.textContent === "erin" && ${card} !== null`);
  assert.equal(await page.eval(`${card}.querySelector("p").textContent`), 'Tidy <img src=x onerror="window.pwned = 10"> up');
  assert.deepEqual(await page.eval(`[...${card}.querySelectorAll("summary")].map((each) => each.textContent)`), ["page.html +2 −0", "<b>x</b>.md +1 −1"]);
  assert.equal(await page.eval(`${card}.querySelector("pre")`), null); // Folded, each file.
  await page.eval(`[...${card}.querySelectorAll("summary")].forEach((each) => { each.click(); })`);
  await page.until("both files open", `${card}.querySelectorAll("pre").length === 2`);
  assert.deepEqual(await page.eval(`[...${card}.querySelectorAll("pre")].map((each) => each.textContent)`), [
    '@@ -0,0 +1,2 @@\n+<script>window.pwned = 8</script>\n+<img src=x onerror="window.pwned = 9">\n',
    "@@ -1,2 +1,2 @@\n keep\n-old\n+<b>new</b>\n"
  ]);
  assert.equal(await page.eval(`document.querySelectorAll("main script, main img, main b").length`), 0);
  assert.equal(await page.eval("window.pwned"), undefined);
  await page.shot("patch");
}

await test(
  "the window joins, opens a chat, sends a message and reads it back, shows a popover, a dialog and a toast in place, draws hostile messages, replies, reactions, edits and links to notes as text, pages back, keeping its place, shows editor agents' snippets and the user's own agents on the Setup page, where one over ACP is tested for asking first, runs a teammate's request with the user's agent read-only, step by step in the activity panel, and supervised from the menu, where it asks on a card before it edits, as the user's own does before it runs a command, keeps a card in reach in a closed thread and brings one far above the end into view, refuses and allows for the run from a card, and offers only the modes the agent that answers can keep, full alone beside its reason when that is all, and a full chosen once not again in one click when less is there, and for a grant full alone while it is untested; and on My agents makes grants from its dialog, which warns of full access for anyone however its answers go and asks a second yes when they are posted directly, one grant for each double click, revokes one with a double click and not the next, counts the run a grant lets go, and holds a repo back with a double click, unshared and answering nobody under that grant, and lets it answer again; and says under whose grant a run went ahead, to its owner while it runs and in its answer, and to whoever asked, and that an answer its agent signed was not reviewed, where it is shown and where it is found; and while a grant is live stays open on close, saying why, where it cannot say it went to the tray, and once told hides on close, answering on, until started again; lists a grant apart once its repo is not checked out here, and revokes it there; lets the user's agent, asked by another, ask others from a switch beside what that means, says before its buttons how that request came, draws under the message that started it the tree of jobs under it, folded once all are done, and ends it all with that message's one Withdraw, after which what was asked under it is not offered again, saying why; draws a patch as a card beside the draft it goes with and in the chat, each file folded with what it adds and removes, and every word of a hostile one as text; and quits on close once none is",
  { skip: NO_DISPLAY ? "no display: run it under xvfb-run" : false, timeout: 120_000 },
  async (t) => {
    assert.ok(existsSync(join(ROOT, "dist", "main.js")), "dist/ is not built: run `npm run build` first");
    const electron: unknown = createRequire(import.meta.url)("electron"); // Required from Node, the package is the path to its binary, which it downloads the first time.
    assert.ok(typeof electron === "string");

    // A home of its own: the identity, the repos folder and Electron's own settings all go there. Started before the hub, it is stopped before the hub is.
    const home = mkdtempSync(join(tmpdir(), "player-two-window-"));
    mkdirSync(join(home, "dev"));
    // Alice's own checkout, of a repo nobody else has, for her agent to be asked about.
    repository(join(home, "dev", "billing"), "https://dev.azure.com/acme/Platform/_git/billing");
    // A run let ask other agents gives its agent Player Two's MCP server, started as `player-two` from the PATH: here, the command just built.
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "player-two"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "dist", "player-two.js"))} "$@"\n`, { mode: 0o755 });
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: `${join(home, "bin")}:${process.env["PATH"] ?? ""}` };
    delete env["PLAYER_TWO_HOME"];
    delete env["PLAYER_TWO_DEV"];
    delete env["DBUS_SESSION_BUS_ADDRESS"]; // With no session bus no notification can be shown, wherever this runs: see where the window is closed with a grant live.
    // No Azure DevOps token from where the test runs: not in the environment, and not from a credential helper in git's configuration outside her home.
    delete env["AZURE_DEVOPS_EXT_PAT"];
    delete env["GIT_CONFIG_GLOBAL"];
    env["GIT_CONFIG_NOSYSTEM"] = "1";
    // On a virtual display with no window manager, as in CI, Chromium may take the window for hidden and stop drawing frames, which freezes every
    // transition at its start: a toast that never slides in is "out of place". These are the switches Playwright starts Chromium with for the same reason.
    const unthrottled = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
    const app = spawn(electron, [ROOT, "--remote-debugging-port=0", ...unthrottled], { env, stdio: ["ignore", "ignore", "pipe"] });
    const exited = new Promise((resolve) => {
      app.once("exit", resolve);
    });
    t.after(async () => {
      app.kill("SIGTERM");
      await Promise.race([exited, pause(10_000)]);
      app.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    });

    const hub = await startHub(t, () => Date.now() / 1000); // The real clock, which the window's desk reads.
    const bob = await hub.join("bob");
    await bob.advertise([{ name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "main" }]);

    const said: string[] = [];
    const port = await new Promise<string>((resolve, reject) => {
      createInterface({ input: app.stderr }).on("line", (line) => {
        said.push(line);
        const found = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(line);
        if (found?.[1] !== undefined) {
          resolve(found[1]);
        }
      });
      exited.then((code) => {
        reject(new Error(`Electron exited with ${String(code)} before it listened:\n${said.join("\n")}`));
      }, reject);
    });

    let target: string | undefined;
    for (let tries = 0; target === undefined && tries < 100; tries += 1) {
      const targets = targetsSchema.parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
      target = targets.find((each) => each.type === "page" && each.url.endsWith("/index.html"))?.webSocketDebuggerUrl;
      await pause(100);
    }
    assert.ok(target !== undefined, "the window's page never appeared");
    const page = await Page.open(target);
    t.after(() => {
      page.close();
    });

    // The join form. A wrong token first, for a toast.
    await page.until("the join form", `document.querySelector('form input[name="hub"]') !== null`);
    await page.type('input[name="hub"]', hub.url);
    await page.type('input[name="name"]', "alice");
    await page.type('input[name="token"]', "not-the-join-token");
    await page.click('form button[type="submit"]');
    await page.until("the toast saying it could not join", `[...document.querySelectorAll("[data-sonner-toast]")].some((each) => each.textContent.includes("could not join"))`);
    const toast = await page.rect("[data-sonner-toast]");
    const viewport = z.object({ width: z.number(), height: z.number() }).parse(await page.eval("({ width: innerWidth, height: innerHeight })"));
    assert.ok(
      toast.height > 0 && toast.bottom <= viewport.height && toast.right <= viewport.width && toast.left > viewport.width / 2,
      `the toast is out of place: ${JSON.stringify(toast)} in ${JSON.stringify(viewport)}, ${String(await page.eval(`JSON.stringify({ visibility: document.visibilityState, mounted: document.querySelector("[data-sonner-toast]").dataset.mounted })`))}`
    );

    await page.type('input[name="token"]', TOKEN);
    await page.click('form button[type="submit"]');
    await page.until("the chat list with bob in it", `[...document.querySelectorAll("nav button")].some((each) => each.textContent.includes("bob"))`);

    // A message sent from the message box comes back from the hub into the chat.
    await page.click("nav button", "bob");
    await page.until("the message box", `document.querySelector('textarea[aria-label="Message bob"]') !== null`);
    await page.type('textarea[aria-label="Message bob"]', "hello from the window");
    await page.press("Enter");
    await page.until("the message in the chat", `document.querySelector("main").innerText.includes("hello from the window")`);

    // "@" opens the list of agents just above the message box, narrowed to bob's as his name is typed.
    await page.type('textarea[aria-label="Message bob"]', "@bob");
    await page.until("the list of agents", `document.querySelector('[role="listbox"]')?.textContent.includes("@bob/uploader") === true`);
    const list = await page.rect('[role="listbox"]');
    const box = await page.rect('textarea[aria-label="Message bob"]');
    assert.ok(list.height > 0 && list.bottom <= box.top + 1 && list.bottom > box.top - 40 && list.top >= 0, `the list of agents is out of place: ${JSON.stringify({ list, box })}`);
    await page.press("Enter");
    await page.until("Enter to take the agent", `document.querySelector('textarea[aria-label="Message bob"]').value === "@bob/uploader "`);
    await page.type('textarea[aria-label="Message bob"]', "@");
    await page.until("the list again", `document.querySelector('[role="listbox"]') !== null`);
    await page.press("Escape");
    await page.until("Esc to close the list", `document.querySelector('[role="listbox"]') === null`);
    await page.type('textarea[aria-label="Message bob"]', "");

    // Ctrl+N asks which channel to join, in a dialog in the middle of the window.
    await page.press("n", CTRL);
    await page.until("the dialog", `document.querySelector('[role="dialog"]') !== null`);
    const dialog = await page.rect('[role="dialog"]');
    assert.ok(
      Math.abs((dialog.left + dialog.right) / 2 - viewport.width / 2) < 2 && Math.abs((dialog.top + dialog.bottom) / 2 - viewport.height / 2) < 2,
      `the dialog is not centred: ${JSON.stringify(dialog)}`
    );
    await page.press("Escape");
    await page.until("the dialog to close", `document.querySelector('[role="dialog"]') === null`);

    // What a teammate writes is drawn as text, in plain messages and in Markdown alike: nothing in it runs or loads.
    await bob.publish("alice", "message", { text: `<script>window.pwned = 1</script><img src="x" onerror="window.pwned = 2"> plain`, via: "cli" });
    await bob.publish("alice", "message", {
      text: '```\nfenced\n```\n\n<script>window.pwned = 3</script>\n\n<img src=x onerror="window.pwned = 4">\n\n![remote](https://example.com/a.png)',
      via: "cli"
    });
    await page.until("both messages in the chat", `document.querySelector("main").innerText.includes("plain") && document.querySelector("main").innerText.includes("fenced")`);

    // A reply from bob shows as its root's count and last reply; alice opens the thread and replies in it.
    const root = (await bob.events({ chat: "alice" })).find((each) => each.event.content.includes("hello from the window"));
    assert.ok(root !== undefined);
    await bob.publish("alice", "message", { text: `<img src=x onerror="window.pwned = 5"> in a thread`, via: "cli" }, [root.event.id]);
    await page.until("the thread's count and last reply", `document.querySelector("main").innerText.includes("1 reply · last from bob: <img src=x")`);
    await page.click("main button", "1 reply");
    await page.until("the reply box", `document.querySelector('textarea[aria-label="Reply"]') !== null`);
    await page.type('textarea[aria-label="Reply"]', "answered in the thread");
    await page.press("Enter");
    await page.until("alice's reply in the thread", `document.querySelector('[aria-label="Thread"]').innerText.includes("answered in the thread")`);

    // Bob's reaction, an "emoji" that tries to be HTML, is drawn as text with its count; alice adds 👍 from the message's bar and takes it back from its count.
    await bob.publish("alice", "reaction", { emoji: "<img src=x onerror=pwned=6>", on: true }, [root.event.id]);
    await page.until("bob's reaction", `document.querySelector("main").innerText.includes("<img src=x onerror=pwned=6> 1")`);
    const hello = `[...document.querySelectorAll("main article")].find((each) => each.innerText.includes("hello from the window"))`;
    await page.eval(`${hello}.querySelector('button[aria-label="React with 👍"]').click()`);
    await page.until("alice's 👍", `${hello}.querySelector('button[aria-pressed="true"]')?.innerText === "👍 1"`);
    await page.eval(`${hello}.querySelector('button[aria-pressed="true"]').click()`);
    await page.until("her 👍 taken back", `${hello}.querySelector('button[aria-pressed="true"]') === null`);

    assert.equal(await page.eval(`document.querySelectorAll("main script, main img").length`), 0);
    assert.equal(await page.eval("window.pwned"), undefined);
    assert.ok(String(await page.eval(`document.querySelector("main").innerText`)).includes("<script>window.pwned = 1</script>"));
    assert.ok(String(await page.eval(`document.querySelector('[aria-label="Thread"]').innerText`)).includes(`<img src=x onerror="window.pwned = 5"> in a thread`));

    // Alice edits her message from its menu; bob edits one of his into HTML again and deletes another. Each edit says so, and the delete leaves "message deleted".
    await page.eval(`${hello}.querySelector('button[aria-label="More"]').focus()`);
    await page.press("Enter");
    await page.until("the message's menu", `document.querySelector('[role="menuitem"]') !== null`);
    await page.click('[role="menuitem"]', "Edit");
    await page.until("the edit box", `document.querySelector('textarea[aria-label="Edit message"]') !== null`);
    await page.type('textarea[aria-label="Edit message"]', "hello from the window, and again");
    await page.press("Enter");
    await page.until("her edit", `${hello}?.innerText.includes("hello from the window, and again (edited)") === true`); // While she edits, its text is in the box, where innerText does not look.
    // The same menu copies the message's link, as every message's does.
    await page.eval(`${hello}.querySelector('button[aria-label="More"]').focus()`);
    await page.press("Enter");
    await page.until("the menu again", `document.querySelector('[role="menuitem"]') !== null`);
    await page.click('[role="menuitem"]', "Copy link");
    await page.until("the link copied", `[...document.querySelectorAll("[data-sonner-toast]")].some((each) => each.textContent.includes("Link copied."))`);
    assert.equal(await page.eval("navigator.clipboard.readText()"), noteLink(root.event.id));
    const sent = await bob.events({ chat: "alice" });
    const plain = sent.find((each) => each.event.content.includes(" plain"));
    const fenced = sent.find((each) => each.event.content.includes("fenced"));
    assert.ok(plain !== undefined && fenced !== undefined);
    await bob.publish("alice", "message.edit", { text: `<img src=x onerror="window.pwned = 7"> rewritten` }, [fenced.event.id]);
    await bob.publish("alice", "message.delete", {}, [plain.event.id]);
    await page.until(
      "bob's edit and delete",
      `document.querySelector("main").innerText.includes('<img src=x onerror="window.pwned = 7"> rewritten (edited)') && document.querySelector("main").innerText.includes("message deleted")`
    );
    assert.equal(await page.eval(`document.querySelectorAll("main script, main img").length`), 0);
    assert.equal(await page.eval("window.pwned"), undefined);

    // Carol starts a channel, pins a repo to it and writes more than a page, and alice joins it from the dialog. Scrolling to the top loads the page before, and the message that was first stays where it was.
    const carol = await hub.join("carol");
    await carol.advertise([{ name: "api", key: "dev.azure.com/acme/platform/api", url: "https://dev.azure.com/acme/Platform/_git/api", branch: "main" }]); // For alice's agent to ask, far below.
    await carol.publish("#history", "channel.join", {});
    const theFirst = await carol.publish("#history", "message", { text: "the first", via: "cli" });
    await carol.publish("#history", "channel.pin", { repo: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader" }, branch: null });
    for (let count = 1; count <= 60; count += 1) {
      await carol.publish("#history", "message", { text: `history ${String(count)}`, via: "cli" });
    }
    await page.press("n", CTRL);
    await page.until("the dialog", `document.querySelector('[role="dialog"] input[name="name"]') !== null`);
    await page.type('[role="dialog"] input[name="name"]', "history");
    await page.click('[role="dialog"] button[type="submit"]');
    await page.until("the channel's newest page", `document.querySelector("main h1")?.textContent === "#history" && document.querySelector("main").innerText.includes("→ you joined")`);
    assert.ok(!String(await page.eval(`document.querySelector("main").innerText`)).includes("the first"));
    const scrolled = `document.querySelector("main [data-radix-scroll-area-viewport]")`;
    const first = `document.querySelector("main [data-seq]")`;
    const placed = z.object({ seq: z.string(), at: z.number() });
    // Where the first message shown is in what scrolls, which is where it is on the screen once the top is scrolled to.
    const before = placed.parse(await page.eval(`({ seq: ${first}.dataset.seq, at: ${first}.getBoundingClientRect().top - ${scrolled}.getBoundingClientRect().top + ${scrolled}.scrollTop })`));
    await page.eval(`${scrolled}.scrollTop = 0`);
    await page.until("the page before", `document.querySelector("main").innerText.includes("the first")`);
    await page.until("the earlier messages loaded above", `document.querySelector("main [data-seq]").dataset.seq !== ${JSON.stringify(before.seq)}`);
    const after = z.number().parse(await page.eval(`document.querySelector('main [data-seq="${before.seq}"]').getBoundingClientRect().top - ${scrolled}.getBoundingClientRect().top`));
    assert.ok(Math.abs(after - before.at) < 2, `the message that was first moved from ${String(before.at)} to ${String(after)}`);

    // The lines say who joined and pinned, each in its place among the messages.
    const history = String(await page.eval(`document.querySelector("main").innerText`));
    const order = ["→ carol joined", "the first", "◆ carol pinned uploader", "history 1\n", "history 60", "→ you joined"].map((said) => history.indexOf(said));
    assert.deepEqual(
      order.toSorted((a, b) => a - b),
      order
    );
    assert.ok(!order.includes(-1), history);

    // Alice asks bob's agent twice from the window. The first she takes back while it waits. The second bob runs: under it she sees the branch and short commit it ran at, the mode he let it
    // act at, and what it is doing, and its answer says where it ran too.
    await page.click("nav button", "bob");
    await page.until("the chat with bob", `document.querySelector("main h1")?.textContent === "bob"`);
    await page.type('textarea[aria-label="Message bob"]', "@bob/uploader never mind");
    await page.press("Enter");
    await page.until("Withdraw under the request", `[...document.querySelectorAll("main button")].some((each) => each.textContent.includes("Withdraw"))`);
    await page.click("main button", "Withdraw");
    await page.until("the request taken back", `document.querySelector("main").innerText.includes("the request was taken back")`);
    await page.type('textarea[aria-label="Message bob"]', "@bob/uploader where do we retry?");
    await page.press("Enter");
    await page.until("the second request waiting", `document.querySelector("main").innerText.includes("◌ waiting for bob to approve")`);
    const asked = (await bob.events({ chat: "alice" })).find((each) => each.event.content.includes("where do we retry?"));
    assert.ok(asked !== undefined);
    const commit = "c0ffee".padEnd(40, "0");
    await bob.publish("alice", "job.accepted", { repo: "uploader", branch: "main", commit, dirty: true, delivery: "post", mode: "full", by: "owner" }, [asked.event.id]);
    await page.until("where it runs", `document.querySelector("main").innerText.includes("bob's uploader agent is working on main ± at c0ffee0 · full")`);
    // What bob's desk says his agent is doing takes the place of "working": the few coarse words, and nothing more.
    await bob.publish("alice", "job.progress", { repo: "uploader", summary: "editing files" }, [asked.event.id]);
    await page.until("what it is doing", `document.querySelector("main").innerText.includes("bob's uploader agent is editing files on main ± at c0ffee0 · full")`);
    await bob.publish("alice", "job.result", { repo: "uploader", branch: "main", text: "in queue.py", reviewed: false }, [asked.event.id]);
    await page.until("the answer, with where it ran", `document.querySelector("main").innerText.includes("/uploader agent on main ± at c0ffee0")`);
    // Signed by bob, it is his own word, so nothing says it was not reviewed, whatever the answer itself claims.
    const bobs = `[...document.querySelectorAll("main article")].find((each) => each.innerText.includes("in queue.py")).querySelector("header").innerText`;
    assert.ok(!String(await page.eval(bobs)).includes("not reviewed"));

    // Alt+↑ and Alt+↓ move up and down the chat list from the message box, empty after a message was sent, where ↑ alone would bring that message back.
    await page.press("ArrowUp", ALT);
    await page.until("Alt+↑ to the chat above", `document.querySelector("main h1")?.textContent === "#history"`);
    await page.press("ArrowDown", ALT);
    await page.until("Alt+↓ back to bob", `document.querySelector("main h1")?.textContent === "bob"`);
    assert.equal(await page.eval(`document.querySelector('textarea[aria-label="Message bob"]').value`), "");

    // Ctrl+K finds a chat by its name as it is typed, and after a pause the messages that hold the words, the words picked out. Enter on one opens its chat with it in view and highlighted.
    const search = '[role="dialog"] input[aria-label="Search"]';
    await page.press("k", CTRL);
    await page.until("the search dialog", `document.querySelector(${JSON.stringify(search)}) !== null`);
    await page.type(search, "his");
    await page.until("#history found by its name", `document.querySelector('[role="dialog"] [cmdk-item]')?.textContent === "#history"`);
    await page.type(search, "the first");
    const chosen = `document.querySelector('[role="dialog"] [cmdk-item][data-selected="true"]')`;
    await page.until("carol's message found and chosen", `${chosen}?.textContent.includes("carol in #history") === true`);
    assert.deepEqual(await page.eval(`[...${chosen}.querySelectorAll("span.text-tag")].map((each) => each.textContent)`), ["the", "first"]);
    await page.press("Enter");
    const focused = 'main article[data-focused="true"]';
    await page.until(
      "its chat open, with it highlighted",
      `document.querySelector("main h1")?.textContent === "#history" && document.querySelector('${focused}')?.innerText.includes("the first") === true`
    );
    await inChat(page, focused, "the message opened");
    await page.click("nav button", "bob");
    await page.until("the chat with bob again", `document.querySelector("main h1")?.textContent === "bob"`);

    // A link the app is started with while it runs goes to the window already open, which opens the note: the second copy hands it over and quits.
    // Bounded, and killed at the end whatever happens: a copy that kept running would keep this test from ever ending.
    const startAgain = async (args: readonly string[]): Promise<void> => {
      const copy = spawn(electron, [ROOT, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
      t.after(() => {
        copy.kill("SIGKILL");
      });
      const copySaid: string[] = [];
      createInterface({ input: copy.stderr }).on("line", (line) => {
        copySaid.push(line);
      });
      const ended = await Promise.race([
        new Promise((resolve) => {
          copy.once("exit", resolve);
        }),
        new Promise((resolve) => {
          setTimeout(resolve, 30_000, "still running after 30 seconds").unref(); // Unref'd, so it does not hold the test open once the copy has gone.
        })
      ]);
      assert.equal(ended, 0, `the copy started again did not hand over and quit. The last it said:\n${copySaid.slice(-10).join("\n")}`);
    };
    await startAgain([noteLink(theFirst.event.id)]);
    await page.until(
      "the note the link names, open and highlighted",
      `document.querySelector("main h1")?.textContent === "#history" && document.querySelector('${focused}')?.innerText.includes("the first") === true`
    );
    await page.click("nav button", "bob");
    await page.until("the chat with bob once more", `document.querySelector("main h1")?.textContent === "bob"`);

    // A link to a note is a chip of text: who wrote it and its first words when alice can see it, in plain text and written out in Markdown alike, and "a note you cannot see" when she cannot. None is a link the window follows.
    await carol.publish("#hidden", "channel.join", {});
    const hidden = await carol.publish("#hidden", "message", { text: "not for alice", via: "cli" });
    await bob.publish("alice", "message", { text: `as carol said in ${noteLink(theFirst.event.id)}`, via: "cli" });
    await bob.publish("alice", "message", { text: `\`\`\`\nfenced\n\`\`\`\n\nsee [this note](${noteLink(hidden.event.id)}) and ${noteLink(theFirst.event.id)}`, via: "cli" });
    const chips = `[...document.querySelectorAll("main [data-note]")].map((each) => each.textContent).join(" | ")`;
    await page.until("the chips", `${chips} === "carol: the first | a note you cannot see | carol: the first"`);
    assert.equal(await page.eval(`document.querySelectorAll('main a[href^="player-two"], main a[href=""]').length`), 0);

    // The Setup page shows what to add to Cursor and to Copilot's command line to start the MCP server, each to copy.
    await page.click("button", "Setup");
    const snippets = `[...document.querySelectorAll("pre")].map((each) => JSON.stringify(JSON.parse(each.textContent).mcpServers["player-two"].args)).join(" ")`;
    await page.until("the editor agents' snippets", `document.body.innerText.includes("Editor agents") && ${snippets} === '["mcp"] ["mcp"]'`);

    // The team's repos are on Azure DevOps and she has no token, so its check fails and says how to give one, with a field for one under it. Saving keeps the token in azure.json,
    // readable only by her, and empties the field, and the token is nowhere in the page. It is not tried, which would ask the real Azure DevOps; test/doctor.test.ts tries one against a fake.
    const azureRow = `[...document.querySelectorAll("li")].find((each) => each.textContent.includes("Azure DevOps answers to your token"))`;
    await page.until(
      "the Azure DevOps check, failed for want of a token",
      `${azureRow}?.querySelector('[title="fail"]') !== null && ${azureRow}?.innerText.includes("no Azure DevOps token was found") === true && ${azureRow}.innerText.includes("Code (read and write) and Build (read)")`
    );
    await page.eval(`${azureRow}.scrollIntoView()`);
    await page.shot("azure");
    const secret = "a-token-the-page-must-never-show-0123456789";
    await page.type('input[aria-label="Azure DevOps token"]', secret);
    await page.click("button", "Save token");
    await page.until("the token saved", `document.querySelector('input[aria-label="Azure DevOps token"]')?.value === "" && document.body.innerText.includes("Token saved.")`);
    const azureFile = join(home, ".config", "player-two", "azure.json");
    assert.deepEqual(JSON.parse(readFileSync(azureFile, "utf8")), { token: secret });
    assert.equal(statSync(azureFile).mode & 0o777, 0o600);
    const shown = `document.documentElement.outerHTML.includes(${JSON.stringify(secret)}) || [...document.querySelectorAll("input")].some((each) => each.value.includes(${JSON.stringify(secret)}))`;
    assert.equal(await page.eval(shown), false);
    rmSync(azureFile); // The Setup page is opened again later, and its check would try a token on the real Azure DevOps.

    // Above them, the agent chosen when joining answers. Cursor over ACP, the next preset offered, is added and chosen, and config.json says so.
    await page.until("the agent chosen when joining", `document.querySelector('input[aria-label="Cursor one-shot answers"]')?.checked === true`);
    await page.click("button", "Add");
    await page.until("Cursor added", `document.querySelector('input[aria-label="Cursor answers"]') !== null`);
    await page.click('input[aria-label="Cursor answers"]');
    await page.until("Cursor chosen", `document.querySelector('input[aria-label="Cursor answers"]').checked === true`);
    const config = z.object({ defaultAgent: z.string(), agents: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(readFileSync(join(home, ".config", "player-two", "config.json"), "utf8")));
    assert.deepEqual([config.defaultAgent, config.agents.map((agent) => agent.id)], ["cursor", ["cursor-oneshot", "cursor"]]);

    // An agent of her own over ACP, the scripted one, typed in as a program and its arguments, is added and chosen to answer.
    await addAgent(page, process.execPath, [FAKE, "--no-pids"]);
    // Testing whether it asks before it writes a file costs a model call, so it runs only from its button: the scripted agent asks, and is refused, and writes nothing.
    const mine = `document.querySelector(${JSON.stringify(`input[aria-label=${JSON.stringify(`${process.execPath} answers`)}]`)}).closest("li")`;
    await page.eval(`[...${mine}.querySelectorAll("button")].find((each) => each.textContent === "Test permissions").click()`);
    await page.until("the test passed", `${mine}.querySelector('[data-tested="ok"]')?.innerText.includes("asked before it wrote a file, and wrote none when refused") === true`);
    await page.shot("tested");
    await page.click("button", "Back");

    // Carol asks alice's agent. Run read-only, as a teammate's request is offered first, it reads, is refused the edit the prompt's "may edit" sets it asking for, and drafts an answer;
    // alice watches it in the activity panel, where the read is dim and the refusal stands out, and a row opens to show what the agent passed its tool.
    const panel = `document.querySelector('aside[aria-label="Activity"]')`;
    const rows = `[...${panel}?.querySelectorAll("li") ?? []].map((each) => each.dataset.tone + " " + each.querySelector("span[title]").textContent)`;
    const button = (text: string): string => `[...document.querySelectorAll("main button")].some((each) => each.textContent.includes(${JSON.stringify(text)}))`;
    await carol.publish("alice", "message", { text: "@alice/billing read the README for me", via: "cli" });
    await page.until("carol in the chat list", `[...document.querySelectorAll("nav button")].some((each) => each.textContent.includes("carol"))`);
    await page.click("nav button", "carol");
    await page.until("carol's request, ready to run", `document.querySelector("main h1")?.textContent === "carol" && ${button("▶ Run read-only")}`);
    // It says where each mode runs: anything above read-only on a clean copy of the commit her checkout is on.
    const head = execFileSync("git", ["-C", join(home, "dev", "billing"), "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
    assert.ok(
      String(await page.eval(`document.querySelector("main").innerText`)).includes(
        `read-only runs in your checkout; any other mode runs on a clean copy of ${head}; your uncommitted changes are not included`
      )
    );
    await page.click("main button", "▶ Run read-only");
    await page.until("Show activity", button("Show activity"));
    await page.click("main button", "Show activity");
    await page.until("the run to its end in the panel", `${rows}.at(-1) === "plain Answered"`);
    assert.deepEqual(await page.eval(rows), [
      `plain Started ${process.execPath}, read-only`,
      "quiet Read README.md",
      "failed Edit edited.txt",
      "plain Edit edited.txt",
      "plain turn 1: read; edit refused",
      "plain Answered"
    ]);
    assert.ok(!existsSync(join(home, "dev", "billing", "edited.txt")), "the agent run read-only wrote a file");
    await page.eval(`${panel}.querySelector('li[data-tone="failed"] summary').click()`);
    await page.until("the edit's detail", `${panel}.querySelector("details[open] pre")?.textContent === ${JSON.stringify(JSON.stringify({ title: "Edit edited.txt" }, null, 1))}`);
    await page.shot("activity");
    await page.click("main button", "Discard");
    await page.until("the draft gone", `document.querySelector('textarea[aria-label="Draft answer"]') === null`);

    // A run with nothing new for ten seconds says "waiting…", and Stop ends it: in a channel of its own, so that its "slow" reaches no later prompt.
    await carol.publish("#history", "message", { text: "@alice/billing slow", via: "cli" });
    await page.click("nav button", "#history");
    await page.until("the slow request, ready to run", `document.querySelector("main h1")?.textContent === "#history" && ${button("▶ Run read-only")}`);
    await page.click("main button", "▶ Run read-only");
    await page.until("Show activity on the run", button("Show activity"));
    await page.click("main button", "Show activity");
    await page.until("waiting…", `${panel}?.innerText.includes("waiting…") === true`);
    await page.shot("waiting");
    await page.click("main button", "Stop");
    await page.until("the run stopped", `${rows}.at(-1) === "plain Stopped"`);

    // Her own tag, sent from her window, runs at once at the mode for her own requests, auto-edits, where running a command asks first: the card is under her message and in the panel,
    // and "Allow once" lets the agent go on to its answer. In her chat with bob, whose earlier messages hold no word the agent acts on.
    const card = (where: string): string => `document.querySelector('${where} section[aria-label="Permission"]')`;
    await page.click("nav button", "bob");
    await page.until("the chat with bob, for her own request", `document.querySelector("main h1")?.textContent === "bob"`);
    await page.type('textarea[aria-label="Message bob"]', "@alice/billing run the tests");
    await page.press("Enter");
    await page.until("the card under her message", `${card("main")}?.innerText.includes("Run npm test") === true`);
    await page.click("main button", "Show activity");
    await page.until("the card in the panel", `${card("aside")}?.innerText.includes("Run npm test") === true`);
    await page.shot("card");
    await page.eval(`[...${card("aside")}.querySelectorAll("button")].find((each) => each.textContent === "Allow once").click()`);
    await page.until("her agent's answer", `[...document.querySelectorAll("main article")].some((each) => each.innerText.includes("turn 1: run allowed"))`);
    await page.until("the run to its end in the panel", `${rows}.at(-1) === "plain Answered"`);
    assert.deepEqual(await page.eval(rows), [`plain Started ${process.execPath}, auto-edits`, "loud Ran npm test", "plain Run npm test", "plain turn 1: run allowed", "plain Answered"]);
    assert.equal(await page.eval(`document.querySelectorAll('section[aria-label="Permission"]').length`), 0);

    // Dave asks in a reply in a thread, and alice runs it supervised from the menu there, reviewed, where the prompt's "may edit" has the agent ask before it edits: the card is under the
    // reply. With the replies hidden, and after going to another chat and back, which closes every thread, it is under the thread's summary, where "Refuse" keeps the file unwritten.
    const dave = await hub.join("dave");
    const topic = await dave.publish("alice", "message", { text: "a thread about billing", via: "cli" });
    await dave.publish("alice", "message", { text: "@alice/billing tidy it up", via: "cli" }, [topic.event.id]);
    await page.until("dave in the chat list", `[...document.querySelectorAll("nav button")].some((each) => each.textContent.includes("dave"))`);
    await page.click("nav button", "dave");
    await page.until("the thread's summary", `document.querySelector("main h1")?.textContent === "dave" && document.querySelector("main").innerText.includes("1 reply")`);
    await page.click("main button", "1 reply");
    const inThread = `document.querySelector('main section[aria-label="Thread"] button[title="Choose how to run it"]')`;
    await page.until("the request in the thread", `${inThread} !== null`);
    await page.eval(`${inThread}.focus()`);
    await page.press("Enter");
    await page.until("the menu", `document.querySelector('[role="menuitem"][data-mode="supervised"]') !== null`);
    await page.click('[role="menuitem"][data-mode="supervised"]');
    await page.until("the card under the reply", `${card('main section[aria-label="Thread"]')}?.innerText.includes("Edit edited.txt") === true`);
    const announced = `${card("main")}.parentElement.getAttribute("aria-live") === "polite"`; // A screen reader says it: it comes into a region there before it.
    assert.equal(await page.eval(announced), true);
    await page.click("main button", "Hide replies");
    await page.until("the card under the closed thread", `document.querySelector('main section[aria-label="Thread"]') === null && ${card("main")}?.innerText.includes("Edit edited.txt") === true`);
    assert.equal(await page.eval(announced), true);
    await page.click("nav button", "bob");
    await page.until("the chat with bob", `document.querySelector("main h1")?.textContent === "bob" && ${card("main")} === null`);
    await page.click("nav button", "dave");
    await page.until("the card still in reach", `document.querySelector("main h1")?.textContent === "dave" && ${card("main")}?.innerText.includes("Edit edited.txt") === true`);
    await page.eval(`[...${card("main")}.querySelectorAll("button")].find((each) => each.textContent === "Refuse").click()`);
    await page.until("its draft", `document.querySelector('textarea[aria-label="Draft answer"]')?.value.includes("edit refused") === true`);
    assert.ok(!existsSync(join(home, "dev", "billing", "edited.txt")));
    await page.click("main button", "Discard");
    await page.until("the draft gone", `document.querySelector('textarea[aria-label="Draft answer"]') === null`);

    // Dave asks for two edits, three asks with the prompt's "may edit", and alice runs it as she ran his last. While she reads at the end of the chat, he writes on below the request:
    // the next card, under the request far above, is brought into view. "Allow for this run" on it allows the third edit without asking.
    await dave.publish("alice", "message", { text: "@alice/billing edit this, then edit that", via: "cli" });
    const daves = `[...document.querySelectorAll("main article")].find((each) => each.innerText.includes("edit this, then edit that"))`;
    const supervised = `[...(${daves}?.querySelectorAll("button") ?? [])].find((each) => each.textContent === "▶ Run supervised")`;
    await page.until("dave's request, offered as alice ran his last", `${supervised} !== undefined`);
    await page.eval(`${supervised}.click()`);
    await page.until("the first card", `${card("main")} !== null`);
    for (let count = 1; count <= 40; count += 1) {
      await dave.publish("alice", "message", { text: `and another thing ${String(count)}`, via: "cli" });
    }
    await page.until("dave's last word, at the end of the chat", `document.querySelector("main").innerText.includes("and another thing 40")`);
    await page.eval(`${card("main")}.dataset.answered = "yes"`);
    await page.eval(`[...${card("main")}.querySelectorAll("button")].find((each) => each.textContent === "Allow once").click()`);
    const next = `main section[aria-label="Permission"]:not([data-answered])`;
    await page.until("the next card", `document.querySelector('${next}') !== null`);
    await inChat(page, next, "the new card");
    const forTheRun = `[...document.querySelector('${next}').querySelectorAll("button")].find((each) => each.textContent === "Allow for this run")`;
    await page.eval(`${forTheRun}.focus()`);
    await page.until("what it allows, on focus", `document.querySelector('[role="tooltip"]')?.textContent === "Allow every edit without asking until this run ends"`);
    await page.eval(`${forTheRun}.click()`);
    await page.until("its draft, every edit allowed", `document.querySelector('textarea[aria-label="Draft answer"]')?.value.includes("edit allowed; edit allowed; edit allowed") === true`);
    // Beside it, what the run changed on its clean copy, as a card, to go with it.
    const beside = `[...document.querySelector('textarea[aria-label="Draft answer"]').closest("section").querySelectorAll('section[aria-label="Patch"] summary')]`;
    assert.deepEqual(await page.eval(`${beside}.map((each) => each.textContent)`), ["edited.txt +1 −0"]);
    assert.ok(!existsSync(join(home, "dev", "billing", "edited.txt"))); // Written on a clean copy of her checkout, never in it.
    await page.click("main button", "Discard");
    await page.until("the draft gone again", `document.querySelector('textarea[aria-label="Draft answer"]') === null`);

    // Carol asks again, and alice runs it from the menu: the answer posted directly, at supervised, where the agent asks before it edits. "Allow once" on the card under the request
    // lets it write the file and answer, and the chat's record says it ran supervised. Carol's next request is offered as alice ran this one, from app-state.json.
    const newest = `[...document.querySelectorAll("main article")].at(-1)`;
    const another = `${newest}.querySelector('button[title="Choose how to run it"]')`;
    await carol.publish("alice", "message", { text: "@alice/billing edit the README", via: "cli" });
    await page.click("nav button", "carol");
    await page.until("carol's second request, ready to run", `document.querySelector("main h1")?.textContent === "carol" && ${newest}.innerText.includes("edit the README") && ${another} !== null`);
    await page.eval(`${another}.focus()`);
    await page.press("Enter");
    await page.until("the menu", `document.querySelector('[role="menuitemradio"]') !== null`);
    await page.click('[role="menuitemradio"]', "Post it directly");
    await page.until("posting chosen, the menu still open", `document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent.includes("Post it directly") === true`);
    assert.ok(!String(await page.eval(`document.querySelector('[role="menu"]').innerText`)).includes("not tested")); // The scripted agent was tested on the Setup page.
    await page.shot("menu");
    await page.click('[role="menuitem"][data-mode="supervised"]');
    await page.until("the card under carol's request", `${card("main")}?.innerText.includes("Edit edited.txt") === true`);
    assert.match(String(await page.eval(`${newest}.innerText`)), /your billing agent is working on main at [0-9a-f]{7} · supervised · /);
    await page.eval(`[...${newest}.querySelectorAll("button")].find((each) => each.textContent.includes("Show activity")).click()`);
    await page.until("the card in the panel", `${card("aside")}?.innerText.includes("Edit edited.txt") === true`);
    assert.equal(await page.eval(`${panel}.querySelector("li .sr-only")?.textContent`), "running");
    await page.eval(`[...${card("main")}.querySelectorAll("button")].find((each) => each.textContent === "Allow once").click()`);
    await page.until("the answer posted", `[...document.querySelectorAll("main article")].some((each) => each.innerText.includes("turn 1: read; edit allowed"))`);
    await page.until("the run to its end in the panel", `${rows}.at(-1) === "plain Answered"`);
    assert.deepEqual(await page.eval(rows), [
      `plain Started ${process.execPath}, supervised`,
      "quiet Read README.md",
      "loud Edit edited.txt",
      "plain Edit edited.txt",
      "plain turn 1: read; edit allowed",
      "plain Answered"
    ]);
    assert.ok(!existsSync(join(home, "dev", "billing", "edited.txt")));
    assert.equal(await acceptedAt(carol, "alice"), "supervised");
    const saved = z.object({ choices: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(join(home, ".config", "player-two", "app-state.json"), "utf8")));
    assert.deepEqual(saved.choices["carol billing"], { mode: "supervised", post: true, agent: { id: "custom", line: commandLineOf({ command: process.execPath, args: [FAKE, "--no-pids"] }) } });
    await carol.publish("alice", "message", { text: "@alice/billing and once more", via: "cli" });
    await page.until(
      "carol's next request, offered as alice ran the last",
      `${newest}.innerText.includes("and once more") && [...${newest}.querySelectorAll("button")].some((each) => each.textContent === "▶▶ Run supervised and post")`
    );

    // She runs that one at full from the menu, where the agent asks nothing. The agent that answers can be held to less, so a full is not offered again in one click: carol's next request
    // is offered read-only, reviewed.
    await page.eval(`${another}.focus()`);
    await page.press("Enter");
    await page.until("the menu, for full", `document.querySelector('[role="menuitem"][data-mode="full"]') !== null`);
    await page.click('[role="menuitem"][data-mode="full"]');
    await page.until("the answer at full", `[...document.querySelectorAll("main article")].some((each) => each.innerText.includes("carol: @alice/billing and once more"))`);
    assert.equal(await acceptedAt(carol, "alice"), "full");
    await carol.publish("alice", "message", { text: "@alice/billing and after that", via: "cli" });
    await page.until(
      "carol's next request, offered read-only",
      `${newest}.innerText.includes("and after that") && [...${newest}.querySelectorAll("button")].some((each) => each.textContent === "▶ Run read-only")`
    );
    assert.ok(!String(await page.eval(`${newest}.innerText`)).includes("Run full"));

    // With Copilot's one-shot command answering, which runs only at full, that offer cannot be kept: there is no first button, and the menu offers full alone, beside the reason.
    const chooseAgent = async (label: string): Promise<void> => {
      await page.click("button", "Setup");
      await page.until("her agents on the Setup page", `document.querySelector('input[aria-label="Cursor one-shot answers"]') !== null`);
      const answers = `input[aria-label=${JSON.stringify(`${label} answers`)}]`;
      if ((await page.eval(`document.querySelector(${JSON.stringify(answers)}) === null`)) === true) {
        await page.click("button", "Add"); // The next agent offered.
        await page.until(`${label} added`, `document.querySelector(${JSON.stringify(answers)}) !== null`);
      }
      await page.click(answers);
      await page.until(`${label} chosen`, `document.querySelector(${JSON.stringify(answers)}).checked === true`);
      await page.click("button", "Back");
    };
    const menuModes = `[...document.querySelectorAll('[role="menuitem"][data-mode]')].map((each) => each.dataset.mode)`;
    const openMenu = async (): Promise<void> => {
      await page.eval(`${another}.focus()`);
      await page.press("Enter");
      await page.until("the menu", `document.querySelector('[role="menuitem"][data-mode]') !== null`);
    };
    await chooseAgent("Copilot one-shot");
    await page.until("no first button", `document.querySelector("main h1")?.textContent === "carol" && ${another}?.textContent === "▶ Run…" && !${another}.hasAttribute("aria-label")`);
    await openMenu();
    assert.deepEqual(await page.eval(menuModes), ["full"]);
    const described = `document.getElementById(document.querySelector('[role="menuitem"][data-mode="full"]').getAttribute("aria-describedby")).textContent`;
    assert.equal(await page.eval(described), "Copilot one-shot runs as a single command and cannot be limited: it runs only with full access.");
    await page.shot("cannot");
    await page.press("Escape");
    await page.until("the menu closed", `document.querySelector('[role="menu"]') === null`);

    // With Cursor's one-shot command answering, which keeps read-only and full and nothing between, the offer is kept, and the menu offers the two modes and says why not the others.
    await chooseAgent("Cursor one-shot");
    await page.until(
      "the first button again",
      `document.querySelector("main h1")?.textContent === "carol" && [...${newest}.querySelectorAll("button")].some((each) => each.textContent === "▶ Run read-only")`
    );
    await openMenu();
    assert.deepEqual(await page.eval(menuModes), ["read-only", "full"]);
    assert.ok(
      String(await page.eval(`document.querySelector('[role="menu"]').innerText`)).includes(
        "Cursor one-shot runs either read-only, when it only proposes changes, or with full access, and nothing between."
      )
    );
    await page.press("Escape");
    await page.until("the menu closed again", `document.querySelector('[role="menu"]') === null`);

    // With Cursor over ACP answering, whose permissions were never tested, every mode is offered all the same, and the menu says where to test it.
    await chooseAgent("Cursor");
    await page.until(
      "the first button with Cursor",
      `document.querySelector("main h1")?.textContent === "carol" && [...${newest}.querySelectorAll("button")].some((each) => each.textContent === "▶ Run read-only")`
    );
    await openMenu();
    assert.deepEqual(await page.eval(menuModes), ["read-only", "supervised", "auto-edits", "full"]);
    assert.equal(await page.eval(described), "Permissions not tested — Setup → Test permissions.");
    await page.shot("untested");
    await page.press("Escape");
    await page.until("the menu closed once more", `document.querySelector('[role="menu"]') === null`);

    // On My agents, a grant on it below full would never run with nobody watching, so the dialog offers full alone, and says where to test it.
    await page.click("footer button", "My agents");
    const newGrant = `[...document.querySelectorAll('li[data-repo="billing"] button')].find((each) => each.textContent === "New grant")`;
    await page.until("her billing agent with Cursor answering", `${newGrant} !== undefined`);
    await page.eval(`${newGrant}.click()`);
    const modes = `document.querySelector('[role="dialog"] select[name="mode"]')`;
    await page.until("the grant's dialog with Cursor answering", `${modes} !== null`);
    assert.deepEqual(await page.eval(`[...${modes}.options].map((each) => each.value + (each.disabled ? " disabled" : ""))`), [
      "read-only disabled",
      "supervised disabled",
      "auto-edits disabled",
      "full"
    ]);
    assert.equal(await page.eval(`${modes}.value`), "full");
    assert.match(String(await page.eval(`document.querySelector('[role="dialog"]').innerText`)), /Only full can be chosen\. Cursor's permissions have not been tested.*Setup → Test permissions/);
    await page.shot("grant-untested");
    await page.press("Escape");
    await page.until("the grant's dialog closed", `document.querySelector('[role="dialog"]') === null`);
    await page.click("button", "Back");

    // My agents, with the scripted agent answering again: a row for her billing agent, on its branch, and who answers for it. From its dialog, which offers the modes that agent can keep, she
    // grants full access posted directly for anyone, which asks a second yes first, and carol read-only, posted directly, three times a day, double-clicking each time: each makes one grant.
    // She revokes the first, double-clicking, and it alone goes. Carol's next request runs with nobody touching the window, and the grant counts it.
    await chooseAgent(process.execPath);
    await page.click("footer button", "My agents");
    const billing = `document.querySelector('li[data-repo="billing"]')`;
    await page.until("her billing agent", `${billing}?.innerText.includes(${JSON.stringify(`on main · ${process.execPath} answers`)}) === true && ${billing}.innerText.includes("No grants")`);
    await page.eval(`[...${billing}.querySelectorAll("button")].find((each) => each.textContent === "New grant").click()`);
    const form = `document.querySelector('[role="dialog"] form')`;
    await page.until("the grant's dialog", `${form} !== null`);
    assert.deepEqual(await page.eval(`[...${form}.querySelector('select[name="mode"]').options].map((each) => each.value)`), ["read-only", "supervised", "auto-edits", "full"]);
    const choose = async (name: string, value: string): Promise<void> => {
      await page.eval(
        `(() => { const select = ${form}.querySelector('select[name="${name}"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event("change", { bubbles: true })); })()`
      );
      await page.until(`${name} chosen`, `${form}.querySelector('select[name="${name}"]').value === ${JSON.stringify(value)}`);
    };
    // Kept for her review unless she says otherwise; posted directly, the dialog warns her what the agent can read.
    const unread = `${form}.innerText.includes("The answer goes to them unread.")`;
    assert.deepEqual([await page.eval(`${form}.querySelector('select[name="delivery"]').value`), await page.eval(unread)], ["review", false]);
    // Full access for anyone is warned of whatever the delivery: a review comes only after the agent has acted.
    const anyoneFull = `${form}.innerText.includes("Anyone on the hub, and anyone who joins it later, could have your billing agent do anything your account can on this machine")`;
    await choose("asker", "*");
    await choose("mode", "full");
    await page.until("the warning about full access for anyone, reviewed", `${anyoneFull} && ${form}.innerText.includes("you would review its answer, but only once it has acted")`);
    await choose("delivery", "post");
    await page.until("the warning", unread);
    assert.equal(await page.eval(anyoneFull), true);
    await page.click('[role="dialog"] button[type="submit"]');
    await page.until("the second yes", `document.querySelector('[role="dialog"]')?.innerText.includes("Let anyone run your billing agent with full access?") === true`);
    await page.shot("grant-everyone");
    await page.click('[role="dialog"] button', "Back");
    await page.until("the grant's dialog again", `${form}?.querySelector('select[name="mode"]').value === "full"`);
    await page.click('[role="dialog"] button[type="submit"]');
    const yes = `[...document.querySelectorAll('[role="dialog"] button')].find((each) => each.textContent === "Grant full access to anyone")`;
    await page.until("the second yes again", `${yes} !== undefined`);
    await page.doubleClick(yes);
    const granted = `document.querySelector('li[data-grant]')`;
    await page.until(
      "the grant for anyone listed",
      `document.querySelector('[role="dialog"]') === null && ${granted}?.innerText.includes("anyone on the hub · full · posted directly · until ") === true`
    );
    await page.eval(`[...${billing}.querySelectorAll("button")].find((each) => each.textContent === "New grant").click()`);
    await page.until("the grant's dialog once more", `${form} !== null`);
    await choose("asker", "carol");
    await choose("mode", "read-only");
    await choose("delivery", "post");
    await page.type(`[role="dialog"] input[name="runs"]`, "3");
    await page.shot("grant");
    await page.doubleClick(`document.querySelector('[role="dialog"] button[type="submit"]')`);
    const carols = `document.querySelectorAll('li[data-grant]')[1]`;
    await page.until("carol's grant listed", `document.querySelector('[role="dialog"]') === null && ${carols}?.innerText.includes("carol · read-only · posted directly · until ") === true`);
    // What alice sent to everyone, once anything a second click would have sent has had time to arrive.
    const toEveryone = async (kind: string): Promise<number> => {
      await pause(1000);
      return (await carol.events({ chat: "*" })).filter(({ event }) => event.author === "alice" && event.kind === kind).length;
    };
    assert.equal(await toEveryone("grant"), 2);
    // The second click comes once the first has revoked the grant for anyone, and lands on carol's Revoke, which has moved up under the pointer: it revokes nothing.
    await page.doubleClick(`${granted}.querySelector("button")`, () =>
      page.until("the grant for anyone gone", `document.querySelectorAll('li[data-grant]').length === 1 && ${granted}.innerText.includes("carol · read-only")`)
    );
    assert.equal(await toEveryone("grant.revoke"), 1);
    assert.equal(await page.eval(`document.querySelectorAll('li[data-grant]').length`), 1);
    assert.match(String(await page.eval(`${granted}.innerText`)), / · 0 of 3 runs today/);
    await page.shot("my-agents");
    await page.click("button", "Back");
    await carol.publish("alice", "message", { text: "@alice/billing read it under the grant", via: "cli" });
    const answered = `[...document.querySelectorAll("main article")].find((each) => each.innerText.includes("carol: @alice/billing read it under the grant"))`;
    await page.until("carol's request answered", `${answered} !== undefined`);
    // Her checkout has nothing uncommitted, so no ±: teammates' edits went on clean copies of it.
    assert.match(String(await page.eval(`${answered}.querySelector("header").innerText`)), /\/billing agent on main at [0-9a-f]{7} · ran under your grant, read-only, until .+ · not reviewed\n/);
    assert.equal(await acceptedAt(carol, "alice"), "read-only");
    // A slow one of hers in #history runs under the grant too: the line under it tells alice, its owner, that it runs under her grant, until she stops it.
    await carol.publish("#history", "message", { text: "@alice/billing slow, under the grant", via: "cli" });
    await page.click("nav button", "#history");
    const slowly = `[...document.querySelectorAll("main article")].find((each) => each.innerText.includes("slow, under the grant"))`;
    await page.until(
      "the line under it saying it runs under her grant",
      `/your billing agent is working on main (± )?at [0-9a-f]{7} · under your grant, read-only, until /.test(${slowly}?.innerText ?? "")`
    );
    await page.eval(`[...${slowly}.querySelectorAll("button")].find((each) => each.textContent.includes("Stop")).click()`);
    await page.until("it stopped", `${slowly}.innerText.includes("◆ stopped · your billing agent")`);
    await page.click("nav button", "carol");
    await page.until("the chat with carol again", `document.querySelector("main h1")?.textContent === "carol"`);
    await page.click("footer button", "My agents");
    await page.until("both runs counted", `${granted}?.innerText.includes(" · 2 of 3 runs today") === true`);

    // Held back, her billing agent is no longer shared with the team, config.json says so, and carol's next request waits, though the grant stands. Let answer again, it is shared again.
    const shared = async (expected: boolean): Promise<void> => {
      for (let tries = 0; (await carol.repos()).some((repo) => repo.user === "alice" && repo.name === "billing") !== expected; tries += 1) {
        assert.ok(tries < 100, `billing is ${expected ? "still not" : "still"} shared after 10 seconds`);
        await pause(100);
      }
    };
    await shared(true);
    // Double-clicked, its second click once the button says "Let it answer", it is held back all the same.
    const heldBack = `${billing}.innerText.includes("held back: not shared with the team, and it answers nobody")`;
    await page.doubleClick(`[...${billing}.querySelectorAll("button")].find((each) => each.textContent === "Hold back")`, () => page.until("billing held back", heldBack));
    await pause(1000); // For anything the second click would have sent to arrive.
    assert.equal(await page.eval(heldBack), true);
    await shared(false);
    assert.deepEqual(z.object({ held: z.array(z.string()) }).parse(JSON.parse(readFileSync(join(home, ".config", "player-two", "config.json"), "utf8"))).held, ["billing"]);
    await page.shot("held");
    await page.click("button", "Back");
    await carol.publish("alice", "message", { text: "@alice/billing read it while held", via: "cli" });
    await page.until("carol's request, held", `${newest}.innerText.includes("read it while held") && ${newest}.innerText.includes("◆ you hold back your billing agent, so it answers nobody")`);
    await page.click("footer button", "My agents");
    await page.until("still two runs today", `${granted}?.innerText.includes(" · 2 of 3 runs today") === true`);
    await page.eval(`[...${billing}.querySelectorAll("button")].find((each) => each.textContent === "Let it answer").click()`);
    await page.until("billing answering again", `${billing}.innerText.includes(${JSON.stringify(`on main · ${process.execPath} answers`)})`);
    await shared(true);

    // With her grant live, closing the window would hide it to the tray, the first time with a notification saying so. None can be shown here, so it stays open and says why in
    // the window, and the window's own settings do not count her as told. Starting at login is left alone: Electron cannot here.
    await page.click("button", "Back");
    const windowSettings = join(home, ".config", "Player Two", "settings.json");
    const told = (): unknown => (existsSync(windowSettings) ? z.object({ toldHidden: z.boolean().optional() }).parse(JSON.parse(readFileSync(windowSettings, "utf8"))).toldHidden : undefined);
    // Ctrl+W is Electron's own Window → Close, as the window's close button is: a close the app may turn down, which a page's window.close() is not.
    await page.press("w", CTRL, "rawKeyDown");
    await page.until(
      "the window saying why it stays",
      `[...document.querySelectorAll("[data-sonner-toast]")].some((each) => each.textContent.includes("Player Two stays open while a grant of yours is live"))`
    );
    assert.deepEqual([await page.eval("document.visibilityState"), app.exitCode, told()], ["visible", null, undefined]);

    // Told on an earlier run, where a notification could be shown, closing hides the window, and her desk goes on answering: carol's next request runs under the grant.
    // Starting the app again brings the same window back.
    writeFileSync(windowSettings, JSON.stringify({ distro: null, toldHidden: true }));
    await page.press("w", CTRL, "rawKeyDown");
    await page.until("the window hidden", `document.visibilityState === "hidden"`);
    await carol.publish("alice", "message", { text: "@alice/billing read it while hidden", via: "cli" });
    await page.until("carol's request answered while hidden", `[...document.querySelectorAll("main article")].some((each) => each.innerText.includes("carol: @alice/billing read it while hidden"))`);
    assert.equal(app.exitCode, null);
    await startAgain([]);
    await page.until("the window shown again", `document.visibilityState === "visible"`);
    await page.click("footer button", "My agents");
    await page.until("all three runs counted", `${granted}?.innerText.includes(" · 3 of 3 runs today") === true`);

    // Once her checkout is no longer of a team repo, its row goes and the grant on it is listed apart, where she revokes it; checked out again, billing has no grant.
    // The desk looks under ~/dev again on its next beat, or at once when told what is held back, which is asked here so as not to wait.
    const origin = (url: string): void => {
      execFileSync("git", ["-C", join(home, "dev", "billing"), "remote", "set-url", "origin", url]);
    };
    const lookAgain = `window.playerTwo.command({ do: "hold", repo: "billing", held: false })`;
    const away = `document.querySelector('li[data-away="billing"]')`;
    origin("https://example.com/elsewhere/billing.git");
    await page.eval(lookAgain);
    await page.until("the grant listed apart", `${billing} === null && ${away}?.querySelector("li[data-grant]")?.innerText.includes("carol · read-only · posted directly") === true`);
    assert.ok(String(await page.eval("document.body.innerText")).includes("Grants on repos not checked out here"));
    await page.shot("away");
    await page.eval(`[...${away}.querySelectorAll("button")].find((each) => each.textContent === "Revoke").click()`);
    await page.until("the grant gone", `${away} === null`);
    origin("https://dev.azure.com/acme/Platform/_git/billing");
    await page.eval(lookAgain);
    await page.until("billing back, with no grant", `${billing}?.innerText.includes("No grants") === true`);
    await page.click("button", "Back");

    // Alice asks bob's agent, and a grant of bob's lets it run: the line under her request says whose grant it runs under, at which mode and until when, and so does the answer.
    const bobsGrant = await bob.publish("*", "grant", {
      agent: "bob/uploader",
      askers: ["alice"],
      mode: "read-only",
      delivery: "post",
      expires: Math.floor(Date.now() / 1000) + 86_400,
      runsPerDay: 5
    });
    await page.click("nav button", "bob");
    await page.until("the chat with bob, to ask under his grant", `document.querySelector("main h1")?.textContent === "bob"`);
    await page.type('textarea[aria-label="Message bob"]', "@bob/uploader what changed under the grant?");
    await page.press("Enter");
    await page.until("her request waiting", `${newest}.innerText.includes("what changed under the grant?") && ${newest}.innerText.includes("◌ waiting for bob to approve")`);
    const underGrant = (await bob.events({ chat: "alice" })).find((each) => each.event.content.includes("what changed under the grant?"));
    assert.ok(underGrant !== undefined);
    await bob.publish("alice", "job.accepted", { repo: "uploader", branch: "main", commit, dirty: false, delivery: "post", mode: "read-only", by: { grant: bobsGrant.event.id } }, [
      underGrant.event.id
    ]);
    await page.until("whose grant it runs under", `${newest}.innerText.includes("bob's uploader agent is working on main at c0ffee0 · under bob's grant, read-only, until ")`);
    // The answer is posted by bob's agent itself, with its own key, which bob registered: it says it was not reviewed.
    const bobsAgent = newKey();
    await bob.publish("*", "agent.register", { repo: "uploader", pubkey: publicHex(bobsAgent) });
    await bob.as("bob/uploader", bobsAgent).publish("alice", "job.result", { repo: "uploader", branch: "main", text: "nothing yet", reviewed: false }, [underGrant.event.id]);
    await page.until(
      "the answer, with whose grant it ran under and that nobody reviewed it",
      `/\\/uploader agent on main at c0ffee0 · ran under bob's grant, read-only, until .+ · not reviewed\\n/.test(${newest}.querySelector("header")?.innerText ?? "")`
    );
    await page.shot("under-grant");
    // Search finds that answer, and says nobody reviewed it, as its header does.
    await page.press("k", CTRL);
    await page.until("the search dialog again", `document.querySelector(${JSON.stringify(search)}) !== null`);
    await page.type(search, "nothing yet");
    await page.until(
      "bob's agent's answer found, not reviewed",
      `[...document.querySelectorAll('[role="dialog"] [cmdk-item]')].some((each) => each.textContent.includes("bob/uploader agent in bob · not reviewed"))`
    );
    await page.press("Escape");
    await page.until("the search closed", `document.querySelector('[role="dialog"]') === null`);

    await askingAgents(page, bob, carol, bobsAgent, commit);
    await patches(page, await hub.join("erin"));

    assert.deepEqual(page.problems, []);

    // With no grant of hers live, closing the window quits the app, as it always did.
    // Not waited for: an app that has quit never answers the key's release.
    page.press("w", CTRL, "rawKeyDown").catch(() => undefined);
    const gave = new Promise((resolve) => {
      setTimeout(resolve, 30_000, "still running after 30 seconds").unref(); // Unref'd, so it does not hold the test open once the app has gone.
    });
    assert.equal(await Promise.race([exited, gave]), 0, "closing the window with no grant live did not quit the app");
  }
);
