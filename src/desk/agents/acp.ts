/**
 * An agent spoken to over the Agent Client Protocol: JSON-RPC on the agent's standard input and output, with the desk as the client.
 * Its program is started in the checkout with the PATH the desk resolved at start-up, in a process group of its own, and the whole group is killed on every way out, as a one-shot command's is.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

import { head } from "../../core/text.ts";
import { VERSION } from "../../core/version.ts";
import { commandLineOf } from "../../core/wire.ts";
import type { Agent } from "../../core/wire.ts";
import type { ActivityItem } from "../../shared/ipc.ts";
import { AgentCancelledError, PlayerTwoError } from "../client.ts";
import { decide } from "../permissions.ts";
import type { Action, PermissionMode } from "../permissions.ts";
import { AGENT_TIMEOUT } from "./oneshot.ts";
import { signInFor } from "./presets.ts";
import type { AgentRunner, RunHandlers } from "./runner.ts";

const AUTH_REQUIRED = -32000; // The JSON-RPC error code an ACP agent answers with when it needs signing in first.
const SAID = 500; // Characters of what the agent last wrote on standard error that a failure quotes.
const GOING = 1; // Seconds to wait, once the connection has closed, for the agent's process to say how it ended.
const STOP_GRACE = 2; // Seconds a stopped agent has to end its turn before it is killed.
const DETAIL = 8_000; // Characters of a tool call's input an ask shows.
const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
// Player Two's own MCP server, attached to every session: found on the PATH by name, as the `player-two` an agent is told about in its prompt is,
// and without --allow-send, so the agent can read and search the chat as the user and send nothing.
const MCP_SERVER: acp.McpServerStdio = { name: "player-two", command: "player-two", args: ["mcp"], env: [] };

// What the agent answers is parsed for the parts used here; anything more it says is passed over.
const initializedSchema = z.object({ protocolVersion: z.number(), authMethods: z.array(z.object({ id: z.string(), type: z.string().optional(), args: z.array(z.string()).optional() })).default([]) });
const sessionSchema = z.object({ sessionId: z.string() });
const promptedSchema = z.object({ stopReason: z.string() });

type Initialized = z.infer<typeof initializedSchema>;

/** What one prompt turn is doing: the mode and handlers it runs with, what the agent has said so far, and its tool calls as items. */
interface Turn {
  readonly mode: PermissionMode;
  readonly handlers: RunHandlers;
  readonly cancel: AbortSignal; // The run's: a stop ends any wait for the owner's answer.
  readonly clock: Clock; // The run's time limit, which waiting for the owner does not count against.
  readonly tools: Map<string, ActivityItem>;
  readonly kinds: Map<string, Action>; // Each tool call's kind, as the agent first said it, for a permission request that leaves it out.
  readonly allowed: Set<Action>; // Kinds of action the owner allowed for this run. Never kept past it.
  text: string;
}

/** The kind of action a tool call is, as `decide` reads it. A kind ACP adds later, switching the agent's own mode among them, is `other`. */
function actionOf(kind: acp.ToolKind | null | undefined): Action | null {
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

/** What an ask shows the owner beyond its title: the change to each file, or else what the agent passed the tool, at most DETAIL characters. */
function detailOf(call: acp.ToolCallUpdate): string {
  const diffs = (call.content ?? []).flatMap((each) => (each.type === "diff" ? [`${each.path}\n${each.newText}`] : []));
  const detail = diffs.length > 0 ? diffs.join("\n\n") : call.rawInput === undefined ? "" : JSON.stringify(call.rawInput, null, 1);
  return head(detail, DETAIL);
}

/**
 * The agent's option that carries out a decision. Allowing takes only an option that allows once: one that allows always would outlast the run, and the run's own memory is the desk's.
 * Refusing takes one that rejects, once or always. An agent that offers none that matches is refused; one that offers no way to refuse is told the request was cancelled, which allows nothing.
 */
function optionFor(options: readonly acp.PermissionOption[], decision: "allow" | "refuse"): acp.RequestPermissionResponse {
  const option =
    decision === "allow" ? options.find((each) => each.kind === "allow_once") : (options.find((each) => each.kind === "reject_once") ?? options.find((each) => each.kind === "reject_always"));
  if (option !== undefined) {
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return decision === "allow" ? optionFor(options, "refuse") : CANCELLED;
}

/** Resolves once `signal` is aborted. */
function aborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve("aborted");
      },
      { once: true }
    );
  });
}

