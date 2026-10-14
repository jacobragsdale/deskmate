/** The agents Player Two knows how to start: Cursor's and Copilot's command lines, each over ACP and as a one-shot command. The join form and the setup page offer them; any other is typed in. */

import type { Agent } from "../../core/wire.ts";
import { splitCommand } from "./oneshot.ts";

/** What the join form offers first: Cursor, one-shot, as before phase 3. */
export const DEFAULT_PRESET: Agent = { id: "cursor-oneshot", label: "Cursor one-shot", protocol: "oneshot", command: "agent", args: ["-p", "--output-format", "text"] };

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
