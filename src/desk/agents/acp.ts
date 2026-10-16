/**
 * An agent spoken to over the Agent Client Protocol: JSON-RPC on the agent's standard input and output, with the desk as the client.
 * Its program is started in the checkout with the PATH the desk resolved at start-up, in a process group of its own, and the whole group is killed on every way out, as a one-shot command's is.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

import { oneLine } from "../../core/text.ts";
import { VERSION } from "../../core/version.ts";
import { commandLineOf } from "../../core/wire.ts";
import type { Agent } from "../../core/wire.ts";
import type { Summary } from "../../core/kinds.ts";
import type { ActivityItem } from "../../shared/ipc.ts";
import { ONLY_CHAT_VAR } from "../agentKeys.ts";
import { AgentCancelledError, AgentTimedOutError, PlayerTwoError } from "../client.ts";
import { decide } from "../permissions.ts";
import type { Action, Decision, PermissionMode } from "../permissions.ts";
import { actionOf, Feed, LINE, summaryOf } from "./activity.ts";
import { AGENT_TIMEOUT } from "./oneshot.ts";
import { signInFor } from "./presets.ts";
import type { AgentRunner, FollowUp, Pausable, RunHandlers } from "./runner.ts";

const AUTH_REQUIRED = -32000; // The JSON-RPC error code an ACP agent answers with when it needs signing in first.
const SAID = 500; // Characters of what the agent last wrote on standard error that a failure quotes.
const GOING = 1; // Seconds to wait, once the connection has closed, for the agent's process to say how it ended.
const STOP_GRACE = 2; // Seconds a stopped agent has to end its turn before it is killed.
const IDLE = 30 * 60; // Seconds a finished session is kept for a follow-up.
const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
/**
 * Player Two's own MCP server, attached to every session: found on the PATH by name, as the `player-two` an agent is told about in its prompt is,
 * and without --allow-send, so the agent can read and search the chat as the user and send nothing. It is given the run's `env` as the agent is, so it signs as the agent too.
 * In a run let ask other agents it is started with --job naming the request the run was asked, and then may ask another agent under it, and send nothing else.
 */
function mcpServer(env: Readonly<Record<string, string>>, job: string | undefined): acp.McpServerStdio {
  return { name: "player-two", command: "player-two", args: job === undefined ? ["mcp"] : ["mcp", "--job", job], env: Object.entries(env).map(([name, value]) => ({ name, value })) };
}

// What the agent answers is parsed for the parts used here; anything more it says is passed over.
const initializedSchema = z.object({
  protocolVersion: z.number(),
  agentInfo: z.object({ version: z.string() }).nullish(),
  authMethods: z.array(z.object({ id: z.string(), type: z.string().optional(), args: z.array(z.string()).optional() })).default([])
});
const sessionSchema = z.object({ sessionId: z.string() });
const promptedSchema = z.object({ stopReason: z.string() });

type Initialized = z.infer<typeof initializedSchema>;

/** The agent needs signing in, and Player Two could not do it: `how` is what the user does instead, in words for them, commands between backticks. */
export class SignInNeeded extends PlayerTwoError {
  public readonly how: string;

  constructor(agent: Agent, how: string, options?: ErrorOptions) {
    super(`${agent.label} is not signed in. Sign in once in a terminal where your repos are, inside WSL on Windows, with ${how}, then try again`, options);
    this.how = how;
  }
}

/** What one prompt turn is doing: the mode and handlers it runs with, and its feed, which keeps what the agent has said so far. */
interface Turn {
  readonly mode: PermissionMode;
  readonly handlers: RunHandlers;
  readonly cancel: AbortSignal; // The run's: a stop ends any wait for the owner's answer.
  readonly clock: Clock; // The run's time limit, which waiting for the owner does not count against.
  readonly feed: Feed;
  readonly allowed: Set<Action>; // Kinds of action the owner allowed for this run. Never kept past it.
  readonly folder: string; // The folder the run is in, links followed: below full, it changes no file outside it.
}

const CHANGES: ReadonlySet<Action> = new Set(["edit", "delete", "move"]);

/**
 * Where writing `path`, as an agent in `folder` names it, would land: the nearest part of it that is there, with links followed, and the rest as named. Null when that cannot be said:
 * a ".." in it, which a link before it would take somewhere other than it reads, or a part that is there and cannot be followed, as a link to nothing, which writing creates wherever it points.
 */
