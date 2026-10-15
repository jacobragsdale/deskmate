/** A patch as a card: its title, the files it changes with the lines each adds and removes, and each file's diff folded, all read by diff.ts and drawn as text. */

import { Fragment, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { parseDiff } from "../../core/diff.ts";
import type { DiffFile } from "../../core/diff.ts";
import type { PatchView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const MARKS: Readonly<Record<string, string>> = { "+": "text-green-700 dark:text-green-400", "-": "text-destructive", "\\": "text-muted-foreground" }; // A changed line, by its first character.

/** One file of a patch: its name, what it adds and removes, and, once opened, its hunks. They are drawn only when opened, as a patch may be half a megabyte. */
function FileDiff({ file }: { readonly file: DiffFile }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details
        open={open}
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
        }}
      >
        <summary className="cursor-pointer font-mono text-xs">
          <span className="wrap-anywhere">{file.from === null ? file.path : `${file.from} → ${file.path}`}</span> <span className={MARKS["+"]}>+{file.added}</span>{" "}
          <span className={MARKS["-"]}>−{file.removed}</span>
          {file.binary && <span className="text-muted-foreground"> · binary</span>}
        </summary>
        {open &&
          (file.hunks.length === 0 ? (
            <p className="text-xs text-muted-foreground">{file.binary ? "A binary file: its bytes are not shown." : "No lines change."}</p>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-1.5 text-xs">
              {/* A hunk's lines never reorder, so their position is a stable key. */}
              {file.hunks.map((hunk, at) => (
                <Fragment key={at}>
                  <span className="text-muted-foreground">{`${hunk.header}\n`}</span>
                  {hunk.lines.map((line, index) => (
                    <span key={index} className={MARKS[line[0] ?? " "]}>{`${line}\n`}</span>
                  ))}
                </Fragment>
              ))}
            </pre>
          ))}
      </details>
    </li>
  );
}

/** A patch: its title, where it was made, and its files, each folded. `children` is what the reader can do with it. Nothing in it is ever inserted as HTML. */
export function PatchCard({ patch, children }: { readonly patch: PatchView; readonly children?: ReactNode }): JSX.Element {
  const files = useMemo(() => parseDiff(patch.diff), [patch.diff]);
  return (
    <section aria-label="Patch" className="my-1 rounded-lg border px-2.5 py-2">
      <p className="font-medium wrap-anywhere">{patch.title}</p>
      <p className="text-xs text-muted-foreground">
        A patch to {patch.repo}, made on {patch.branch} at <code title={patch.base}>{patch.base.slice(0, 7)}</code> · {files.length} {files.length === 1 ? "file" : "files"}
      </p>
      <ul className="my-1">
        {/* A diff's files never reorder, so their position is a stable key. */}
        {files.map((file, at) => (
          <FileDiff key={at} file={file} />
        ))}
      </ul>
      {children}
    </section>
  );
}

/**
 * What has been done with a patch in the chat, and what the reader can do: who applied it to which branch, and for a reader with a checkout of its repo, Apply, to the branch it is on,
 * and Apply to a new branch, made from the commit the patch was made on. The desk checks its paths and whether git takes it, then asks in a dialog of the system's own; the buttons wait
 * until it has its answer.
 */
export function PatchActions({ id, patch, me, act }: { readonly id: string; readonly patch: PatchView; readonly me: string; readonly act: Act }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const apply = (newBranch: boolean): void => {
    setBusy(true);
    act({ do: "applyPatch", id, newBranch }, () => {
      setBusy(false);
    });
  };
  return (
    <>
      {/* What was said of a patch never reorders, so its position is a stable key. */}
      {patch.applied.map((each, at) => (
        <p key={at} className="text-xs text-muted-foreground">
          ✓ {each.who === me ? "you" : each.who} applied it to {each.branch}
        </p>
      ))}
      {patch.checkout && (
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="outline"
            className="text-foreground"
            type="button"
            disabled={busy}
            title="Apply it to your checkout, on the branch it is on, once you have said yes to what it changes"
            onClick={() => {
              apply(false);
            }}
          >
            Apply
          </Button>
          <Button
            size="xs"
            variant="outline"
            className="text-foreground"
            type="button"
            disabled={busy}
            title={`Make player-two/${id.slice(0, 8)} from the commit it was made on, with it applied, and leave your branch and working tree as they are`}
            onClick={() => {
              apply(true);
            }}
          >
            Apply to a new branch
          </Button>
        </p>
      )}
    </>
  );
}