/** A tool call as the owner's feed shows it, until P3-D2 names things as a person would: the agent's own title, and whether it is going, done or failed. */
function toolItem(update: acp.ToolCallUpdate, before: ActivityItem | undefined): ActivityItem {
  const status = update.status === "completed" ? "done" : update.status === "failed" ? "failed" : (before?.status ?? "running");
  const kind = update.kind ?? null;
  return {
    id: update.toolCallId,
    run: "",
    kind: "tool",
    title: update.title ?? before?.title ?? "",
    outcome: status === "running" ? "" : status,
    status,
    quiet: kind === null ? (before?.quiet ?? false) : kind === "read" || kind === "search" || kind === "think",
    detail: ""
  };
}

/** The agent's standard output as the web stream the SDK reads. Node's own `Readable.toWeb` gives a stream whose type is Node's, not the one the SDK names. */
function readable(output: Readable): ReadableStream<Uint8Array> {
  let done = false; // Ended, failed, or no longer read: the SDK cancels it when the connection closes.
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      output.on("data", (chunk: Buffer) => {
        if (!done) {
          controller.enqueue(chunk);
        }
      });
      output.on("end", () => {
        if (!done) {
          done = true;
          controller.close();
        }
      });
      output.on("error", (error) => {
        if (!done) {
          done = true;
          controller.error(error);
        }
      });
    },
    cancel: () => {
      done = true;
    }
  });
}

/** A run's time limit, which stands still while the owner is asked: `expire` is called once the agent has had `seconds` of its own. */
class Clock {
  private readonly expire: () => void;
  private left: number; // Milliseconds.
  private since = Date.now();
  private waiting = 0; // Asks the owner has not answered yet.
  private timer: NodeJS.Timeout | undefined;

  constructor(seconds: number, expire: () => void) {
    this.expire = expire;
    this.left = seconds * 1000;
    this.timer = setTimeout(expire, this.left);
  }

  /** The owner is asked: stop counting until every ask is answered. */
  public pause(): void {
    this.waiting += 1;
    if (this.waiting === 1) {
      clearTimeout(this.timer);
      this.left -= Date.now() - this.since;
    }
  }

  public resume(): void {
    this.waiting -= 1;
    if (this.waiting === 0) {
      this.since = Date.now();
      this.timer = setTimeout(this.expire, this.left);
    }
  }

  public stop(): void {
    clearTimeout(this.timer);
    this.waiting = -1; // Never counts again.
  }
}

/** One agent process and the ACP session open in it. */
class Conversation {
  public turn: Turn | null = null;
  public readonly gone: Promise<void>; // Settles once the process has exited, or never started.
  private readonly agent: Agent;
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly connection: acp.ClientConnection;
  private readonly failed: Promise<never>; // Rejects, with why, when the process goes or never starts.
  private said = ""; // The end of what the agent has written on standard error.
  private sessionId = "";

