/**
 * Azure DevOps in the chat: a pull request a message refers to, as a chip, and in a branch room the branch's pull request and build. Every word of them is someone else's and drawn as
 * text; an address opens in the browser only on dev.azure.com.
 */

import { cn } from "cn";
import { useEffect, useId, useState } from "react";
import type { JSX, SyntheticEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { azureWeb, buildWords, votes } from "../../core/pulls.ts";
import { outcomeSchema, PULL_DESCRIPTION, PULL_TITLE } from "../../shared/ipc.ts";
import type { Command, CurrentView, Form, PullRequest } from "../../shared/ipc.ts";
import { FIELD } from "./Agents.tsx";
import type { Act } from "./App.tsx";
import { Modal } from "./dialogs.tsx";

const CHIP = "mx-0.5 inline-block max-w-80 truncate rounded-md border bg-muted px-1.5 align-bottom text-xs";

/** A pull request in a few words: its number and title, its status, whether it is a draft, and how its reviewers voted. */
export function pullWords(pull: PullRequest): string {
  const voted = votes(pull.reviewers);
  return [`!${String(pull.id)} ${pull.title}`, pull.status, ...(pull.draft ? ["draft"] : []), ...(voted === "" ? [] : [voted])].join(" · ");
}

/** A link to an address on Azure DevOps, which the main process opens in the browser; the same words as text, opening nothing, for an address anywhere else. */
export function AzureLink({ web, className, title, children }: { readonly web: string; readonly className?: string; readonly title?: string; readonly children: string }): JSX.Element {
  const href = azureWeb(web);
  return href === null ? (
    <span className={className} title={title}>
      {children}
    </span>
  ) : (
    <a className={className} href={href} target="_blank" rel="noreferrer" title={title}>
      {children}
    </a>
  );
}

/** A pull request a message refers to, drawn as a chip of text, which opens it in the browser. */
export function PullChip({ pull }: { readonly pull: PullRequest }): JSX.Element {
  return (
    <span data-pull={pull.id}>
      <AzureLink web={pull.web} className={cn(CHIP, "hover:bg-accent")} title={`${pull.creator}'s pull request from ${pull.source} into ${pull.target}`}>
        {pullWords(pull)}
      </AzureLink>
    </span>
  );
}

type From = Extract<Command, { do: "pullForm" }>["from"];

/**
 * The dialog that opens a pull request from `from`: the desk fills in its title and description from the branch's commits and names the branch it goes into, and says here why it
 * cannot when it cannot. Open has the desk push the branch first, once the user has said yes in a dialog of the system's own, when origin lacks it; it closes once the desk is done.
 */
function OpenPull({ from, act, onDone }: { readonly from: From; readonly act: Act; readonly onDone: () => void }): JSX.Element {
  const [form, setForm] = useState<Form | string>("Reading the branch…"); // The form, or what to say in its place.
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  // Asked once, as the dialog opens: what it is about does not change while it is open, though each view draws `from` afresh.
  useEffect(() => {
    window.playerTwo
      .command({ do: "pullForm", from })
      .then((raw) => {
        const outcome = outcomeSchema.parse(raw);
        setForm(outcome.ok ? (outcome.form ?? "the desk said nothing of the branch") : outcome.problem);
      })
      .catch(console.error);
  }, []);
  const open = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = (name: string): string => {
      const value = new FormData(event.currentTarget).get(name);
      return typeof value === "string" ? value : "";
    };
    setBusy(true);
    act({ do: "openPull", from, title: field("title").trim(), description: field("description"), draft }, (ok) => {
      setBusy(false);
      if (ok) {
        onDone();
      }
    });
  };
  return (
    <Modal title="Open a pull request" className="sm:max-w-lg" onDismiss={onDone}>
      {typeof form === "string" ? (
        <p className="text-muted-foreground" data-pull-form>
          {form}
        </p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={open} data-pull-form>
          <p className="text-muted-foreground">
            From {form.branch} into {form.target}, in {form.repo}
          </p>
          {form.behind && <p>Origin&rsquo;s {form.branch} has commits yours lacks: the pull request is opened from origin&rsquo;s, and holds them too.</p>}
          <Label className={FIELD}>
            Title
            <Input className="font-normal" name="title" defaultValue={form.title} maxLength={PULL_TITLE} required autoFocus />
          </Label>
          <Label className={FIELD}>
            Description
            <Textarea className="font-normal" name="description" defaultValue={form.description} maxLength={PULL_DESCRIPTION} rows={4} />
          </Label>
          <p className="flex items-center gap-2">
            <Switch id={`${id}draft`} checked={draft} onCheckedChange={setDraft} />
            <label htmlFor={`${id}draft`}>Draft</label>
          </p>
          <Button type="submit" className="self-start" disabled={busy}>
            {busy ? "Opening…" : "Open pull request"}
          </Button>
        </form>
      )}
    </Modal>
  );
}

/** A button that opens the dialog for a pull request from `from`. */
export function PullButton({ from, act, children }: { readonly from: From; readonly act: Act; readonly children: string }): JSX.Element {
  const [opening, setOpening] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        className="text-foreground"
        type="button"
        onClick={() => {
          setOpening(true);
        }}
      >
        {children}
      </Button>
      {opening && (
        <OpenPull
          from={from}
          act={act}
          onDone={() => {
            setOpening(false);
          }}
        />
      )}
    </>
  );
}

/**
 * In a branch room whose repo is on Azure DevOps, the branch's pull request and its latest build, each a link, as the desk last found them, or why it could not find each; and with no
 * pull request, for a user with a checkout of the repo, "Create one". While the pull request cannot be looked up the build is not asked, and the line says only why.
 */
export function RoomLine({
  azure,
  chat,
  mine,
  act
}: {
  readonly azure: NonNullable<CurrentView["pinned"]>["azure"];
  readonly chat: string;
  readonly mine: boolean;
  readonly act: Act;
}): JSX.Element | null {
  if (azure === null) {
    return null;
  }
  const { pull, build } = azure;
  return (
    <p className="border-b px-4 py-1.5 text-muted-foreground" data-room-azure>
      {pull.ok ? (
        <>
          {pull.data === null ? (
            <>
              No pull request
              {mine && (
                <>
                  {" · "}
                  <PullButton from={{ room: chat }} act={act}>
                    Create one
                  </PullButton>
                </>
              )}
            </>
          ) : (
            <AzureLink web={pull.data.web} className="underline-offset-2 hover:underline">
              {pullWords(pull.data)}
            </AzureLink>
          )}
          {" · "}
          {!build.ok && `build: ${build.problem}`}
          {build.ok && build.data === null && "no build yet"}
          {build.ok && build.data !== null && (
            <AzureLink web={build.data.web} className={cn("underline-offset-2 hover:underline", build.data.result === "failed" && "text-destructive")}>
              {buildWords(build.data)}
            </AzureLink>
          )}
        </>
      ) : (
        `Azure DevOps: ${pull.problem}`
      )}
    </p>
  );
}
