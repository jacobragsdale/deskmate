/**
 * What an agent does, as its owner's activity feed shows it: ACP's updates turned into items that read as verb, object and outcome, each message, tool call and plan one item that changes in place
 * as the agent goes on; and the two items every run has, that it started and how it ended. Nothing here leaves the owner's machine.
 */

import { isAbsolute, relative } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

import type { Summary } from "../../core/kinds.ts";
import { head, oneLine } from "../../core/text.ts";
import type { ActivityItem } from "../../shared/ipc.ts";
import type { Action, PermissionMode } from "../permissions.ts";

export const DETAIL = 8_000; // Characters of an item's detail, and of an ask's.
const TITLE = 120; // Characters of a message's first words as its title.
export const LINE = 200; // Characters of a tool call's title, and of an ask's, on one line.

// What a tool call did, as a person would put it, by its kind; a kind with no verb here is named by the agent's own title.
const VERBS: Partial<Record<Action, string>> = { read: "Read", edit: "Edited", delete: "Deleted", move: "Moved", search: "Searched for", execute: "Ran", fetch: "Fetched" };

// The parts of a tool call's raw input and output that name what it did, where an agent gives them. Anything else about them is passed over.
const commandSchema = z.object({ command: z.union([z.string(), z.array(z.string())]) });
const querySchema = z.object({ query: z.string() }).or(z.object({ pattern: z.string() }).transform(({ pattern }) => ({ query: pattern })));
const urlSchema = z.object({ url: z.string() });
const exitSchema = z.object({ exitCode: z.int() }).or(z.object({ exit_code: z.int() }).transform(({ exit_code }) => ({ exitCode: exit_code })));

/** The kind of action a tool call is, as `decide` reads it. A kind ACP adds later, switching the agent's own mode among them, is `other`. */
export function actionOf(kind: acp.ToolKind | null | undefined): Action | null {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
    case "think":
    case "fetch":
    case "other":
      return kind;
    case "switch_mode":
      return "other";
    case null:
    case undefined:
      return null;
  }
}

/** What the agent is doing while it does an action, in the coarse words the chat is told. */
export function summaryOf(action: Action | null): Summary {
  switch (action) {
    case "read":
    case "search":
    case "fetch":
      return "reading";
    case "edit":
    case "delete":
    case "move":
      return "editing files";
    case "execute":
      return "running a command";
    case "think":
    case "other":
    case null:
      return "thinking";
  }
}

function lines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

/**
 * A file's change as lines taken out and put in, under the file's name, and how many of each.
 * ponytail: one stretch, from the first line that differs to the last; two changes far apart show everything between them. Diff properly if that reads badly.
 */