  constructor(agent: Agent, cwd: string) {
    this.agent = agent;
    this.child = spawn(agent.command, agent.args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stdin.on("error", () => undefined); // Writing to an agent that has gone: the process's own end says why.
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.said = (this.said + chunk).slice(-SAID);
    });
    this.gone = new Promise((resolve) => {
      this.child.once("exit", () => {
        resolve();
      });
      this.child.once("error", () => {
        resolve();
      });
    });
    this.failed = new Promise((_resolve, reject) => {
      this.child.once("error", (error) => {
        reject(new PlayerTwoError(`could not start ${agent.label}'s program ${JSON.stringify(agent.command)}: ${error.message}. Check it on the Setup page`));
      });
      this.child.once("exit", (code, signal) => {
        const why = this.said.trim() === "" ? "" : `: ${this.said.trim()}`;
        reject(new PlayerTwoError(`${agent.label} ended ${signal === null ? `with status ${String(code)}` : `on ${signal}`}${why}`));
      });
    });
    this.failed.catch(() => undefined); // Read only by what is waiting on the agent; at any other time the process going is not a failure of anything.
    this.connection = acp
      .client({ name: "player-two" })
      .onRequest("session/request_permission", (context) => this.permit(context.params, context.signal))
      .onNotification("session/update", (context) => {
        this.update(context.params);
      })
      .connect(acp.ndJsonStream(Writable.toWeb(this.child.stdin), readable(this.child.stdout)));
  }

  /** Agree a protocol, sign in if the agent says it must, and open a session in `cwd` with Player Two's MCP server attached. */
  public async open(cwd: string): Promise<void> {
    const initialized = initializedSchema.parse(
      await this.ask(
        this.connection.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "player-two", title: "Player Two", version: VERSION } })
      )
    );
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new PlayerTwoError(`${this.agent.label} speaks version ${String(initialized.protocolVersion)} of ACP, and Player Two version ${String(acp.PROTOCOL_VERSION)}`);
    }
    const session = { cwd, mcpServers: [MCP_SERVER] };
    let opened: unknown;
    try {
      opened = await this.ask(this.connection.agent.request("session/new", session));
    } catch (error) {
      if (!(error instanceof acp.RequestError && error.code === AUTH_REQUIRED)) {
        throw error;
      }
      opened = await this.signIn(initialized, () => this.ask(this.connection.agent.request("session/new", session)));
    }
    this.sessionId = sessionSchema.parse(opened).sessionId;
  }

  /** Send one prompt and resolve with the agent's message once the turn ends. */
  public async prompt(text: string, turn: Turn): Promise<string> {
    this.turn = turn;
    try {
      const { stopReason } = promptedSchema.parse(await this.ask(this.connection.agent.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] })));
      if (stopReason === "cancelled") {
        throw new AgentCancelledError("the agent was stopped");
      }
      if (stopReason !== "end_turn") {
        throw new PlayerTwoError(`${this.agent.label} stopped before it finished: ${stopReason}`);
      }
      return turn.text.trim();
    } finally {
      this.turn = null;
    }
  }

  /** Ask the agent to stop its turn. One that has no session yet has no turn to stop, and is ended at once. */
  public cancel(): void {
    if (this.sessionId === "") {
      this.end().catch(() => undefined); // It cannot fail: it waits for the process to go.
      return;
    }
    this.connection.agent.notify("session/cancel", { sessionId: this.sessionId }).catch(() => undefined); // An agent that has gone needs no telling.
  }

  /** Kill the agent and everything it started, and wait until it has gone. */
  public async end(): Promise<void> {
    this.connection.close();
    if (this.child.pid !== undefined) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        // No such group: the agent has already gone.
      }
    }
    await this.gone;
  }

  /** Wait for an answer from the agent, or for it to go, whichever is first. When the connection closes under a request, the agent is going, and how it went says why. */
  private async ask<T>(asked: Promise<T>): Promise<T> {
    try {
      return await Promise.race([asked, this.failed]);
    } catch (error) {
      if (!(error instanceof acp.RequestError) && !(error instanceof PlayerTwoError)) {
        await Promise.race([this.failed, delay(GOING * 1000)]);
      }
      throw error;
    }
  }

  /**
   * The agent says it needs signing in: sign in by its first method that the agent carries out itself, and try again. One that only a person at a terminal can do,
   * or a sign-in that fails, ends with the command that signs in: the one the agent names for a terminal, or the one its maker documents.
   */
  private async signIn<T>(initialized: Initialized, again: () => Promise<T>): Promise<T> {
    const byTerminal = initialized.authMethods.find((method) => method.type === "terminal");
    const how = byTerminal === undefined ? signInFor(this.agent) : `\`${commandLineOf({ command: this.agent.command, args: byTerminal.args ?? [] })}\``;
    const method = initialized.authMethods.find((each) => each.type === undefined || each.type === "agent");
    try {
      if (method === undefined) {
        throw new PlayerTwoError("no way to sign in without a person");
      }
      await this.ask(this.connection.agent.request("authenticate", { methodId: method.id }));
      return await again();
    } catch (error) {
      throw new PlayerTwoError(`${this.agent.label} is not signed in. Sign in once in a terminal where your repos are, inside WSL on Windows, with ${how}, then try again`, { cause: error });
    }
  }

  /**
   * The agent asks before it acts: answer by the run's mode, at once when it allows or refuses, and when it asks, with the owner's answer. "Allow for this run" allows that kind of action
   * without asking until the run ends. A request outside a turn, or one still waiting when the run is stopped or the agent takes it back, is answered as cancelled.
   */
  private async permit(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const turn = this.turn;
    if (turn === null || request.sessionId !== this.sessionId) {
      return CANCELLED;
    }
    const call = request.toolCall;
    const action = actionOf(call.kind) ?? turn.kinds.get(call.toolCallId) ?? "other";
    const ask = { action, title: call.title ?? turn.tools.get(call.toolCallId)?.title ?? action, detail: detailOf(call) };
    const item = (outcome: string, status: ActivityItem["status"]): void => {
      turn.handlers.activity({ id: `permission ${call.toolCallId}`, run: "", kind: "permission", title: ask.title, outcome, status, quiet: false, detail: ask.detail });
    };
    let decision = turn.allowed.has(action) ? "allow" : decide(turn.mode, action);
    if (decision === "ask") {
      item("", "running");
      turn.clock.pause();
      const answer = await Promise.race([turn.handlers.permission(ask), aborted(turn.cancel), aborted(signal)]).finally(() => {
        turn.clock.resume();
      });
      if (answer === "aborted") {
        item("cancelled", "done");
        return CANCELLED;
      }
      if (answer === "allow-run") {
        turn.allowed.add(action);
      }
      decision = answer === "refuse" ? "refuse" : "allow";
    }
    item(decision === "allow" ? "allowed" : "refused", "done");
    return optionFor(request.options, decision);
  }

  /** What the agent streams while it works: its message, which is the answer, and its tool calls, for the owner's feed. */
  private update({ sessionId, update }: acp.SessionNotification): void {
    const turn = this.turn;
    if (turn === null || sessionId !== this.sessionId) {
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      turn.text += update.content.text;
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const action = actionOf(update.kind);
      if (action !== null && !turn.kinds.has(update.toolCallId)) {
        turn.kinds.set(update.toolCallId, action);
      }
      const item = toolItem(update, turn.tools.get(update.toolCallId));
      turn.tools.set(item.id, item);
      turn.handlers.activity(item);
    }
  }
}

