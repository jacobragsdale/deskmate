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

export interface AgentRunner {
  readonly restrictable: boolean; // False means modes cannot be enforced on it.
  /** Run the agent on `prompt` in `cwd` and resolve with its answer. Aborting `cancel` stops it and everything it started, and rejects with AgentCancelledError. */
  run(prompt: string, cwd: string, mode: PermissionMode, handlers: RunHandlers, cancel: AbortSignal): Promise<string>;
}