function landing(folder: string, path: string): string | null {
  if (path.split("/").includes("..")) {
    return null;
  }
  const rest: string[] = [];
  for (let at = isAbsolute(path) ? path : join(folder, path); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      // Not there, or there and not to be followed, which lstat tells apart.
    }
    try {
      lstatSync(at);
      return null;
    } catch {
      // Not there: it is made in the folder it names, if that is there.
    }
    if (dirname(at) === at) {
      return null;
    }
    rest.unshift(basename(at));
  }
}

/**
 * Whether a run below full may change what a request to change files names, by the rules of its mode: only when it names at least one file and each is inside the run's folder and outside
 * any .git folder, whatever its case, there. A run on a clean copy shares the checkout's .git, whose configuration names commands git runs; and a file outside its folder is the owner's.
 */
function staysIn(folder: string, paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => {
      const landed = landing(folder, path);
      const inside = landed === null ? ".." : relative(folder, landed);
      return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) && !inside.split(sep).some((part) => part.toLowerCase() === ".git");
    })
  );
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

/**
 * What a turn answers a request to act: what the owner allowed for the run, or else what its mode says. Below full, two things are refused whatever the owner allowed, and never put to them,
 * since an "Allow" would lift the run above its mode: switching the agent's own mode, which may then ask about less for the rest of the run; and changing a file that is not in the run's
 * folder, is in a .git there, or is not named at all (see `staysIn`). `paths` are the files the request names.
 */
