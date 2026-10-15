/** A patch as a card: its title, the files it changes with the lines each adds and removes, and each file's diff folded, all read by diff.ts and drawn as text. */

import { Fragment, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";

import { parseDiff } from "../../core/diff.ts";
import type { DiffFile } from "../../core/diff.ts";
import type { PatchView } from "../../shared/ipc.ts";

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
