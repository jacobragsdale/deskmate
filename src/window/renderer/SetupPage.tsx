/**
 * The setup check as a page: each item with how it stands and what was found, its fix with a button to copy it, "Check again", and on Windows the distribution the desk runs in.
 * Below it, once someone has joined, their agents (Agents.tsx); then what to add to an editor's agent so it can use Player Two's MCP server, to copy; the page never writes those files.
 */

import { cn } from "cn";
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { checkSchema, distroChoiceSchema, outcomeSchema } from "../../shared/ipc.ts";
import type { Check, DistroChoice, Notice } from "../../shared/ipc.ts";

const checksSchema = z.array(checkSchema).readonly();

const MARKS = { ok: "✓", warn: "!", fail: "✗", skip: "–" } as const;
const MARK_COLOURS = { ok: "text-tag", warn: "text-warn", fail: "text-destructive", skip: "" } as const;
const DETAIL = "mt-0.5 wrap-anywhere whitespace-pre-wrap text-muted-foreground"; // What a check found, in the lines it came in.

/** Where each editor's agent looks for MCP servers, and what to put there to start `player-two mcp`. */
const EDITORS = [
  { name: "Cursor", file: "~/.cursor/mcp.json", server: { command: "player-two", args: ["mcp"] } },
  { name: "Copilot's command line", file: "~/.copilot/mcp-config.json", server: { type: "local", command: "player-two", args: ["mcp"], tools: ["*"] } }
].map((editor) => ({ ...editor, json: JSON.stringify({ mcpServers: { "player-two": editor.server } }, null, 2) }));

/** Ask for the setup check. With `again`, a desk that is not up is started afresh first, so what the user fixed is tried. */
export async function runSetupCheck(again: boolean): Promise<readonly Check[]> {
  return checksSchema.parse(await window.playerTwo.doctor(again));
}

interface Props {
  readonly children?: ReactNode; // What else the page shows about this machine, between the check and the editor agents: the user's own agents, once they have joined.
  readonly problem: string; // Why the desk will not start; "" when it is up.
  readonly initial: readonly Check[] | null; // A list already in hand, from the check at launch; null to ask for one.
  readonly onClose: (() => void) | null; // Null when there is nothing else to show, because the desk is not up.
  readonly tell: (notice: Notice) => void;
}

export function SetupPage({ children, problem, initial, onClose, tell }: Props): JSX.Element {
  const [checks, setChecks] = useState<readonly Check[] | null>(initial);
  const [busy, setBusy] = useState(false);
  const [distros, setDistros] = useState<DistroChoice | null>(null);

  const failed = useCallback(
    (error: unknown): void => {
      tell({ title: "the setup check did not finish", body: error instanceof Error ? error.message : String(error), severity: "error" });
    },
    [tell]
  );

  const check = useCallback(
    (again: boolean): void => {
      setBusy(true);
      runSetupCheck(again)
        .then(setChecks, failed)
        .finally(() => {
          setBusy(false);
        });
    },
    [failed]
  );

  useEffect(() => {
    if (initial === null) {
      check(false);
    }
    window.playerTwo
      .distros()
      .then((raw) => {
        setDistros(distroChoiceSchema.nullable().parse(raw));
      })
      .catch(failed);
  }, [initial, check, failed]);

  const choose = (name: string | null): void => {
    setBusy(true);
    window.playerTwo
      .distro(name)
      .then(async (raw) => {
        const outcome = outcomeSchema.parse(raw);
        if (!outcome.ok) {
          tell({ title: "could not change the distribution", body: outcome.problem, severity: "error" });
        }
        setDistros(distroChoiceSchema.nullable().parse(await window.playerTwo.distros()));
        setChecks(await runSetupCheck(false));
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
      });
  };

  const copy = (fix: string): void => {
    navigator.clipboard.writeText(fix).then(
      () => {
        tell({ title: "", body: "Copied.", severity: "info" });
      },
      (error: unknown) => {
        tell({ title: "could not copy", body: error instanceof Error ? error.message : String(error), severity: "error" });
      }
    );
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-[max(16px,calc((100%_-_720px)/2))] py-[6vh]">
      <h1 className="text-2xl font-bold">Setup</h1>
      {problem !== "" && <p className="whitespace-pre-wrap">Player Two cannot start its desk: {problem}</p>}
      {distros !== null && (
        <Label className="flex-col items-start gap-1.5">
          Linux distribution
          <select
            value={distros.chosen ?? ""}
            disabled={busy}
            onChange={(event) => {
              choose(event.currentTarget.value === "" ? null : event.currentTarget.value);
            }}
          >
            <option value="">WSL&rsquo;s default</option>
            {distros.names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Label>
      )}
      {checks === null ? (
        <p className="m-auto p-8 text-center text-muted-foreground">Checking…</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {checks.map((item) => (
            <li key={item.id} className={cn("flex gap-2.5", item.status === "skip" && "opacity-70")}>
              <span className={cn("w-[1.2em] flex-none text-center font-bold", MARK_COLOURS[item.status])} title={item.status}>
                {MARKS[item.status]}
              </span>
              <div>
                <strong>{item.title}</strong>
                <p className={DETAIL}>{item.detail}</p>
                {item.fix !== "" && (
                  <p className={cn(DETAIL, "flex items-center gap-2")}>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">{item.fix}</code>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        copy(item.fix);
                      }}
                    >
                      Copy
                    </Button>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="flex gap-2">
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            check(true);
          }}
        >
          {busy ? "Checking…" : "Check again"}
        </Button>
        {onClose !== null && (
          <Button type="button" variant="outline" onClick={onClose}>
            Back
          </Button>
        )}
      </p>
      {children}
      <h2 className="mt-4 text-lg font-bold">Editor agents</h2>
      <p className="text-muted-foreground">
        An agent in your editor can read and search this chat through Player Two&rsquo;s MCP server, <code>player-two mcp</code>, which runs as you. Add it to the file named below in your home folder
        where the agent runs, inside WSL on Windows; if the file has other servers already, add the <code>player-two</code> entry to its <code>mcpServers</code>.
      </p>
      {EDITORS.map((editor) => (
        <div key={editor.file}>
          <p className="flex items-center gap-2">
            <strong>{editor.name}</strong>
            <code className="text-muted-foreground">{editor.file}</code>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                copy(editor.json);
              }}
            >
              Copy
            </Button>
          </p>
          <pre className="mt-1 overflow-x-auto rounded bg-muted px-2 py-1.5 text-xs">{editor.json}</pre>
        </div>
      ))}
      <p className="text-muted-foreground">
        As it is, the agent can only read. With <code>&quot;--allow-send&quot;</code> after <code>&quot;mcp&quot;</code> in <code>args</code>, it can also send messages, ask agents and withdraw
        requests, as you; a tag it sends waits for the agent&rsquo;s owner like any other, even when the agent is yours.
      </p>
    </div>
  );
}
