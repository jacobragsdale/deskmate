/** The window for real: Electron started on the built app with a home of its own, against a hub in this process, driven over the DevTools protocol the way a person would. It needs a display; CI gives it one with xvfb-run. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { z } from "zod";

import { startHub, TOKEN } from "./startHub.ts";

const ROOT = join(import.meta.dirname, "..");
const NO_DISPLAY = process.platform === "linux" && (process.env["DISPLAY"] ?? "") === "" && (process.env["WAYLAND_DISPLAY"] ?? "") === "";
const KEYS = { Enter: { code: "Enter", keyCode: 13 }, Escape: { code: "Escape", keyCode: 27 }, n: { code: "KeyN", keyCode: 78 } } as const;
const CTRL = 2; // The DevTools protocol's bit for the Ctrl key.

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
    return page;
  }

  public async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.next += 1;
    const id = this.next;
    const reply = await new Promise<z.infer<typeof replySchema>>((resolve) => {
      this.waiting.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
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

  public async press(key: keyof typeof KEYS, modifiers = 0): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", { type, key, code: KEYS[key].code, windowsVirtualKeyCode: KEYS[key].keyCode, modifiers });
    }
  }

  public close(): void {
    this.socket.close();
  }
}

await test(
  "the window joins, opens a chat, sends a note and reads it back, shows a popover, a dialog and a toast in place, and draws a hostile note as text",
  { skip: NO_DISPLAY ? "no display: run it under xvfb-run" : false, timeout: 120_000 },
  async (t) => {
    assert.ok(existsSync(join(ROOT, "dist", "main.js")), "dist/ is not built: run `npm run build` first");
    const electron: unknown = createRequire(import.meta.url)("electron"); // Required from Node, the package is the path to its binary, which it downloads the first time.
    assert.ok(typeof electron === "string");

    // A home of its own: the identity, the repos folder and Electron's own settings all go there. Started before the hub, it is stopped before the hub is.
    const home = mkdtempSync(join(tmpdir(), "player-two-window-"));
    mkdirSync(join(home, "dev"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    delete env["PLAYER_TWO_HOME"];
    delete env["PLAYER_TWO_DEV"];
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

    // A note sent from the message box comes back from the hub into the thread.
    await page.click("nav button", "bob");
    await page.until("the message box", `document.querySelector('textarea[aria-label="Message bob"]') !== null`);
    await page.type('textarea[aria-label="Message bob"]', "hello from the window");
    await page.press("Enter");
    await page.until("the note in the thread", `document.querySelector("main").innerText.includes("hello from the window")`);

    // "@" opens the list of agents just above the message box.
    await page.type('textarea[aria-label="Message bob"]', "@");
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

    // What a teammate writes is drawn as text, in plain notes and in Markdown alike: nothing in it runs or loads.
    await bob.publish("alice", "message", { text: `<script>window.pwned = 1</script><img src="x" onerror="window.pwned = 2"> plain`, via: "cli" });
    await bob.publish("alice", "message", {
      text: '```\nfenced\n```\n\n<script>window.pwned = 3</script>\n\n<img src=x onerror="window.pwned = 4">\n\n![remote](https://example.com/a.png)',
      via: "cli"
    });
    await page.until("both notes in the thread", `document.querySelector("main").innerText.includes("plain") && document.querySelector("main").innerText.includes("fenced")`);

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

    assert.deepEqual(page.problems, []);
  }
);
