/** The one shape every kind of agent presents to the session: a run in a checkout at a permission mode, telling the session what it does as it does it, and asking it what the mode leaves to the owner. */

import type { ActivityItem } from "../../shared/ipc.ts";
import type { Action, PermissionMode } from "../permissions.ts";

/** Something the agent wants to do that its mode leaves to the owner: the kind of action, what it is in one line, and the detail, such as the command or the file and its change, at most 8 KB. */
export interface PermissionAsk {
  readonly action: Action;
  readonly title: string;
  readonly detail: string;
}

export interface RunHandlers {
  activity(item: ActivityItem): void; // New, or a newer version of one with the same id. The runner leaves `run` as "": the session, which knows the run, fills it in.
  permission(ask: PermissionAsk): Promise<"allow-once" | "allow-run" | "refuse">;
}

/** A request that may carry on from an earlier one: `key` names its thread's root, its asker and the agent, and `text` is the request alone, without the usual context. */
export interface FollowUp {
  readonly key: string;
  readonly text: string;
}

export interface AgentRunner {
  readonly restrictable: boolean; // False means modes cannot be enforced on it.
  /** Why it cannot be held to `mode`, said before a run starts; "" when it can. A run at such a mode is refused before anything starts. */
  cannotHonour(mode: PermissionMode): string;
  /**
   * Run the agent on `prompt` in `cwd` and resolve with its answer. Aborting `cancel` stops it and everything it started, and rejects with AgentCancelledError.
   * With `followUp`, an agent that can keep a session goes on in the one an earlier run with the same key left open, with only the follow-up's text, and keeps its own open for the next.
   */
  run(prompt: string, cwd: string, mode: PermissionMode, handlers: RunHandlers, cancel: AbortSignal, followUp?: FollowUp): Promise<string>;
  /** End every session kept open for a follow-up, and everything their agents started. */
  close(): Promise<void>;
}
