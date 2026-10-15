/** The one shape every kind of agent presents to the session: a run in a checkout at a permission mode, telling the session what it does as it does it, and asking it what the mode leaves to the owner. */

import type { Summary } from "../../core/kinds.ts";
import type { ActivityItem } from "../../shared/ipc.ts";
import type { Action, PermissionMode } from "../permissions.ts";

/** Something the agent wants to do that its mode leaves to the owner: the kind of action, what it is in one line, and the detail, such as the command or the file and its change, at most 8 KB. */
export interface PermissionAsk {
  readonly action: Action;
  readonly title: string;
  readonly detail: string;
}

export interface RunHandlers {
  // New, or a newer version of one with the same id, and what the agent is doing as of it in the coarse words the chat is told. The runner leaves `run` as "": the session, which knows the run, fills it in.
  activity(item: ActivityItem, doing: Summary): void;
  // `gone` is aborted once nobody waits for the answer any more: the agent took the request back or went, or the run was stopped.
  permission(ask: PermissionAsk, gone: AbortSignal): Promise<"allow-once" | "allow-run" | "refuse">;
  // The run's time limit, once it starts counting, for the session to stop it while the agent waits on agents it asked, and start it again once none is open. A runner without one never calls it.
  hold?(limit: Pausable): void;
}

/** A time limit that can stand still: each pause is matched by one resume, and it counts again once every pause has been. Neither does anything once the run has ended. */
export interface Pausable {
  pause(): void;
  resume(): void;
}

/** A request that may carry on from an earlier one: `key` names its thread's root, its asker, the agent, and the mode and delivery it was let go at; `text` is the request alone, without the usual context. */
export interface FollowUp {
  readonly key: string;
  readonly text: string;
}

export interface AgentRunner {
  /** Why it cannot be held to `mode`, said before a run starts; "" when it can. A run at such a mode is refused before anything starts. */
  cannotHonour(mode: PermissionMode): string;
  /**
   * Run the agent on `prompt` in `cwd` and resolve with its answer. Aborting `cancel` stops it and everything it started, and rejects with AgentCancelledError.
   * With `followUp`, an agent that can keep a session goes on in the one an earlier run with the same key left open, with only the follow-up's text, and keeps its own open for the next.
   * `env`, who it is from `agentEnv`, is added to the agent's environment, and an agent over ACP is given Player Two's MCP server with it. A run under a grant is told the one chat the command
   * then reads, and is given no MCP server: whoever asked must not be handed, unreviewed, what the owner's other chats hold. With `job`, the request a run its owner let ask other agents
   * was asked, that server is started with --job naming it, which lets the agent ask others under it.
   */
  run(prompt: string, cwd: string, mode: PermissionMode, handlers: RunHandlers, cancel: AbortSignal, followUp?: FollowUp, env?: Readonly<Record<string, string>>, job?: string): Promise<string>;
  /** End every session kept open for a follow-up, and everything their agents started. */
  close(): Promise<void>;
}