export function diffOf(path: string, oldText: string | null | undefined, newText: string): { readonly text: string; readonly added: number; readonly removed: number } {
  const before = lines(oldText ?? "");
  const after = lines(newText);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end += 1;
  }
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const header = oldText === null || oldText === undefined ? [`+++ ${path} (new)`] : [`--- ${path}`, `+++ ${path}`, `@@ line ${String(start + 1)} @@`];
  return { text: [...header, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n"), added: added.length, removed: removed.length };
}

/** A tool call as the agent has described it so far: each update says only what changed. */
interface Call {
  kind: acp.ToolKind | null;
  title: string;
  status: acp.ToolCallStatus | null;
  content: readonly acp.ToolCallContent[];
  locations: readonly acp.ToolCallLocation[];
  rawInput: unknown;
  rawOutput: unknown;
}

/** The first line of the command a tool call runs, as its raw input names it; null when it does not. */
function commandOf(rawInput: unknown): string | null {
  const given = commandSchema.safeParse(rawInput);
  const command = given.success ? [given.data.command].flat().join(" ") : "";
  const first = command.trim().split("\n")[0] ?? "";
  return first === "" ? null : oneLine(first, TITLE);
}

const NO_CALL: Call = { kind: null, title: "", status: null, content: [], locations: [], rawInput: undefined, rawOutput: undefined };

/** A tool call as described before, with what an update says of it now. */
function merged(before: Call, update: acp.ToolCallUpdate): Call {
  return {
    kind: update.kind ?? before.kind,
    title: update.title ?? before.title,
    status: update.status ?? before.status,
    content: update.content ?? before.content,
    locations: update.locations ?? before.locations,
    rawInput: update.rawInput ?? before.rawInput,
    rawOutput: update.rawOutput ?? before.rawOutput
  };
}

/** One run's feed: the agent's updates in, its items out to `report`, each with what the agent is doing as of it. */
export class Feed {
  private readonly cwd: string;
  private readonly report: (item: ActivityItem, doing: Summary) => void;
  private readonly calls = new Map<string, Call>(); // By the tool call's id.
  private said: { id: string; readonly kind: "message" | "thought"; readonly messageId: string | null; text: string } | null = null; // The message or thought being streamed, until something else comes.
  private readonly messages: { readonly text: string }[] = []; // Every message of the agent's so far, each whole: its answer.
  private count = 0; // Messages and thoughts so far, for each one's id.

  constructor(cwd: string, report: (item: ActivityItem, doing: Summary) => void) {
    this.cwd = cwd;
    this.report = report;
  }

  /** The kind a tool call is, as the agent first said it: for a permission request that leaves it out. */
  public kindOf(toolCallId: string): acp.ToolKind | null {
    return this.calls.get(toolCallId)?.kind ?? null;
  }

  /** The agent's own title for a tool call it has announced. */
  public titleOf(toolCallId: string): string | undefined {
    return this.calls.get(toolCallId)?.title;
  }

  /** What a request to do something shows beyond its title: the change to each file, or else what the agent passed the tool, at most DETAIL characters. */
  public detailOf(call: acp.ToolCallUpdate): string {
    const diffs = this.diffs(call.content ?? []);
    return head(diffs.length > 0 ? diffs.map((diff) => diff.text).join("\n\n") : call.rawInput === undefined ? "" : JSON.stringify(call.rawInput, null, 1), DETAIL);
  }

  /** Every file a request to act names, as it says it or as its tool call was announced: each location, and the file of each change it carries. */
  public pathsOf(call: acp.ToolCallUpdate): string[] {
    const announced = this.calls.get(call.toolCallId) ?? NO_CALL;
    const content = [...(call.content ?? []), ...announced.content];
    return [...(call.locations ?? []), ...announced.locations].map((location) => location.path).concat(content.flatMap((each) => (each.type === "diff" ? [each.path] : [])));
  }

  /** What the agent has said: every one of its messages, narration and all, a blank line between each. */
  public answer(): string {
    return this.messages
      .map((message) => message.text.trim())
      .filter((text) => text !== "")
      .join("\n\n");
  }

  /** Take one of the agent's updates. Those that are not a step of its work, such as the commands it offers or the tokens it has used, change nothing. */
  public update(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type === "text") {
        this.chunk(update.sessionUpdate === "agent_message_chunk" ? "message" : "thought", update.content.text, update.messageId ?? null);
      }
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.said = null;
      this.call(update);
    } else if (update.sessionUpdate === "plan") {
      this.said = null;
      this.plan(update.entries);
    }
  }

  /** A piece of a message or a thought: the one being streamed grows, unless it is of another kind or the agent says it is another message. */
  private chunk(kind: "message" | "thought", text: string, messageId: string | null): void {
    const same = this.said?.kind === kind && (messageId === null || this.said.messageId === messageId);
    if (!same || this.said === null) {
      this.count += 1;
      this.said = { id: `${kind} ${String(this.count)}`, kind, messageId, text: "" };
      if (kind === "message") {
        this.messages.push(this.said);
      }
    }
    this.said.text += text;
    const { id, text: said } = this.said;
    this.report({ id, run: "", kind, title: oneLine(said, TITLE), outcome: "", status: "done", quiet: kind === "thought", loud: false, detail: head(said, DETAIL) }, "thinking");
  }

  private call(update: acp.ToolCallUpdate): void {
    const call = merged(this.calls.get(update.toolCallId) ?? NO_CALL, update);
    this.calls.set(update.toolCallId, call);
    const action = actionOf(call.kind);
    const diffs = this.diffs(call.content);
    const object = this.objectOf(action, call, diffs[0]?.path ?? call.locations[0]?.path);
    const verb = action === null ? undefined : VERBS[action];
    const status = call.status === "completed" ? "done" : call.status === "failed" ? "failed" : "running";
    this.report(
      {
        id: update.toolCallId,
        run: "",
        kind: "tool",
        title: oneLine(verb === undefined || object === null ? call.title : `${verb} ${object}`, LINE), // One it cannot name is called what the agent called it, rather than a guess.
        outcome: this.outcomeOf(status, diffs, call.rawOutput),
        status,
        quiet: action === "read" || action === "search" || action === "think",
        loud: action === "edit" || action === "delete" || action === "move" || action === "execute",
        detail: this.detail(call, diffs)
      },
      summaryOf(action)
    );
  }

  private plan(entries: readonly acp.PlanEntry[]): void {
    const done = entries.filter((entry) => entry.status === "completed").length;
    const marks = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
    this.report(
      {
        id: "plan",
        run: "",
        kind: "plan",
        title: `Planned ${String(entries.length)} ${entries.length === 1 ? "step" : "steps"}`,
        outcome: `${String(done)} of ${String(entries.length)} done`,
        status: done === entries.length ? "done" : "running",
        quiet: false,
        loud: false,
        detail: head(entries.map((entry) => `${marks[entry.status]} ${entry.content}`).join("\n"), DETAIL)
      },
      "thinking"
    );
  }

  /** A path as the owner would name it: relative to the checkout when it is inside it. */
  private named(path: string): string {
    const inside = relative(this.cwd, path);
    return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? path : inside;
  }

  private diffs(content: readonly acp.ToolCallContent[]): { readonly path: string; readonly text: string; readonly added: number; readonly removed: number }[] {
    return content.flatMap((each) => (each.type === "diff" ? [{ path: each.path, ...diffOf(this.named(each.path), each.oldText, each.newText) }] : []));
  }

  /** What a tool call did it to, named as a person would: a file by its path, a command by its first line, a search by what it looked for, a fetch by its address. Null when the agent did not say. */
  private objectOf(action: Action | null, call: Call, path: string | undefined): string | null {
    switch (action) {
      case "read":
      case "edit":
      case "delete":
      case "move":
        return path === undefined ? null : this.named(path);
      case "execute":
        return commandOf(call.rawInput);
      case "search": {
        const given = querySchema.safeParse(call.rawInput);
        return given.success ? oneLine(given.data.query, TITLE) : null;
      }
      case "fetch": {
        const given = urlSchema.safeParse(call.rawInput);
        return given.success ? oneLine(given.data.url, TITLE) : null;
      }
      case "think":
      case "other":
      case null:
        return null;
    }
  }

  /** How a tool call went: "" while it is going, and once done, lines put in and taken out of the files it changed, or the status a command exited with. */
  private outcomeOf(status: ActivityItem["status"], diffs: readonly { readonly added: number; readonly removed: number }[], rawOutput: unknown): string {
    if (status !== "done") {
      return status === "failed" ? "failed" : "";
    }
    if (diffs.length > 0) {
      return `+${String(diffs.reduce((sum, diff) => sum + diff.added, 0))} −${String(diffs.reduce((sum, diff) => sum + diff.removed, 0))}`;
    }
    const exit = exitSchema.safeParse(rawOutput);
    return exit.success ? `exit ${String(exit.data.exitCode)}` : "done";
  }

  /** What opening an item shows: the change to each file, or else what the agent passed the tool, what it said of it and what came of it. */
  private detail(call: Call, diffs: readonly { readonly text: string }[]): string {
    const said = call.content.flatMap((each) => (each.type === "content" && each.content.type === "text" ? [each.content.text] : []));
    const parts =
      diffs.length > 0
        ? diffs.map((diff) => diff.text)
        : [
            ...(call.rawInput === undefined ? [] : [JSON.stringify(call.rawInput, null, 1)]),
            ...said,
            ...(call.rawOutput === undefined ? [] : [typeof call.rawOutput === "string" ? call.rawOutput : JSON.stringify(call.rawOutput, null, 1)])
          ];
    return head(parts.join("\n\n"), DETAIL);
  }
}

/** The first item of every run: the agent and the mode it was let go at. */
export function startedItem(agent: string, mode: PermissionMode): ActivityItem {
  return { id: "started", run: "", kind: "state", title: `Started ${agent}, ${mode}`, outcome: "", status: "done", quiet: false, loud: false, detail: "" };
}

/** The last item of every run: how it ended, and why when it failed. */
export function endedItem(how: "answered" | "stopped" | "timed out" | "failed", why = ""): ActivityItem {
  const title = { answered: "Answered", stopped: "Stopped", "timed out": "Timed out", failed: "Failed" }[how];
  const failed = how === "timed out" || how === "failed";
  return {
    id: "ended",
    run: "",
    kind: failed ? "error" : "state",
    title,
    outcome: how === "answered" ? "" : how,
    status: failed ? "failed" : "done",
    quiet: false,
    loud: false,
    detail: head(why, DETAIL)
  };
}
