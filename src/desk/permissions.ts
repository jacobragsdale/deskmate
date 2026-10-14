/** Permission modes: what an agent may do without asking, as one pure table. The desk holds an agent to its mode by answering the agent's permission requests over ACP with it. */

import { MODES } from "../core/wire.ts";
import type { PermissionMode } from "../core/wire.ts";

export type { PermissionMode } from "../core/wire.ts";

/** What an agent asks to do: one of ACP's tool kinds. One the desk does not know is asked about as `other`. */
export type Action = "read" | "search" | "think" | "edit" | "delete" | "move" | "execute" | "fetch" | "other";
export type Decision = "allow" | "ask" | "refuse";

// The protocol reference's two columns after reading, which every mode allows.
const EDITING: Readonly<Record<PermissionMode, Decision>> = { "read-only": "refuse", supervised: "ask", "auto-edits": "allow", full: "allow" };
const RUNNING: Readonly<Record<PermissionMode, Decision>> = { "read-only": "refuse", supervised: "ask", "auto-edits": "ask", full: "allow" }; // Commands, fetching, anything else.

/** Whether mode `a` allows no more than mode `b`, in the order read-only, supervised, auto-edits, full: so a run started for someone else is held to `atMost(mode, chosen)`. */
export function atMost(a: PermissionMode, b: PermissionMode): boolean {
  return MODES.indexOf(a) <= MODES.indexOf(b);
}

/** What the desk answers when an agent in `mode` asks to do `action`. The table is "Permission modes" in docs/plan/protocol.md. */
export function decide(mode: PermissionMode, action: Action): Decision {
  switch (action) {
    case "read":
    case "search":
    case "think":
      return "allow";
    case "edit":
      return EDITING[mode];
    case "delete":
    case "move":
      // As editing, except that a mode which edits without asking still asks before a file is taken away or moved.
      return mode === "auto-edits" ? "ask" : EDITING[mode];
    case "execute":
    case "fetch":
    case "other":
      return RUNNING[mode];
  }
}
