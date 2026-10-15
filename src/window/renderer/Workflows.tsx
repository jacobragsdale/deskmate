/**
 * A channel's workflows, in a dialog: each live one with what sets it off and its steps in words, who published it and when, a webhook's address to copy, its newest runs and how each step came
 * out, and Remove. Everything in it, a workflow's name and steps and the hub's words on a run among them, is someone else's text, drawn as text.
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";

import type { CurrentView, WorkflowView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";
import { Modal } from "./dialogs.tsx";
import { copyText } from "./Message.tsx";

/** When something happened, as the panel says it: the day and the time. */
function When({ ts }: { readonly ts: number }): JSX.Element {
  const at = new Date(ts * 1000);
  return (
    <time dateTime={at.toISOString()} title={at.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}>
      {at.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

/** A workflow's newest runs, newest first, each with how each of its steps came out as the hub reported it, counting steps from 1 as the list of steps does. */
function Runs({ runs }: { readonly runs: Extract<WorkflowView, { shown: true }>["runs"] }): JSX.Element {
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  }
  return (
    <ul className="text-xs text-muted-foreground" aria-label="Runs">
      {runs.map((run) => (
        <li key={run.run} data-run={run.run} className="wrap-anywhere">
          Run {run.run} · <When ts={run.ts} /> · {run.steps.map(({ step, status, detail }) => `step ${String(step + 1)} ${status}${detail === "" ? "" : `: ${detail}`}`).join(" · ")}
        </li>
      ))}
    </ul>
  );
}

function Item({
  workflow,
  chat,
  me,
  removing,
  remove
}: {
  readonly workflow: WorkflowView;
  readonly chat: string;
  readonly me: string;
  readonly removing: boolean;
  readonly remove: () => void;
}): JSX.Element {
  const who = workflow.author === me ? "you" : workflow.author;
  if (!workflow.shown) {
    return (
      <li className="border-t pt-2 text-destructive">
        ✗ a workflow {who} published cannot be shown: {workflow.why}
      </li>
    );
  }
  return (
    <li data-workflow={workflow.name} className="flex min-w-0 flex-col gap-1 border-t pt-2">
      <p className="flex items-baseline gap-2">
        <strong className="wrap-anywhere">{workflow.name}</strong>
        <span className="min-w-0 flex-1 text-muted-foreground wrap-anywhere">
          on {workflow.on} · published by {who} · <When ts={workflow.ts} />
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={removing}
          onClick={(event) => {
            // The second click of a double click lands on whatever the first put under the pointer: here the next workflow's Remove, once this one has gone.
            if (event.detail <= 1) {
              remove();
            }
          }}
        >
          Remove
        </Button>
      </p>
      <ol className="list-decimal pl-6" aria-label="Steps">
        {workflow.steps.map((step, at) => (
          // The steps of one definition never change, so their position is a stable key.
          <li key={at} className="wrap-anywhere whitespace-pre-wrap">
            {step}
          </li>
        ))}
      </ol>
      {workflow.hook !== null && (
        <p className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 truncate text-xs" title={workflow.hook}>
            POST {workflow.hook}
          </code>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              if (workflow.hook !== null) {
                copyText(workflow.hook, "Address");
              }
            }}
          >
            Copy address
          </Button>
        </p>
      )}
      {workflow.secret && (
        <p className="text-xs text-muted-foreground">A call must carry the workflow&rsquo;s secret in an X-Player-Two-Secret header. Anyone in {chat} can read it in the workflow&rsquo;s file.</p>
      )}
      <Runs runs={workflow.runs} />
    </li>
  );
}

/** The dialog of a channel's workflows. */
function Workflows({ current, me, act, onDone }: { readonly current: CurrentView; readonly me: string; readonly act: Act; readonly onDone: () => void }): JSX.Element {
  const [removing, setRemoving] = useState<readonly string[]>([]); // The workflows being removed: their Remove does nothing more until the desk answers.
  const { chat, workflows } = current;
  return (
    <Modal title={`Workflows in ${chat}`} className="sm:max-w-2xl" onDismiss={onDone}>
      <div className="max-h-[70vh] min-w-0 overflow-y-auto">
        {workflows === null && <p className="text-muted-foreground">Loading…</p>}
        {workflows?.length === 0 && <p className="text-muted-foreground">No workflows in {chat}.</p>}
        <ul className="flex flex-col gap-3">
          {workflows?.map((workflow) => (
            <Item
              key={workflow.id}
              workflow={workflow}
              chat={chat}
              me={me}
              removing={workflow.shown && removing.includes(workflow.name)}
              remove={() => {
                if (workflow.shown) {
                  const { name } = workflow;
                  setRemoving((each) => [...each, name]);
                  act({ do: "removeWorkflow", chat, name }, () => {
                    setRemoving((each) => each.filter((one) => one !== name));
                  });
                }
              }}
            />
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** The button in a channel's title that opens its workflows. */
export function OpenWorkflows({ current, me, act }: { readonly current: CurrentView; readonly me: string; readonly act: Act }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        className="text-foreground"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        ⚙ Workflows
      </Button>
      {open && (
        <Workflows
          current={current}
          me={me}
          act={act}
          onDone={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