function decisionOf(turn: Turn, kind: acp.ToolKind | null, action: Action, paths: readonly string[]): Decision {
  if (turn.mode !== "full" && (kind === "switch_mode" || (CHANGES.has(action) && !staysIn(turn.folder, paths)))) {
    return "refuse";
  }
  return turn.allowed.has(action) ? "allow" : decide(turn.mode, action);
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

/** A run's time limit, which stands still while the owner is asked, or while the agent waits on agents it asked: `expire` is called once the agent has had `seconds` of its own. */
class Clock implements Pausable {
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

  /** The owner is asked, or an agent the run asked is at work: stop counting until every such wait is over. */
  public pause(): void {
    if (this.waiting < 0) {
      return; // Stopped: it never counts again.
    }
    this.waiting += 1;
    if (this.waiting === 1) {
      clearTimeout(this.timer);
      this.left -= Date.now() - this.since;
    }
  }

  public resume(): void {
    if (this.waiting <= 0) {
      return; // Stopped, or not paused.
    }
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
  public exited = false;
  public version = ""; // The agent's own version, as it says when the protocol is agreed; "" when it does not.
  private readonly agent: Agent;
  private readonly env: Readonly<Record<string, string>> | undefined; // Added to the agent's environment, and the MCP server's; with none, or one naming the only chat it reads, as under a grant, it has no MCP server.
  private readonly job: string | undefined; // The request a run let ask other agents was asked, which its MCP server is started with.
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly connection: acp.ClientConnection;
  private readonly failed: Promise<never>; // Rejects, with why, when the process goes or never starts.
  private said = ""; // The end of what the agent has written on standard error.
  private sessionId = "";
  private signInHow = ""; // How the user signs in to the agent, as it said when the protocol was agreed: for a turn it refuses because it needs signing in.

  constructor(agent: Agent, cwd: string, env?: Readonly<Record<string, string>>, job?: string) {
    this.agent = agent;
    this.env = env;
    this.job = job;
    this.child = spawn(agent.command, agent.args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stdin.on("error", () => undefined); // Writing to an agent that has gone: the process's own end says why.
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.said = (this.said + chunk).slice(-SAID);
    });
    this.gone = new Promise((resolve) => {
      this.child.once("exit", () => {
        this.exited = true;
        resolve();
      });
      this.child.once("error", () => {
        this.exited = true;
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

  /**
   * Agree a protocol, sign in if the agent says it must, and open a session in `cwd` with Player Two's MCP server attached, unless the run was given no `env`, or one confining it to a chat (see AgentRunner).
   * For the setup check, `looking` opens one with no MCP server and leaves signing in to the user, saying how.
   */
  public async open(cwd: string, looking = false): Promise<void> {
    const initialized = initializedSchema.parse(
      await this.ask(
        this.connection.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "player-two", title: "Player Two", version: VERSION } })
      )
    );
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new PlayerTwoError(`${this.agent.label} speaks version ${String(initialized.protocolVersion)} of ACP, and Player Two version ${String(acp.PROTOCOL_VERSION)}`);
    }
    this.version = initialized.agentInfo?.version ?? "";
    this.signInHow = this.howToSignIn(initialized);
    const session = { cwd, mcpServers: looking || this.env === undefined || ONLY_CHAT_VAR in this.env ? [] : [mcpServer(this.env, this.job)] };
    let opened: unknown;
    try {
      opened = await this.ask(this.connection.agent.request("session/new", session));
    } catch (error) {
      if (!(error instanceof acp.RequestError && error.code === AUTH_REQUIRED)) {
        throw error;
      }
      if (looking) {
        throw new SignInNeeded(this.agent, this.howToSignIn(initialized));
      }
      opened = await this.signIn(initialized, () => this.ask(this.connection.agent.request("session/new", session)));
    }
    this.sessionId = sessionSchema.parse(opened).sessionId;
  }

  /** Send one prompt and resolve with the agent's message once the turn ends. */
  public async prompt(text: string, turn: Turn): Promise<string> {
    this.turn = turn;
    try {
      let prompted: unknown;
      try {
        prompted = await this.ask(this.connection.agent.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }));
      } catch (error) {
        // An agent may say it needs signing in only once a turn starts, as Claude over ACP does once its credentials are gone: the user is told how, as for a session it would not open.
        if (error instanceof acp.RequestError && error.code === AUTH_REQUIRED) {
          throw new SignInNeeded(this.agent, this.signInHow, { cause: error });
        }
        throw error;
      }
      const { stopReason } = promptedSchema.parse(prompted);
      if (stopReason === "cancelled") {
        throw new AgentCancelledError("the agent was stopped");
      }
      if (stopReason !== "end_turn") {
        throw new PlayerTwoError(`${this.agent.label} stopped before it finished: ${stopReason}`);
      }
      return turn.feed.answer();
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
    const method = initialized.authMethods.find((each) => each.type === undefined || each.type === "agent");
    try {
      if (method === undefined) {
        throw new PlayerTwoError("no way to sign in without a person");
      }
      await this.ask(this.connection.agent.request("authenticate", { methodId: method.id }));
      return await again();
    } catch (error) {
      throw new SignInNeeded(this.agent, this.howToSignIn(initialized), { cause: error });
    }
  }

  /** How the user signs in to the agent: the command it names for a terminal, or the one its maker documents. */
  private howToSignIn(initialized: Initialized): string {
    const byTerminal = initialized.authMethods.find((method) => method.type === "terminal");
    return byTerminal === undefined ? signInFor(this.agent) : `\`${commandLineOf({ command: this.agent.command, args: byTerminal.args ?? [] })}\``;
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
    const kind = call.kind ?? turn.feed.kindOf(call.toolCallId);
    const action = actionOf(kind) ?? "other";
    const ask = { action, title: oneLine(call.title ?? turn.feed.titleOf(call.toolCallId) ?? action, LINE), detail: turn.feed.detailOf(call) };
    const item = (outcome: string, status: ActivityItem["status"], doing: Summary): void => {
      turn.handlers.activity({ id: `permission ${call.toolCallId}`, run: "", kind: "permission", title: ask.title, outcome, status, quiet: false, loud: false, detail: ask.detail }, doing);
    };
    let decision = decisionOf(turn, kind, action, turn.feed.pathsOf(call));
    if (decision === "ask") {
      item("", "running", "waiting for approval");
      turn.clock.pause();
      const gone = AbortSignal.any([turn.cancel, signal]);
      const answer = await Promise.race([turn.handlers.permission(ask, gone), aborted(gone)]).finally(() => {
        turn.clock.resume();
      });
      if (answer === "aborted") {
        item("cancelled", "done", "thinking");
        return CANCELLED;
      }
      if (answer === "allow-run") {
        turn.allowed.add(action);
      }
      decision = answer === "refuse" ? "refuse" : "allow";
    }
    item(decision === "allow" ? "allowed" : "refused", "done", decision === "allow" ? summaryOf(action) : "thinking");
    return optionFor(request.options, decision);
  }

  /** What the agent streams while it works: its messages, which are the answer, and every step, for the owner's feed. */
  private update({ sessionId, update }: acp.SessionNotification): void {
    const turn = this.turn;
    if (turn !== null && sessionId === this.sessionId) {
      turn.feed.update(update);
    }
  }
}

/** A session kept open after its run for a follow-up, and the folder it was opened in. */
interface Kept {
  readonly conversation: Conversation;
  readonly cwd: string;
  readonly timer: NodeJS.Timeout;
}

/**
 * For the setup check: start an agent over ACP, agree a protocol, and open a session with no MCP server in an empty folder of its own, all within `seconds`, then end it.
 * Resolves with the agent's version, "" when it does not say; rejects with why not, in the agent's own words where it gave them, and with SignInNeeded when it needs signing in.
 * Aborting `stop`, as a desk that is stopping does, ends the agent at once.
 */
export async function greet(agent: Agent, seconds: number, stop: AbortSignal): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "player-two-check-"));
  const conversation = new Conversation(agent, dir);
  const end = (): void => {
    conversation.end().catch(() => undefined); // It cannot fail: it waits for the process to go.
  };
  stop.addEventListener("abort", end, { once: true });
  if (stop.aborted) {
    end();
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PlayerTwoError(`${agent.label} did not answer within ${String(seconds)} seconds`));
    }, seconds * 1000);
  });
  try {
    await Promise.race([conversation.open(dir, true), late]);
    return conversation.version;
  } finally {
    stop.removeEventListener("abort", end);
    clearTimeout(timer);
    await conversation.end();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An agent over ACP as an agent runner: a process and a session for each run, ended when the run ends; or, for a run that may be followed up, kept open until
 * IDLE seconds pass without a follow-up, a fresh run with the same key takes its place, or the runner is closed.
 */
export function acpRunner(agent: Agent, { limit = AGENT_TIMEOUT, idle = IDLE }: { readonly limit?: number; readonly idle?: number } = {}): AgentRunner {
  const seconds = { limit, idle };
  const kept = new Map<string, Kept>();
  let closed = false;
  const end = (conversation: Conversation): void => {
    conversation.end().catch(() => undefined); // It cannot fail: it waits for the process to go.
  };
  /** The session a follow-up goes on in: one kept under its key, in the same folder, whose agent is still there. It is taken out while it is in use. */
  const take = (followUp: FollowUp | undefined, cwd: string): Conversation | null => {
    const found = followUp === undefined ? undefined : kept.get(followUp.key);
    if (followUp === undefined || found === undefined) {
      return null;
    }
    kept.delete(followUp.key);
    clearTimeout(found.timer);
    if (found.cwd !== cwd || found.conversation.exited) {
      end(found.conversation);
      return null;
    }
    return found.conversation;
  };
  const keep = (key: string, cwd: string, conversation: Conversation): void => {
    const before = kept.get(key);
    if (before !== undefined) {
      clearTimeout(before.timer);
      end(before.conversation);
    }
    const timer = setTimeout(() => {
      if (kept.get(key)?.conversation === conversation) {
        kept.delete(key);
      }
      end(conversation);
    }, seconds.idle * 1000);
    kept.set(key, { conversation, cwd, timer });
  };
  return {
    cannotHonour: () => "",
    run: async (prompt, cwd, mode, handlers, cancel, followUp, env, job) => {
      const reused = take(followUp, cwd); // Its key names the repo, which is what `env` says of the agent, so a session kept is one started with the same. A run with a `job` is not followed up.
      const conversation = reused ?? new Conversation(agent, cwd, env, job);
      const late = new AbortController();
      const clock = new Clock(seconds.limit, () => {
        late.abort();
        end(conversation);
      });
      handlers.hold?.(clock);
      // A stop asks the agent to end its turn, and ends the agent itself if it has not within STOP_GRACE.
      let grace: NodeJS.Timeout | undefined;
      const onCancel = (): void => {
        conversation.cancel();
        grace = setTimeout(() => {
          end(conversation);
        }, STOP_GRACE * 1000);
      };
      cancel.addEventListener("abort", onCancel, { once: true });
      if (cancel.aborted) {
        onCancel();
      }
      let answered = false;
      try {
        if (reused === null) {
          await conversation.open(cwd);
        }
        const feed = new Feed(cwd, (item, doing) => {
          handlers.activity(item, doing);
        });
        const turn: Turn = { mode, handlers, cancel, clock, feed, allowed: new Set(), folder: realpathSync(cwd) };
        const answer = await conversation.prompt(reused === null || followUp === undefined ? prompt : followUp.text, turn);
        answered = true;
        return answer;
      } catch (error) {
        if (cancel.aborted) {
          throw new AgentCancelledError("the agent was stopped");
        }
        if (late.signal.aborted) {
          throw new AgentTimedOutError(`the agent did not finish within ${String(seconds.limit)} seconds`);
        }
        throw error;
      } finally {
        clock.stop();
        clearTimeout(grace);
        cancel.removeEventListener("abort", onCancel);
        if (answered && followUp !== undefined && !closed) {
          keep(followUp.key, cwd, conversation);
        } else {
          await conversation.end();
        }
      }
    },
    close: async () => {
      closed = true;
      const all = [...kept.values()];
      kept.clear();
      await Promise.all(
        all.map((each) => {
          clearTimeout(each.timer);
          return each.conversation.end();
        })
      );
    }
  };
}
