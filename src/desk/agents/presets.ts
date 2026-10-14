/**
 * The agents Player Two knows how to start: Cursor's and Copilot's command lines, each over ACP and as a one-shot command. The join form and the setup page offer them; any other is typed in.
 * Nothing here may use what it imports while the module loads: oneshot.ts imports this one back.
 */

import type { Agent } from "../../core/wire.ts";
import { splitCommand } from "./oneshot.ts";

/** Cursor's command line run once. Without --force it only proposes changes, which oneshot.ts relies on to run it read-only. */
export const CURSOR_ONESHOT: Agent = { id: "cursor-oneshot", label: "Cursor one-shot", protocol: "oneshot", command: "agent", args: ["-p", "--output-format", "text"] };

/** What the join form offers first: Cursor, one-shot, as before phase 3. */
export const DEFAULT_PRESET = CURSOR_ONESHOT;

export const PRESETS: readonly Agent[] = [
  DEFAULT_PRESET,
  { id: "cursor", label: "Cursor", protocol: "acp", command: "agent", args: ["acp"] },
  { id: "copilot-oneshot", label: "Copilot one-shot", protocol: "oneshot", command: "copilot", args: ["-s", "--allow-all-tools", "--no-ask-user", "-p"] },
  { id: "copilot", label: "Copilot", protocol: "acp", command: "copilot", args: ["--acp", "--stdio"] }
];

/** A one-shot agent from a command typed as one line, split as a shell would split it: the preset when it is one, as config.json held it before agents were configured one by one. */
export function oneshotAgent(commandLine: string): Agent {
  const [command = "", ...args] = splitCommand(commandLine);
  const words = JSON.stringify([command, ...args]);
  return (
    PRESETS.find((preset) => preset.protocol === "oneshot" && JSON.stringify([preset.command, ...preset.args]) === words) ?? {
      id: "custom",
      label: commandLine.trim(),
      protocol: "oneshot",
      command,
      args
    }
  );
}

// How to sign in to each preset's own service, by program, for when an agent says it must and does not name a command itself.
// ponytail: Copilot's is from its documentation, not tried here; P3-F3 checks both on the workstation.
const SIGN_IN = new Map([
  ["agent", "`agent login`"],
  ["copilot", "`copilot`, then `/login` in it"]
]);

/** How the user signs in to an agent's own service, in words for a problem shown to them. */
export function signInFor(agent: Agent): string {
  return SIGN_IN.get(agent.command) ?? `${agent.label}'s own sign-in`;
}
