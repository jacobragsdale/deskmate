/**
 * A channel's workflows, in a dialog: each live one with what sets it off and its steps in words, who published it and when, a webhook's address to copy, its newest runs and how each step came
 * out, and Remove; and publishing one from the repo the channel is about. Everything in it, a workflow's name and steps, a file from a repo and the hub's words on a run among them, is someone
 * else's text, drawn as text.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";

import { outcomeSchema } from "../../shared/ipc.ts";
import type { CurrentView, Outcome, WorkflowFile, WorkflowView } from "../../shared/ipc.ts";
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

/** What the desk found in the repo's workflow folder: the folder, and each file in it as it reads. */
type Found = NonNullable<Extract<Outcome, { readonly ok: true }>["workflowFiles"]>;

/**
 * One file chosen to publish: the workflow it holds in words, with what it replaces, and a button that publishes it; or the line that is wrong and why. Its text is under them, to look at.
 */
function Chosen({ file, current, me, act, onDone }: { readonly file: WorkflowFile; readonly current: CurrentView; readonly me: string; readonly act: Act; readonly onDone: () => void }): JSX.Element {
  const [sending, setSending] = useState(false); // While the desk publishes it: the button does nothing more, so a second click publishes nothing twice.
  const { read } = file;
  // The live one of that name, whether or not its file reads here: the hub replaces it all the same.
  const replaced = read.ok ? current.workflows?.find((each) => each.name === read.name) : undefined;
  return (
    <section className="flex min-w-0 flex-col gap-1.5 border-t pt-2" aria-label={file.name}>
      {read.ok ? (
        <>
          <p className="wrap-anywhere">
            <strong>{read.name}</strong> <span className="text-muted-foreground">on {read.on}</span>
          </p>
          <ol className="list-decimal pl-6" aria-label="Steps">
            {read.steps.map((step, at) => (
              <li key={at} className="wrap-anywhere whitespace-pre-wrap">
                {step}
              </li>
            ))}
          </ol>
          {replaced !== undefined && (
            <p className="text-warn">
              It replaces the {read.name} {replaced.author === me ? "you" : replaced.author} published: its runs waiting for a 👍 are cancelled
              {!replaced.shown ? ", and its webhook, if it has one, gets a new address" : replaced.hook === null ? "" : ", and its webhook gets a new address"}.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Everyone in {current.chat} can read the file once it is published, its secret and the addresses it calls included.</p>
        </>
      ) : (
        <p className="text-destructive wrap-anywhere" role="alert">
          {read.problem}
        </p>
      )}
      {file.yaml !== "" && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">The file</summary>
          <pre className="max-h-60 overflow-auto rounded-md border bg-muted p-2 text-xs">{file.yaml}</pre>
        </details>
      )}
      {read.ok && (
        <Button
          type="button"
          className="self-start"
          disabled={sending || current.workflows === null} // Until the live ones are listed, it is not known what it replaces.
          onClick={() => {
            setSending(true);
            act({ do: "publishWorkflow", chat: current.chat, file: file.name, yaml: file.yaml }, (ok) => {
              setSending(false);
              if (ok) {
                onDone();
              }
            });
          }}
        >
          Publish {read.name} to {current.chat}
        </Button>
      )}
    </section>
  );
}

/**
 * Publishing a workflow from the repo the channel is about: the files in its .player-two/workflows/ folder, which the desk reads, as the window reads no files, and the one chosen (see `Chosen`).
 */
function Publish({ current, me, act, onDone }: { readonly current: CurrentView; readonly me: string; readonly act: Act; readonly onDone: () => void }): JSX.Element {
  const [found, setFound] = useState<Found | string | null>(null); // Null while the desk looks, and the problem in words when it cannot.
  const [chosen, setChosen] = useState("");
  const { chat } = current;
  useEffect(() => {
    let wanted = true; // Until the dialog closes.
    window.playerTwo
      .command({ do: "workflowFiles", chat })
      .then((raw) => {
        const outcome = outcomeSchema.parse(raw);
        if (wanted) {
          setFound(outcome.ok ? (outcome.workflowFiles ?? { folder: "", files: [] }) : outcome.problem);
        }
      })
      .catch(console.error);
    return (): void => {
      wanted = false;
    };
  }, [chat]);
  if (found === null || typeof found === "string") {
    return <p className={found === null ? "text-muted-foreground" : "text-destructive"}>{found ?? "Reading the repo’s workflow files…"}</p>;
  }
  const file = found.files.find((each) => each.name === chosen);
  return (
    <>
      <p className="text-muted-foreground wrap-anywhere">{found.files.length === 0 ? `No .yml or .yaml file in ${found.folder}.` : `From ${found.folder}:`}</p>
      <ul className="flex flex-wrap gap-1.5" aria-label="Files">
        {found.files.map((each) => (
          <li key={each.name}>
            <Button
              type="button"
              size="xs"
              variant={each.name === chosen ? "secondary" : "outline"}
              aria-pressed={each.name === chosen}
              onClick={() => {
                setChosen(each.name);
              }}
            >
              {each.read.ok ? "" : "✗ "}
              {each.name}
            </Button>
          </li>
        ))}
      </ul>
      {file !== undefined && <Chosen key={file.name} file={file} current={current} me={me} act={act} onDone={onDone} />}
    </>
  );
}

/** The dialog of a channel's workflows, or of publishing one. */
function Workflows({ current, me, act, onDone }: { readonly current: CurrentView; readonly me: string; readonly act: Act; readonly onDone: () => void }): JSX.Element {
  const [removing, setRemoving] = useState<readonly string[]>([]); // The workflows being removed: their Remove does nothing more until the desk answers.
  const [publishing, setPublishing] = useState(false);
  const { chat, workflows } = current;
  const back = (): void => {
    setPublishing(false);
  };
  if (publishing) {
    return (
      <Modal title={`Publish a workflow to ${chat}`} className="sm:max-w-2xl" onDismiss={onDone}>
        <div className="flex max-h-[70vh] min-w-0 flex-col gap-2 overflow-y-auto">
          <Publish current={current} me={me} act={act} onDone={back} />
          <Button type="button" variant="outline" className="self-start" onClick={back}>
            Back
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Workflows in ${chat}`} className="sm:max-w-2xl" onDismiss={onDone}>
      <div className="flex max-h-[70vh] min-w-0 flex-col gap-3 overflow-y-auto">
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
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => {
            setPublishing(true);
          }}
        >
          Publish a workflow
        </Button>
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