/** An agent over ACP as an agent runner: a process and a session for each run, ended when the run ends. */
export function acpRunner(agent: Agent, limit = AGENT_TIMEOUT): AgentRunner {
  return {
    restrictable: true,
    cannotHonour: () => "",
    run: async (prompt, cwd, mode, handlers, cancel) => {
      const conversation = new Conversation(agent, cwd);
      const end = (): void => {
        conversation.end().catch(() => undefined); // It cannot fail: it waits for the process to go.
      };
      const late = new AbortController();
      const clock = new Clock(limit, () => {
        late.abort();
        end();
      });
      // A stop asks the agent to end its turn, and ends the agent itself if it has not within STOP_GRACE.
      let grace: NodeJS.Timeout | undefined;
      const onCancel = (): void => {
        conversation.cancel();
        grace = setTimeout(end, STOP_GRACE * 1000);
      };
      cancel.addEventListener("abort", onCancel, { once: true });
      if (cancel.aborted) {
        onCancel();
      }
      try {
        await conversation.open(cwd);
        return await conversation.prompt(prompt, { mode, handlers, cancel, clock, tools: new Map(), kinds: new Map(), allowed: new Set(), text: "" });
      } catch (error) {
        if (cancel.aborted) {
          throw new AgentCancelledError("the agent was stopped");
        }
        if (late.signal.aborted) {
          throw new PlayerTwoError(`the agent did not finish within ${String(limit)} seconds`);
        }
        throw error;
      } finally {
        clock.stop();
        clearTimeout(grace);
        cancel.removeEventListener("abort", onCancel);
        await conversation.end();
      }
    }
  };
}
