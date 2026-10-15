/**
 * Choosing agents: one the desk offers as a preset, or a program and its arguments typed in, one argument per row, for the join form and the setup page.
 * Nothing here starts an agent, and no shell ever reads what is typed: the desk starts the program with the arguments as they are.
 */

import { cn } from "cn";
import { useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { commandLineOf } from "../../core/wire.ts";
import type { Agent } from "../../core/wire.ts";
import { outcomeSchema } from "../../shared/ipc.ts";
import type { ChatView, Check, Command } from "../../shared/ipc.ts";
import { MARK_COLOURS, MARKS } from "./SetupPage.tsx";

export const FIELD = "flex-col items-stretch gap-1.5"; // A label above its field.
const PROTOCOLS = { acp: "ACP: asks before it acts", oneshot: "One-shot: the prompt added as the last argument" } as const;

/** A new agent of the user's own, with an id none of `taken` has. */
export function ownAgent(taken: readonly Agent[]): Agent {
  const ids = new Set(taken.map((agent) => agent.id));
  let id = "custom";
  for (let count = 2; ids.has(id); count += 1) {
    id = `custom-${String(count)}`;
  }
  return { id, label: "", protocol: "acp", command: "", args: [] };
}

interface PickerProps {
  readonly title: string;
  readonly presets: readonly Agent[];
  readonly taken: readonly Agent[]; // Agents already configured, whose ids a new one must not reuse.
  readonly value: Agent;
  readonly onChange: (agent: Agent) => void;
}

/** One agent: a preset from the list, or under "Other" a program, how it is spoken to, and its arguments, each row one argument. */
export function AgentPicker({ title, presets, taken, value, onChange }: PickerProps): JSX.Element {
  const preset = presets.find((each) => each.id === value.id);
  const own = { ...value, label: value.command }; // An agent of the user's own is called by its program.
  const setArgs = (args: readonly string[]): void => {
    onChange({ ...own, args });
  };
  return (
    <>
      <Label className={FIELD}>
        {title}
        <select
          value={preset?.id ?? ""}
          onChange={(event) => {
            onChange(presets.find((each) => each.id === event.currentTarget.value) ?? ownAgent(taken));
          }}
        >
          {presets.map((each) => (
            <option key={each.id} value={each.id}>
              {each.label}
            </option>
          ))}
          <option value="">Other</option>
        </select>
      </Label>
      {preset === undefined ? (
        <>
          <Label className={FIELD}>
            How it is spoken to
            <select
              value={value.protocol}
              onChange={(event) => {
                onChange({ ...own, protocol: event.currentTarget.value === "oneshot" ? "oneshot" : "acp" });
              }}
            >
              <option value="acp">{PROTOCOLS.acp}</option>
              <option value="oneshot">{PROTOCOLS.oneshot}</option>
            </select>
          </Label>
          <Label className={FIELD}>
            Program
            <Input
              className="font-normal"
              aria-label="Program"
              value={value.command}
              placeholder="found on your PATH, and run in the repo's folder"
              required
              onChange={(event) => {
                onChange({ ...own, command: event.currentTarget.value, label: event.currentTarget.value });
              }}
            />
          </Label>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Arguments, one per row</span>
            {value.args.map((arg, index) => (
              // Keyed by place: a row is its place in the list, and its text is what is being typed.
              <div key={index} className="flex gap-1.5">
                <Input
                  className="font-normal"
                  aria-label={`Argument ${String(index + 1)}`}
                  value={arg}
                  onChange={(event) => {
                    setArgs(value.args.map((each, at) => (at === index ? event.currentTarget.value : each)));
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Remove argument ${String(index + 1)}`}
                  onClick={() => {
                    setArgs(value.args.filter((_each, at) => at !== index));
                  }}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="self-start"
              onClick={() => {
                setArgs([...value.args, ""]);
              }}
            >
              Add an argument
            </Button>
          </div>
        </>
      ) : (
        <code className="text-xs text-muted-foreground">{commandLineOf(preset)}</code>
      )}
    </>
  );
}

/**
 * Whether an agent over ACP asks before it writes a file, which it must to be held to a mode: tested only when the user presses the button, since the agent's answer costs a model call,
 * and shown with what it found. The setup check above shows the result kept from the last test.
 */
function TestPermissions({ agent }: { readonly agent: Agent }): JSX.Element {
  const [testing, setTesting] = useState(false);
  const [found, setFound] = useState<Check | null>(null);
  const test = (): void => {
    setTesting(true);
    window.playerTwo
      .command({ do: "testPermissions", agent: agent.id })
      .then((raw) => {
        const outcome = outcomeSchema.parse(raw);
        if (outcome.ok) {
          setFound(outcome.data?.[0] ?? null);
        } else {
          toast.error(`could not test ${agent.label}`, { description: outcome.problem });
        }
      })
      .catch((error: unknown) => {
        toast.error(`could not test ${agent.label}`, { description: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        setTesting(false);
      });
  };
  return (
    <>
      <Button type="button" size="xs" variant="outline" disabled={testing} onClick={test}>
        {testing ? "Testing…" : "Test permissions"}
      </Button>
      {found !== null && (
        <p className="order-last basis-full pl-5 wrap-anywhere text-muted-foreground" data-tested={found.status}>
          <span className={cn("font-bold", MARK_COLOURS[found.status])}>{MARKS[found.status]}</span> {found.detail}
        </p>
      )}
    </>
  );
}

/** The setup page's part about the user's agents: which of them answers, removing one, testing whether one over ACP can be held to a mode, and adding a preset or one of their own. Each change is saved at once. */
export function AgentsPart({ view, act }: { readonly view: ChatView; readonly act: (command: Command) => void }): JSX.Element {
  const { agents, defaultAgent, presets } = view;
  const next = (taken: readonly Agent[]): Agent => presets.find((preset) => taken.every((agent) => agent.id !== preset.id)) ?? ownAgent(taken);
  const [adding, setAdding] = useState<Agent>(() => next(agents));
  const save = (next: readonly Agent[], answering: string): void => {
    act({ do: "agents", agents: next, defaultAgent: next.some((agent) => agent.id === answering) ? answering : (next[0]?.id ?? "") });
  };
  const fresh = agents.every((agent) => agent.id !== adding.id) && adding.command.trim() !== "";
  return (
    <>
      <h2 className="mt-4 text-lg font-bold">Agents</h2>
      <p className="text-muted-foreground">
        The one chosen answers when your repos are tagged. An ACP agent asks before it acts, so it can be held to a level of access; a one-shot command runs to the end with what its own settings
        allow.
      </p>
      <ul className="flex flex-col gap-1.5">
        {agents.map((agent) => (
          <li key={agent.id} className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="defaultAgent"
              aria-label={`${agent.label} answers`}
              checked={agent.id === defaultAgent}
              onChange={() => {
                save(agents, agent.id);
              }}
            />
            <strong>{agent.label}</strong>
            <span className="text-muted-foreground">{agent.protocol === "acp" ? "ACP" : "one-shot"}</span>
            {/* Of no width of its own, so that a long command line is cut short rather than wrapped onto a line of its own; only a test's result goes there. */}
            <span className="min-w-0 flex-1 basis-0 truncate">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs" title={commandLineOf(agent)}>
                {commandLineOf(agent)}
              </code>
            </span>
            {agent.protocol === "acp" && <TestPermissions agent={agent} />}
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={agents.length === 1}
              onClick={() => {
                save(
                  agents.filter((each) => each !== agent),
                  defaultAgent
                );
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex max-w-90 flex-col gap-3">
        <AgentPicker title="Add an agent" presets={presets} taken={agents} value={adding} onChange={setAdding} />
        <Button
          type="button"
          size="xs"
          className="self-start"
          disabled={!fresh}
          onClick={() => {
            save([...agents, adding], defaultAgent);
            setAdding(next([...agents, adding]));
          }}
        >
          Add
        </Button>
      </div>
    </>
  );
}
