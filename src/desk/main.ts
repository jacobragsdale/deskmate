/** The desk as a program: one person's session with no window. It reads the window's lines on one stream, writes its own on another, and opens nothing else. */

import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import type { Writable } from "node:stream";

import { z } from "zod";

import { problemOf } from "../core/text.ts";
import { VERSION } from "../core/version.ts";
import { PROTOCOL } from "../core/wire.ts";
import { commandSchema, readLine, windowLineSchema } from "../shared/ipc.ts";
import type { Command, DeskLine, Outcome, Question, View } from "../shared/ipc.ts";
import { PRESETS } from "./agents/presets.ts";
import { saveToken } from "./azure.ts";
import { defaultDev, defaultHome, http, join, loadClient, PlayerTwoError } from "./client.ts";
import { runChecks, WITHOUT_IDENTITY } from "./doctor.ts";
import { Session } from "./session.ts";
import type { Hooks } from "./session.ts";
import { joinPaths, shellPath } from "./shellEnv.ts";
import { sweep } from "./worktree.ts";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const; // What asks a process to end: a terminal's Ctrl-C, its closing, and kill.

// A command line whose command the desk cannot read, as one from a newer window's would be: enough of it to give the one reply it is owed.
const unreadCommandSchema = z.object({ t: z.literal("command"), id: z.int(), command: z.unknown().optional() });

class Desk {
  private readonly home = defaultHome();
  private readonly asked = new Map<number, (ok: boolean) => void>(); // Questions the user has not answered yet, by id.
  private readonly output: Writable;
  private readonly hooks: Hooks;
  private readonly stopping = new AbortController(); // Aborted once the window has gone, ending the agents a setup check still going has started.
  private session: Session | null = null; // Null until someone has joined a hub from this machine.
  private joining: Promise<void> | null = null; // A join with the hub not yet answered, which a second join waits on rather than starting a session of its own.
  private attentive = true; // What the window last said, kept for a session that starts later.
  private viewQueued = false;
  private asks = 0;
  private ended = false;
  private lines: Interface | null = null; // The window's lines, once the desk reads them; closing it ends the desk as the end of its input does.

  constructor(output: Writable) {
    this.output = output;
    // Its output broken, as by a window gone or a write the system cannot take, the desk ends as at the end of its input, its agents stopped, rather than at once on an error nothing
    // handles, which left them running. Nothing more is written: there is nobody to read it.
    output.on("error", () => {
      this.ended = true;
      this.lines?.close();
    });
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
        }),
      confirm: (question) => this.ask(question)
    };
  }

  public async run(input: NodeJS.ReadableStream): Promise<void> {
    this.write({ t: "hello", version: VERSION, protocol: PROTOCOL });
    // Agents and git are started with this process's environment, so from here on they are looked for where the user's own shell would find them, and then where the window that started
    // the desk would: a login shell may set PATH afresh, as Debian's /etc/profile does, and the player-two command an agent's MCP server is started as can be on the window's alone.
    process.env["PATH"] = joinPaths(await shellPath(), process.env["PATH"] ?? "");
    await sweep(defaultDev()); // Before any run can make a worktree of its own.
    this.start();
    this.changed();
    const lines = createInterface({ input });
    this.lines = lines;
    if (this.ended) {
      lines.close(); // The output broke before the desk began to read.
    }
    // A signal ends the desk as the end of its input does, its agents stopped and the chat told, where Node's own handling of one ends the process at once and leaves the agents,
    // each in a process group of its own, running on. Before this nothing has started an agent.
    const end = (): void => {
      lines.close();
    };
    for (const signal of SIGNALS) {
      process.once(signal, end);
    }
    try {
      for await (const text of lines) {
        this.accept(text);
      }
    } finally {
      for (const signal of SIGNALS) {
        process.off(signal, end);
      }
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
        this.draw();
      });
    }
  }

  /**
   * Write the view once the window has read the last: one is the whole picture, so those a busy chat changes to meanwhile are drawn as one, as it is then, where each was queued
   * behind the others, a few megabytes apiece in a chat with long messages, until the desk ran out of memory or the system refused the write.
   */
  private draw(): void {
    if (this.output.writableNeedDrain && !this.ended) {
      this.output.once("drain", () => {
        this.draw();
      });
      return;
    }
    this.viewQueued = false;
    this.write({ t: "view", view: this.view() });
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

  /**
   * Do what the window asked, and say that it was done. Only five answer with more: the setup check with its list, the permission test with its row, a search with what it found, the form
   * of a pull request, and a channel's workflow files with what each holds.
   */
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
        // Set before anything is awaited, so that a join sent twice in one write starts one session, and the desk's end stops the only one there is.
        this.joining ??= join(this.home, command.hub.trim(), command.name.trim(), command.token.trim(), command.agent, http)
          .then(() => {
            this.start();
            this.changed();
          })
          .finally(() => {
            this.joining = null;
          });
        await this.joining;
      }
      return { ok: true };
    }
    if (this.session === null) {
      throw new PlayerTwoError("join a hub first");
    }
    if (command.do === "search") {
      return { ok: true, found: await this.session.search(command.q) };
    }
    if (command.do === "pullForm") {
      return { ok: true, form: await this.session.pullForm(command.from) };
    }
    if (command.do === "testPermissions") {
      return { ok: true, data: [await this.session.testPermissions(command.agent)] };
    }
    if (command.do === "workflowFiles") {
      return { ok: true, workflowFiles: this.session.workflowFiles(command.chat) };
    }
    await this.session.handle(command);
    return { ok: true };
  }

  private accept(text: string): void {
    const line = readLine(windowLineSchema, text);
    if (line === null) {
      // Every command gets exactly one reply, one the desk cannot read too, so that the window is not left waiting for it.
      const unread = readLine(unreadCommandSchema, text);
      if (unread !== null) {
        const read = commandSchema.safeParse(unread.command);
        this.write({ t: "reply", id: unread.id, outcome: { ok: false, problem: `the desk cannot do that: ${read.success ? "the line holds more than a command" : problemOf(read.error)}` } });
        return;
      }
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
export async function runDesk(input: NodeJS.ReadableStream, output: Writable): Promise<void> {
  await new Desk(output).run(input);
}
