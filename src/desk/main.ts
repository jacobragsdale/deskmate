/** The desk as a program: one person's session with no window. It reads the window's lines on one stream, writes its own on another, and opens nothing else. */

import { createInterface } from "node:readline";

import { problemOf } from "../core/text.ts";
import { VERSION } from "../core/version.ts";
import { PROTOCOL } from "../core/wire.ts";
import { readLine, windowLineSchema } from "../shared/ipc.ts";
import type { Command, DeskLine, Outcome, Question, View } from "../shared/ipc.ts";
import { PRESETS } from "./agents/presets.ts";
import { saveToken } from "./azure.ts";
import { defaultDev, defaultHome, http, join, loadClient, PlayerTwoError } from "./client.ts";
import { runChecks, WITHOUT_IDENTITY } from "./doctor.ts";
import { Session } from "./session.ts";
import type { Hooks } from "./session.ts";
import { shellPath } from "./shellEnv.ts";
import { sweep } from "./worktree.ts";

class Desk {
  private readonly home = defaultHome();
  private readonly asked = new Map<number, (ok: boolean) => void>(); // Questions the user has not answered yet, by id.
  private readonly output: NodeJS.WritableStream;
  private readonly hooks: Hooks;
  private readonly stopping = new AbortController(); // Aborted once the window has gone, ending the agents a setup check still going has started.
  private session: Session | null = null; // Null until someone has joined a hub from this machine.
  private attentive = true; // What the window last said, kept for a session that starts later.
  private viewQueued = false;
  private asks = 0;
  private ended = false;

  constructor(output: NodeJS.WritableStream) {
    this.output = output;
    this.hooks = {
      changed: () => {
        this.changed();
      },
      notice: (notice) => {
        this.write({ t: "notice", notice });
      },
      arrived: (arrival) => {
        this.write({ t: "arrival", arrival });
      },
      confirmClone: (url, destination) =>
        this.ask({
          message: "Clone this repository?",
          detail: `From ${url}\nInto ${destination}\n\nIt is cloned with your own git credentials. An agent started in a repo reads that repo's instruction files.`,
          confirm: "Clone"
        })
    };
  }

  public async run(input: NodeJS.ReadableStream): Promise<void> {
    this.write({ t: "hello", version: VERSION, protocol: PROTOCOL });
    process.env["PATH"] = await shellPath(); // Agents and git are started with this process's environment, so from here on they are looked for where the user's own shell would find them.
    await sweep(defaultDev()); // Before any run can make a worktree of its own.
    this.start();
    this.changed();
    for await (const text of createInterface({ input })) {
      this.accept(text);
    }
    this.ended = true;
    this.stopping.abort();
    await this.session?.stop();
  }

  private write(line: DeskLine): void {
    // Once the window has stopped listening there is nobody to tell, and writing to a pipe it has closed would end the desk before its agents are stopped.
    if (!this.ended) {
      this.output.write(`${JSON.stringify(line)}\n`);
    }
  }

  private view(): View {
    return this.session === null ? { kind: "setup", presets: PRESETS } : this.session.view();
  }

  /** Several changes in one turn of the event loop are drawn once. */
  private changed(): void {
    if (!this.viewQueued) {
      this.viewQueued = true;
      setImmediate(() => {
        this.viewQueued = false;
        this.write({ t: "view", view: this.view() });
      });
    }
  }

  /** Put a question to the user and wait for the window's answer. */
  private ask(question: Question): Promise<boolean> {
    return new Promise((resolve) => {
      this.asks += 1;
      this.asked.set(this.asks, resolve);
      this.write({ t: "ask", id: this.asks, question });
    });
  }

  /** Start following the hub as whoever has joined from this machine, if anyone has. */
  private start(): void {
    const client = loadClient(this.home, http, () => Date.now() / 1000);
    if (client !== null) {
      this.session = new Session(client, defaultDev(), this.hooks);
      this.session.attend(this.attentive);
      this.session.start();
    }
  }

  /** Do what the window asked, and say that it was done. Only three answer with more: the setup check with its list, the permission test with its row, and a search with what it found. */
  private async handle(command: Command): Promise<Extract<Outcome, { readonly ok: true }>> {
    if (command.do === "doctor") {
      const checks = await runChecks(this.home, defaultDev(), this.stopping.signal);
      return { ok: true, data: this.session === null ? checks.filter((check) => WITHOUT_IDENTITY.has(check.id)) : checks }; // Before anyone has joined, nothing that needs an identity is worth showing.
    }
    if (command.do === "saveAzureToken") {
      saveToken(this.home, command.token); // Before anyone has joined too: it is for this machine, not an identity on the hub.
      return { ok: true };
    }
    if (command.do === "join") {
      if (this.session === null) {
        await join(this.home, command.hub.trim(), command.name.trim(), command.token.trim(), command.agent, http);
        this.start();
        this.changed();
      }
      return { ok: true };
    }
    if (this.session === null) {
      throw new PlayerTwoError("join a hub first");
    }
    if (command.do === "search") {
      return { ok: true, found: await this.session.search(command.q) };
    }
    if (command.do === "testPermissions") {
      return { ok: true, data: [await this.session.testPermissions(command.agent)] };
    }
    await this.session.handle(command);
    return { ok: true };
  }

  private accept(text: string): void {
    const line = readLine(windowLineSchema, text);
    if (line === null) {
      this.write({ t: "notice", notice: { title: "the desk ignored a line it could not read", body: text.slice(0, 200), severity: "error" } });
      return;
    }
    switch (line.t) {
      case "command":
        // Not awaited: a command may wait on the user, and the lines that carry their answer come in behind it.
        this.handle(line.command).then(
          (outcome) => {
            this.write({ t: "reply", id: line.id, outcome });
          },
          (error: unknown) => {
            this.write({ t: "reply", id: line.id, outcome: { ok: false, problem: problemOf(error) } });
          }
        );
        break;
      case "answer":
        this.asked.get(line.id)?.(line.ok);
        this.asked.delete(line.id);
        break;
      case "attend":
        this.attentive = line.attentive;
        this.session?.attend(line.attentive);
        break;
    }
  }
}

/** Run the desk until `input` ends: say hello, show the join form or the chats, do what the window's lines ask, and at the end stop the agents and tell the chat. */
export async function runDesk(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  await new Desk(output).run(input);
}
