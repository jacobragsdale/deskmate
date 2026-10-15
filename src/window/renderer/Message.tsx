/** One message in the open chat and what hangs off it: its author's edit and delete, its reactions, where each agent it tags stands, and its thread, with a box to reply in. Everything in it that someone else wrote is drawn as text. */

import { cn } from "cn";
import { ActivityIcon, ChevronDownIcon, EllipsisIcon, LinkIcon, PencilIcon, ReplyIcon, SmilePlusIcon, Trash2Icon } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";
import type { JSX, ReactNode, SyntheticEvent } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { spans } from "../../core/chat.ts";
import { noteLink, noteOf, notesIn } from "../../core/links.ts";
import { oneLine } from "../../core/text.ts";
import { MAX_DEPTH } from "../../core/delegation.ts";
import { isAgent, MODES, ownerOf } from "../../core/wire.ts";
import type { PermissionMode } from "../../core/wire.ts";
import { runOf } from "../../shared/ipc.ts";
import type { AskView, ChatView, CurrentView, MessageView, ReplyView, RequestView } from "../../shared/ipc.ts";
import { AskCard, Spinner } from "./Activity.tsx";
import type { Act } from "./App.tsx";

const LINE = "my-1 text-muted-foreground"; // Where a tagged agent stands, under the message.
const MINE = "my-1 text-warn"; // The same, when it waits on the user.
const COMMON = ["👍", "❤️", "😂", "🎉", "👀"] as const; // The emoji offered in one click; any other is typed.
const BEFORE = { "": "", declined: "you declined · ", failed: "it failed · ", stopped: "stopped · ", interrupted: "interrupted · " } as const; // What happened to a request the user can run again.

/** What a request line needs of the user's own runs beyond the request itself. */
export interface Runs {
  readonly kept: ReadonlySet<string>; // The runs, as `runOf` names them, whose activity the open chat holds.
  readonly asks: readonly AskView[]; // What they wait for the user to allow or refuse.
  readonly cannot: ChatView["cannot"]; // Why the agent that answers cannot be held to each mode, "" for each it can: the modes a request may be run at.
  readonly untested: boolean; // Whether the agent that answers is spoken to over ACP and its permissions were never tested.
  readonly asking: string; // Why the agent that answers cannot ask other agents in a run, "" when it can.
  readonly show: (run: string, who: string, asked: string) => void; // Open the activity panel on a run, headed with whose agent and what it was asked.
}

/** Seconds since an agent started, counted here so the main process need not say so every second. */
function Elapsed({ since }: { readonly since: number }): JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return (): void => {
      clearInterval(timer);
    };
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>;
}

/** How a request is run: at which mode, and whether the answer is posted without a review. */
type Choice = Extract<RequestView["status"], { kind: "ready" }>["offer"];

/** What each mode lets the agent do without asking, as the menu explains it, and the dialog that makes a grant. */
export const ACCESS: Record<PermissionMode, string> = {
  "read-only": "reads and searches, and changes nothing",
  supervised: "asks you before it changes a file or runs a command",
  "auto-edits": "changes files, and asks before it runs a command",
  full: "does anything without asking"
};

/** What the button that runs a request at a choice says. */
function runLabel(choice: Choice): string {
  return choice.post ? `▶▶ Run ${choice.mode} and post` : `▶ Run ${choice.mode}`;
}

/**
 * The menu of other ways to run a request: how the answer is delivered, and a run at each mode the agent that answers can be held to, saying why it cannot be held to the others.
 * `first` is whether the line has a first button beside it; when it does not, the menu's own button says what it is for, which is then its name. An agent over ACP whose permissions
 * were never tested is offered every mode it can keep, as one that passed is, and the menu says where to test it.
 * Each mode offered points a screen reader to the reasons, which it would otherwise pass over, as they are not items of the menu.
 */
function RunMenu({
  cannot,
  untested,
  first,
  offer,
  run
}: {
  readonly cannot: Runs["cannot"];
  readonly untested: boolean;
  readonly first: boolean;
  readonly offer: Choice;
  readonly run: (choice: Choice) => void;
}): JSX.Element {
  const [post, setPost] = useState(offer.post); // The delivery chosen here, for a run at a mode chosen here.
  const why = [...new Set(MODES.map((mode) => cannot[mode]).filter((reason) => reason !== ""))];
  const reasons = useId();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={first ? "icon-xs" : "xs"} variant="outline" className="text-foreground" type="button" aria-label={first ? "Choose how to run it" : undefined} title="Choose how to run it">
          {!first && "▶ Run…"}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto max-w-112">
        <DropdownMenuLabel>The answer</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={post ? "post" : "review"}
          onValueChange={(value) => {
            setPost(value === "post");
          }}
        >
          {/* Choosing how the answer is delivered keeps the menu open, for the mode to be chosen next. */}
          <DropdownMenuRadioItem value="review" onSelect={keepOpen}>
            Review it before it is posted
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="post" onSelect={keepOpen}>
            Post it directly
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Run it</DropdownMenuLabel>
        {MODES.filter((mode) => cannot[mode] === "").map((mode) => (
          <DropdownMenuItem
            key={mode}
            data-mode={mode}
            aria-describedby={reasons}
            onSelect={() => {
              run({ mode, post });
            }}
          >
            <span className="font-medium">{mode}</span>
            <span className="text-muted-foreground">{ACCESS[mode]}</span>
          </DropdownMenuItem>
        ))}
        <div id={reasons}>
          {why.map((reason) => (
            <DropdownMenuLabel key={reason} className="font-normal">
              {reason}.
            </DropdownMenuLabel>
          ))}
          {untested && <DropdownMenuLabel className="font-normal">Permissions not tested — Setup → Test permissions.</DropdownMenuLabel>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The switch that lets the agent ask other agents in the run, each of whose owners still decides, with what that means beside it; or, disabled, why it cannot.
 * What it asks is posted in the chat as it asks, whatever the delivery, and the desk keeps no session of such a run for a follow-up.
 */
function AskOthers({ on, why, set }: { readonly on: boolean; readonly why: string; readonly set: (on: boolean) => void }): JSX.Element {
  const id = useId();
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <Switch id={`${id}switch`} size="sm" checked={on} disabled={why !== ""} aria-describedby={`${id}note`} onCheckedChange={set} />
      <label htmlFor={`${id}switch`} className="text-foreground">
        Let this agent ask other agents
      </label>
      <span id={`${id}note`}>
        · {why === "" ? "each one's owner decides, and what it asks is posted in the chat as it asks, even when you review its answer; the run keeps no session to follow up in" : why}
      </span>
    </span>
  );
}

/** Why the user's agent cannot ask others in a run on a request: the agent that answers cannot, or the request came through as many agents as there may be. "" when it can. */
function askingWhy(runs: Runs, delegation: ReplyView["delegation"]): string {
  if (runs.asking !== "" || delegation === null || delegation.chain.length < MAX_DEPTH) {
    return runs.asking;
  }
  return `it came through ${String(MAX_DEPTH)} agents already, the most there may be, so it may ask no further`;
}

/**
 * One of the user's own agents, ready to run:a button that runs it as the user last ran that asker's requests of that repo, read-only with a review before they ever have,
 * unless the agent that answers cannot be held to that mode; the menu of other ways to run it; a button that declines it; and under them the switch that lets the agent ask others,
 * on at first only for a request of the user's own, as a run of their own tag from the window is let. Another agent's request says before the buttons how it came, in words.
 * A run carries `text`, the request as the user sees it here, so the desk can refuse one edited since.
 */
function ReadyLine({
  request,
  text,
  who,
  status,
  cannot,
  untested,
  own,
  asking,
  delegation,
  act,
  children
}: {
  readonly request: RequestView;
  readonly text: string;
  readonly who: string;
  readonly status: Extract<RequestView["status"], { kind: "ready" }>;
  readonly cannot: Runs["cannot"];
  readonly untested: boolean;
  readonly own: boolean; // Whether everyone the request runs on the say of is the user.
  readonly asking: string; // Why the agent cannot ask others in this run, "" when it can.
  readonly delegation: ReplyView["delegation"];
  readonly act: Act;
  readonly children: ReactNode; // What else the line offers: the activity of the run before, when there is one.
}): JSX.Element {
  const { id, repo } = request;
  const { offer } = status;
  const first = cannot[offer.mode] === "";
  const [delegate, setDelegate] = useState(own);
  const run = (choice: Choice): void => {
    act({ do: "run", id, repo, text, ...choice, delegate: asking === "" && delegate });
  };
  return (
    <div className={MINE}>
      <p>
        ◆ {BEFORE[status.before]}
        {delegation === null ? who : delegation.words} ·{" "}
        {first && (
          <>
            <Button
              size="xs"
              variant="outline"
              className="text-foreground"
              type="button"
              onClick={() => {
                run(offer);
              }}
            >
              {runLabel(offer)}
            </Button>{" "}
          </>
        )}
        <RunMenu cannot={cannot} untested={untested} first={first} offer={offer} run={run} />
        {status.canDecline && (
          <>
            {" "}
            <Button
              size="xs"
              variant="outline"
              className="text-foreground"
              type="button"
              onClick={() => {
                act({ do: "decline", id, repo });
              }}
            >
              × Decline
            </Button>
          </>
        )}
        {children}
      </p>
      <AskOthers on={asking === "" && delegate} why={asking} set={setDelegate} />
    </div>
  );
}

/** Keep a menu open when one of its items is chosen. */
function keepOpen(event: Event): void {
  event.preventDefault();
}

/** Opens the side panel on what the user's agent did, or is doing, on a request. */
function ShowActivity({ request, who, text, runs }: { readonly request: RequestView; readonly who: string; readonly text: string; readonly runs: Runs }): JSX.Element {
  return (
    <Button
      size="xs"
      variant="outline"
      className="text-foreground"
      type="button"
      onClick={() => {
        runs.show(runOf(request.id, request.repo), who, oneLine(text, 80));
      }}
    >
      <ActivityIcon /> Show activity
    </Button>
  );
}

/** Once a run of the user's has ended, what it did can still be looked at while the desk keeps it. */
function Kept({ request, who, text, runs }: { readonly request: RequestView; readonly who: string; readonly text: string; readonly runs: Runs }): JSX.Element | null {
  return request.mine && runs.kept.has(runOf(request.id, request.repo)) ? (
    <>
      {" "}
      · <ShowActivity request={request} who={who} text={text} runs={runs} />
    </>
  ) : null;
}

/** When a grant ends, as a person would say it after "until": the time when that is today, the day of the week within six days, or else the date. Hovering it gives the full date. */
export function Until({ expires }: { readonly expires: number }): JSX.Element {
  const end = new Date(expires * 1000);
  const days = Math.round((new Date(expires * 1000).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  let said = end.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (days === 0) {
    said = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } else if (days > 0 && days < 7) {
    said = end.toLocaleDateString(undefined, { weekday: "long" });
  }
  return (
    <time dateTime={end.toISOString()} title={end.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}>
      {said}
    </time>
  );
}

/** The short form of a commit, with the whole of it on hover. */
function Commit({ commit }: { readonly commit: string }): JSX.Element {
  return <code title={commit}>{commit.slice(0, 7)}</code>;
}

/** That a run went ahead under its owner's grant, `whose` ("your" or "bob's"), at a mode, and until when, when this desk holds the grant to say. */
function Granted({ whose, mode, expires }: { readonly whose: string; readonly mode: PermissionMode; readonly expires: number | null }): JSX.Element {
  return (
    <>
      under {whose} grant, {mode}
      {expires !== null && (
        <>
          , until <Until expires={expires} />
        </>
      )}
    </>
  );
}

/**
 * Where and how its owner let a run go ahead: " on" the branch, ± when the checkout had changes nobody had committed, " at" the commit, and the permission mode it may act at,
 * or, when a grant of theirs let it go, that grant with the mode, which everyone in the chat sees. Nothing when it never went ahead.
 */
function Ran({ accepted, whose }: { readonly accepted: RequestView["accepted"]; readonly whose: string }): JSX.Element | null {
  return accepted === null ? null : (
    <>
      {` on ${accepted.branch}${accepted.dirty ? " ±" : ""} at `}
      <Commit commit={accepted.commit} />
      {" · "}
      {accepted.grant === null ? accepted.mode : <Granted whose={whose} mode={accepted.mode} expires={accepted.grant.expires} />}
    </>
  );
}

/** Takes a request of the user's back, with `title` saying what that does beyond it. */
function Withdraw({ request, title, act, done }: { readonly request: RequestView; readonly title?: string; readonly act: Act; readonly done?: (ok: boolean) => void }): JSX.Element {
  const { id, owner, repo } = request;
  return (
    <>
      {" "}
      ·{" "}
      <Button
        size="xs"
        variant="outline"
        className="text-foreground"
        type="button"
        title={title}
        onClick={() => {
          act({ do: "withdraw", id, owner, repo }, done);
        }}
      >
        ↩ Withdraw
      </Button>
    </>
  );
}

/** A teammate's agent whose owner has not acted yet. Whoever asked can take the request back until they do. */
function WaitingLine({ request, away, asker, act }: { readonly request: RequestView; readonly away: boolean; readonly asker: boolean; readonly act: Act }): JSX.Element {
  return (
    <p className={LINE}>
      ◌ waiting for {request.owner} to approve{away ? " · they are away" : ""}
      {asker && <Withdraw request={request} act={act} />}
    </p>
  );
}

/**
 * A teammate's agent at work, and what their desk last said it is doing: one of job.progress's few words, once it has said. While its owner let it ask other agents, whoever asked has
 * one Withdraw that ends it and everything under it: the owner's desk stops it, and the end of its run takes back what it asked, each of whose desks stops in turn. Once taken back, the
 * line says so until that desk has stopped it, as the request is working until then.
 */
function WorkingLine({
  request,
  who,
  whose,
  summary,
  asker,
  act
}: {
  readonly request: RequestView;
  readonly who: string;
  readonly whose: string;
  readonly summary: string;
  readonly asker: boolean;
  readonly act: Act;
}): JSX.Element {
  const [taken, setTaken] = useState(false);
  return (
    <p className={LINE}>
      <Spinner /> {who} is {summary === "" ? "working" : summary}
      <Ran accepted={request.accepted} whose={whose} />
      {taken && ` · ↩ taken back, until ${request.owner}'s desk stops it`}
      {asker && !taken && request.accepted?.delegate === true && <Withdraw request={request} title={`Take it back: ${who} stops, and so does every agent asked under it`} act={act} done={setTaken} />}
    </p>
  );
}

/** What the line under a request says when it is only words: nothing anyone reading it can do about it here. */
const WORDS = {
  nobody: ({ owner }: RequestView) => `? nobody named ${owner} has joined`,
  lacksRepo: ({ owner, repo }: RequestView) => `? ${owner} has no checkout of ${repo}`,
  declined: ({ owner }: RequestView) => `× ${owner} declined`,
  withdrawn: () => "↩ the request was taken back",
  held: ({ repo }: RequestView) => `◆ you hold back your ${repo} agent, so it answers nobody · My agents lets it answer again`
} as const;

/** Whether the line under a request is only words. */
function wordsOnly(status: RequestView["status"]): status is Extract<RequestView["status"], { kind: keyof typeof WORDS }> {
  return Object.hasOwn(WORDS, status.kind);
}

/**
 * Where one agent a message tags, or another agent asks, stands, and what the reader can do about it. `text` is the message as shown; `asker` is whether the reader wrote it, and
 * so may take it back (an agent's request is its agent's to take back, never its owner's), `own` whether everyone it runs on the say of is the reader, and `delegation` where an
 * agent's request came from.
 */
function RequestLine({
  request,
  text,
  asker,
  own,
  delegation,
  runs,
  act
}: {
  readonly request: RequestView;
  readonly text: string;
  readonly asker: boolean;
  readonly own: boolean;
  readonly delegation: ReplyView["delegation"];
  readonly runs: Runs;
  readonly act: Act;
}): JSX.Element {
  const { id, owner, repo, status } = request;
  const whose = request.mine ? "your" : `${owner}'s`;
  const who = `${whose} ${repo} agent`;
  if (wordsOnly(status)) {
    return <p className={LINE}>{WORDS[status.kind](request)}</p>;
  }
  const activity = <Kept request={request} who={who} text={text} runs={runs} />;
  switch (status.kind) {
    case "drafted":
      return (
        <p className={MINE}>
          ✎ {who} has drafted an answer · it is below for you to review{activity}
        </p>
      );
    case "running":
      return (
        <>
          <p className={LINE}>
            <Spinner /> {who} is working
            <Ran accepted={request.accepted} whose={whose} /> · <Elapsed since={status.startedAt} /> · <ShowActivity request={request} who={who} text={text} runs={runs} />{" "}
            <Button
              size="xs"
              variant="outline"
              className="text-foreground"
              type="button"
              onClick={() => {
                act({ do: "stop", id, repo });
              }}
            >
              ■ Stop
            </Button>
          </p>
          {/* There before any card, so that a screen reader announces each card that comes. */}
          <div aria-live="polite">
            {runs.asks
              .filter((ask) => ask.run === runOf(id, repo))
              .map((ask) => (
                <AskCard key={ask.id} ask={ask} who={who} act={act} />
              ))}
          </div>
        </>
      );
    case "noCheckout":
      return (
        <p className={MINE}>
          ? you have no checkout of {repo} ·{" "}
          <Button
            size="xs"
            variant="outline"
            className="text-foreground"
            type="button"
            onClick={() => {
              act({ do: "clone", repo });
            }}
          >
            ⇣ Clone it
          </Button>
        </p>
      );
    case "ready":
      return (
        <ReadyLine
          request={request}
          text={text}
          who={who}
          status={status}
          cannot={runs.cannot}
          untested={runs.untested}
          own={own}
          asking={askingWhy(runs, delegation)}
          delegation={delegation}
          act={act}
        >
          {activity}
        </ReadyLine>
      );
    case "mayNotGo":
      // Nothing to run: the desk would refuse it, so the line says why in place of the buttons.
      return (
        <p className={LINE}>
          ◆ {BEFORE[status.before]}
          {delegation === null ? who : delegation.words} · it may no longer go: {status.reason}
          {activity}
        </p>
      );
    case "working":
      return <WorkingLine request={request} who={who} whose={whose} summary={status.summary} asker={asker} act={act} />;
    case "waiting":
      return <WaitingLine request={request} away={status.away} asker={asker} act={act} />;
    case "failed":
      return (
        <p className={LINE}>
          ✗ {who} failed
          <Ran accepted={request.accepted} whose={whose} />
        </p>
      );
    case "stopped":
      return (
        <p className={LINE}>
          ■ {who} was stopped
          <Ran accepted={request.accepted} whose={whose} />
        </p>
      );
  }
}

/** How each job in a tree stands, before its agent: a spinner while it works. */
const MARK = { waiting: "◌", answered: "✓", declined: "×", failed: "✗", stopped: "■", withdrawn: "↩" } as const;
const INDENT = ["", "pl-4", "pl-8"] as const; // A job's line, by how deep it is under the message.

/** Where one job in a tree stands, in words. */
function standing({ agent, state }: ReplyView["tree"][number], me: string): string {
  if (state === "waiting") {
    return ownerOf(agent) === me ? "waiting for you" : `waiting for ${ownerOf(agent)}`;
  }
  return state === "withdrawn" ? "taken back" : state;
}

/**
 * Under a message a person wrote, once an agent it tags has asked another, every job under it: one line each, indented by how deep it is, with its agent, where it stands and the mode its
 * owner let it run at. Once every one is done it folds to how many agents were involved, which opens it again. In a region there before it, so that a screen reader says what changes.
 */
function Tree({ message, me }: { readonly message: ReplyView; readonly me: string }): JSX.Element | null {
  if (message.agent !== null) {
    return null;
  }
  const { tree } = message;
  const lines = (
    <ul className="my-1 text-xs text-muted-foreground" aria-label="Agents asked under it">
      {tree.map((job) => (
        <li key={`${job.id} ${job.agent}`} className={INDENT[Math.min(job.depth, INDENT.length - 1)]} data-depth={job.depth}>
          {job.state === "working" ? <Spinner /> : MARK[job.state]} {agentWords(job.agent, me)} · {standing(job, me)}
          {job.mode === null ? "" : ` · ${job.mode}`}
        </li>
      ))}
    </ul>
  );
  const done = tree.every((job) => job.state !== "waiting" && job.state !== "working");
  return (
    <div aria-live="polite">
      {tree.length > 0 &&
        (done ? (
          <details className="my-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{new Set(tree.map((job) => job.agent)).size} agents involved</summary>
            {lines}
          </details>
        ) : (
          lines
        ))}
    </div>
  );
}

/** "(edited)", after the text of a message its author has changed. */
function Edited({ message }: { readonly message: ReplyView }): JSX.Element | null {
  return message.edited ? <span className="text-xs text-muted-foreground"> (edited)</span> : null;
}

/**
 * A link to a note, drawn as a chip of text: who wrote the note and its first words once the desk has looked it up, who wrote it and where when its chat is not loaded, or that the reader cannot see it.
 * Clicking it has the desk open the note; nothing in it is followed as an address or run.
 */
function NoteChip({ id, notes, act }: { readonly id: string; readonly notes: ReplyView["notes"]; readonly act: Act }): JSX.Element {
  const note = notes.find((each) => each.id === id);
  let label = "a note…"; // Still being looked up.
  if (note?.state === "seen") {
    label = `${note.author}: ${note.words}`;
  } else if (note?.state === "elsewhere") {
    label = `${note.author} in ${note.chat}`;
  } else if (note?.state === "hidden") {
    label = "a note you cannot see";
  }
  return (
    <button
      type="button"
      className="mx-0.5 inline-block max-w-80 cursor-pointer truncate rounded-md border bg-muted px-1.5 align-bottom text-xs hover:bg-accent"
      title={noteLink(id)}
      data-note={id}
      onClick={() => {
        act({ do: "openNote", id });
      }}
    >
      {label}
    </button>
  );
}

/** A node of a Markdown tree, as far as finding links to notes in its text needs to know it. */
interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly children?: MarkdownNode[];
}

/** A remark plugin: each link to a note written out in plain text becomes a link, so that it is drawn as a chip as one written [like this](…) is. Code, and the text of a link, are left as they are. */
function linkNotes(): (tree: MarkdownNode) => void {
  const visit = (node: MarkdownNode): void => {
    const children = node.type === "link" || node.type === "linkReference" ? [] : (node.children ?? []);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      const pieces = child?.type === "text" ? notesIn(child.value ?? "") : [];
      if (pieces.some((piece) => piece.note !== null)) {
        children.splice(
          index,
          1,
          ...pieces.map((piece): MarkdownNode => (piece.note === null ? { type: "text", value: piece.text } : { type: "link", url: piece.text, children: [{ type: "text", value: piece.text }] }))
        );
      } else if (child !== undefined) {
        visit(child);
      }
    }
  };
  return visit;
}

/** Whose agent that is, as the reader says it: "your uploader agent", or "jacob's uploader agent". */
function agentWords(agent: string, me: string): string {
  const owner = ownerOf(agent);
  return `${owner === me ? "your" : `${owner}'s`} ${agent.slice(owner.length + 1)} agent`;
}

/** An agent's request of another, as it reads in the chat: "jacob's uploader agent asked @bob/billing: …", drawn as text. */
function Asked({ message, delegation, me }: { readonly message: ReplyView; readonly delegation: NonNullable<ReplyView["delegation"]>; readonly me: string }): JSX.Element {
  return (
    <p className="wrap-anywhere whitespace-pre-wrap">
      {agentWords(`${message.sender}/${message.agent ?? ""}`, me)} asked <span className="font-semibold text-tag">@{delegation.target}</span>: {message.body}
    </p>
  );
}

function Body({ message, me, act }: { readonly message: ReplyView; readonly me: string; readonly act: Act }): JSX.Element {
  if (message.delegation !== null) {
    return <Asked message={message} delegation={message.delegation} me={me} />;
  }
  if (message.deleted) {
    return <p className="text-muted-foreground italic">message deleted</p>;
  }
  if (message.agent !== null || message.body.includes("```")) {
    // Markdown from an agent is drawn as elements, never as HTML: raw tags in it stay text. Images are not fetched: a remote one would tell its host who read the message.
    // A link to a note is a chip; every other link is as safe as react-markdown's own rule makes it, which drops a player-two: address like any it does not know.
    return (
      <div className="markdown">
        <Markdown
          remarkPlugins={[linkNotes]}
          urlTransform={(url) => (noteOf(url) === null ? defaultUrlTransform(url) : url)}
          components={{
            a: ({ href, children }) => {
              const note = noteOf(href ?? "");
              return note === null ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ) : (
                <NoteChip id={note} notes={message.notes} act={act} />
              );
            },
            img: ({ alt, src }) => (
              <span className="text-muted-foreground">
                [image{alt === undefined || alt === "" ? "" : `: ${alt}`}] {typeof src === "string" ? src : ""}
              </span>
            )
          }}
        >
          {message.body}
        </Markdown>
        <Edited message={message} />
      </div>
    );
  }
  return (
    <p className="wrap-anywhere whitespace-pre-wrap">
      {/* The pieces of one message never reorder, so their position is a stable key. */}
      {notesIn(message.body).map((piece, at) =>
        piece.note === null ? (
          <Fragment key={at}>
            {spans(piece.text).map((span, index) => (
              <span key={index} className={span.tag ? "font-semibold text-tag" : undefined}>
                {span.text}
              </span>
            ))}
          </Fragment>
        ) : (
          <NoteChip key={at} id={piece.note} notes={message.notes} act={act} />
        )
      )}
      <Edited message={message} />
    </p>
  );
}

/** One of the user's own messages being changed, in place of its text. Enter saves and Esc gives up; the agents it tagged stay those it was sent with. */
function EditBox({ message, act, onDone }: { readonly message: ReplyView; readonly act: Act; readonly onDone: () => void }): JSX.Element {
  const [text, setText] = useState(message.body);
  const save = (): void => {
    const said = text.trim();
    if (said === message.body.trim()) {
      onDone();
    } else if (said !== "") {
      act({ do: "edit", id: message.id, text: said }, (ok) => {
        if (ok) {
          onDone();
        }
      });
    }
  };
  return (
    <div className="my-1">
      <Textarea
        autoFocus
        className="min-h-0 resize-none field-sizing-fixed"
        aria-label="Edit message"
        rows={Math.min(8, text.split("\n").length)}
        value={text}
        onFocus={(event) => {
          event.currentTarget.setSelectionRange(text.length, text.length);
        }}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            onDone();
          }
        }}
      />
      <p className="mt-0.5 text-xs text-muted-foreground">Enter saves · Esc cancels · the agents it tagged stay as they were</p>
    </div>
  );
}

/** A field for any emoji at all, beside the common few. What is typed is sent as text and drawn as text. */
function AnyEmoji({ react }: { readonly react: (emoji: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const pick = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const emoji = new FormData(event.currentTarget).get("emoji");
    if (typeof emoji === "string" && emoji.trim() !== "") {
      react(emoji.trim());
    }
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-xs" variant="ghost" type="button" aria-label="React with another emoji" title="React with another emoji">
          <SmilePlusIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <form className="flex gap-1.5" onSubmit={pick}>
          <Input name="emoji" aria-label="Emoji" placeholder="any emoji" maxLength={32} required autoFocus />
          <Button type="submit" size="sm">
            React
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** What only a message's author can do to it. */
interface Own {
  readonly edit: () => void;
  readonly remove: () => void;
}

/** Put a message's link on the clipboard, for pasting into another message or an agent's prompt. */
function copyLink(id: string): void {
  navigator.clipboard.writeText(noteLink(id)).then(
    () => {
      toast("Link copied.");
    },
    (error: unknown) => {
      toast.error("could not copy the link", { description: error instanceof Error ? error.message : String(error) });
    }
  );
}

/** The menu of what anyone can do with a message, copy its link, and of what only its author can do. It gives the focus back to nobody when it closes, so that the edit box keeps it. */
function MessageMenu({ id, own }: { readonly id: string; readonly own: Own | null }): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="ghost" type="button" aria-label="More" title="More">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            copyLink(id);
          }}
        >
          <LinkIcon /> Copy link
        </DropdownMenuItem>
        {own !== null && (
          <>
            <DropdownMenuItem onSelect={own.edit}>
              <PencilIcon /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={own.remove}>
              <Trash2Icon /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the user can do to a message, shown while the pointer is over it or the keyboard is in it: react, reply to one at the top of the chat, copy its link, and edit or delete their own. */
function Actions({ id, react, onReply, own }: { readonly id: string; readonly react: (emoji: string) => void; readonly onReply: (() => void) | null; readonly own: Own | null }): JSX.Element {
  return (
    <div className="absolute top-0 right-0 flex gap-0.5 rounded-md border bg-background p-0.5 opacity-0 shadow-xs group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
      {COMMON.map((emoji) => (
        <Button
          key={emoji}
          size="icon-xs"
          variant="ghost"
          type="button"
          aria-label={`React with ${emoji}`}
          onClick={() => {
            react(emoji);
          }}
        >
          {emoji}
        </Button>
      ))}
      <AnyEmoji react={react} />
      {onReply !== null && (
        <Button size="icon-xs" variant="ghost" type="button" aria-label="Reply" title="Reply" onClick={onReply}>
          <ReplyIcon />
        </Button>
      )}
      <MessageMenu id={id} own={own} />
    </div>
  );
}

/** Each emoji used on a message, with how many used it and, on hover, who. One the user used is pressed, and clicking it takes it back; clicking another adds theirs. */
function Reactions({ message, me, react }: { readonly message: ReplyView; readonly me: string; readonly react: (emoji: string) => void }): JSX.Element | null {
  if (message.reactions.length === 0) {
    return null;
  }
  return (
    <div className="my-0.5 flex flex-wrap gap-1">
      {message.reactions.map(({ emoji, people }) => {
        const names = people.map((person) => (person === me ? "you" : person)).join(", ");
        return (
          <Tooltip key={emoji}>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant={people.includes(me) ? "secondary" : "outline"}
                type="button"
                aria-pressed={people.includes(me)}
                aria-label={`${emoji} ${String(people.length)}: ${names}`}
                onClick={() => {
                  react(emoji);
                }}
              >
                {emoji} {people.length}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{names}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Who wrote a message, and when; for an agent's answer, which agent, the branch and commit its owner let it run on, the grant of theirs it ran under, if one let it, and "not reviewed"
 * when the agent signed it itself: posted with nobody reading it first. One its owner reviewed and sent is signed by them, and says nothing more.
 */
function Header({ message, me }: { readonly message: ReplyView; readonly me: string }): JSX.Element {
  const when = new Date(message.ts * 1000);
  return (
    <header className="mt-2.5 flex items-baseline gap-1.5">
      <strong className={cn(message.agent !== null && "text-agent")}>{message.sender === me ? "you" : message.sender}</strong>
      {message.agent !== null && (
        <span className="text-xs text-muted-foreground">
          /{message.agent} agent{message.branch === "" ? "" : ` on ${message.branch}`}
          {message.commit !== "" && (
            <>
              {" at "}
              <Commit commit={message.commit} />
            </>
          )}
          {message.grant !== null && (
            <>
              {" · ran "}
              <Granted whose={message.sender === me ? "your" : `${message.sender}'s`} mode={message.grant.mode} expires={message.grant.expires} />
            </>
          )}
          {isAgent(message.signer) && (
            <>
              {" · "}
              <span className="text-warn" title={`Posted by ${message.signer} itself, signed with its own key, before anyone read it`}>
                not reviewed
              </span>
            </>
          )}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <time className="text-xs text-muted-foreground" dateTime={when.toISOString()}>
            {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </time>
        </TooltipTrigger>
        <TooltipContent>{when.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" })}</TooltipContent>
      </Tooltip>
    </header>
  );
}

/** One message or answer. `onReply` opens its thread; null for a reply, which is in its thread already. `focused` highlights the one the user opened a link to. */
function Said({
  message,
  me,
  runs,
  act,
  onReply,
  focused
}: {
  readonly message: ReplyView;
  readonly me: string;
  readonly runs: Runs;
  readonly act: Act;
  readonly onReply: (() => void) | null;
  readonly focused: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  // Only the author's own word counts for an edit or a delete, and never on an agent's answer, so nobody else is offered either.
  const own: Own | null =
    message.sender === me && message.agent === null && !message.deleted
      ? {
          edit: () => {
            setEditing(true);
          },
          remove: () => {
            act({ do: "delete", id: message.id });
          }
        }
      : null;
  // Whether everyone its requests run on the say of is the user: a message of theirs, or an agent's request they asked first, through agents of their own alone.
  const myOwn = message.delegation === null ? message.sender === me : [message.delegation.first, ...message.delegation.chain.map(ownerOf)].every((person) => person === me);
  // Using an emoji the user has already used on this message takes it back.
  const react = (emoji: string): void => {
    act({ do: "react", id: message.id, emoji, on: !message.reactions.some((each) => each.emoji === emoji && each.people.includes(me)) });
  };
  if (!message.trusted) {
    return <p className="my-2 text-destructive">✗ a message claiming to be from {message.sender} failed its signature check and is hidden</p>;
  }
  return (
    <article
      data-id={message.id}
      data-focused={focused}
      className={cn("group relative", message.agent !== null && "mt-1 border-l-3 border-agent pl-2.5", focused && "rounded-md bg-tag/10 ring-1 ring-tag/40")}
    >
      {message.header && <Header message={message} me={me} />}
      {message.quote !== "" && <p className="my-0.5 truncate border-l-3 pl-2 text-muted-foreground">{message.quote}</p>}
      {editing ? (
        <EditBox
          message={message}
          act={act}
          onDone={() => {
            setEditing(false);
          }}
        />
      ) : (
        <Body message={message} me={me} act={act} />
      )}
      <Reactions message={message} me={me} react={react} />
      {message.requests.map((request) => (
        <RequestLine
          key={`${request.owner}/${request.repo}`}
          request={request}
          text={message.body}
          asker={message.sender === me && message.delegation === null}
          own={myOwn}
          delegation={message.delegation}
          runs={runs}
          act={act}
        />
      ))}
      <Tree message={message} me={me} />
      {!message.deleted && !editing && <Actions id={message.id} react={react} onReply={onReply} own={own} />}
    </article>
  );
}

/** The box at the foot of an open thread. Enter sends, and a reply that could not be sent comes back into it. */
function ReplyBox({ root, act, onClose }: { readonly root: string; readonly act: Act; readonly onClose: () => void }): JSX.Element {
  const [text, setText] = useState("");
  const send = (): void => {
    const said = text.trim();
    if (said === "") {
      return;
    }
    setText("");
    act({ do: "reply", root, text: said }, (ok) => {
      if (!ok) {
        setText((now) => (now === "" ? said : now));
      }
    });
  };
  return (
    <Textarea
      autoFocus
      className="mt-1 min-h-0 resize-none field-sizing-fixed"
      aria-label="Reply"
      placeholder="Reply · @ tags an agent · Enter sends, Esc closes"
      rows={Math.min(6, text.split("\n").length)}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send();
        } else if (event.key === "Escape") {
          onClose();
        }
      }}
    />
  );
}

/**
 * A message at the top of the chat, and under it its thread: how many replies and the last one, and what the user's agents ask about requests in them, while it is closed,
 * and every reply with a box to add one while it is open.
 * `focus` is the message the user opened a link to, which is highlighted; when it is a reply here, the thread opens.
 */
export function Message({
  message,
  me,
  runs,
  act,
  focus
}: {
  readonly message: MessageView;
  readonly me: string;
  readonly runs: Runs;
  readonly act: Act;
  readonly focus: CurrentView["focus"];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(0); // The `nth` of the last link to a reply here, which opened the thread.
  // In this render, so that the reply is there for the chat to scroll to when it looks for it.
  if (focus !== null && focus.nth !== opened && message.replies.some((reply) => reply.id === focus.id)) {
    setOpened(focus.nth);
    setOpen(true);
  }
  const last = message.replies.at(-1);
  const close = (): void => {
    setOpen(false);
  };
  // While the thread is closed, what the user's agent asks about a request in a reply is under its summary: the run waits for the answer, and the card must stay in reach.
  const asked = open
    ? []
    : message.replies.flatMap((reply) =>
        reply.requests.flatMap((request) => runs.asks.filter((ask) => ask.run === runOf(reply.id, request.repo)).map((ask) => ({ ask, who: `your ${request.repo} agent` })))
      );
  return (
    <>
      <Said
        message={message}
        me={me}
        runs={runs}
        act={act}
        focused={focus?.id === message.id}
        onReply={
          message.trusted
            ? () => {
                setOpen(true);
              }
            : null
        }
      />
      {!open && last !== undefined && (
        <>
          <p className="my-0.5 truncate text-xs">
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-tag"
              type="button"
              onClick={() => {
                setOpen(true);
              }}
            >
              {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
            </Button>
            <span className="text-muted-foreground">
              {" "}
              · last from {last.sender === me ? "you" : last.sender}: {last.deleted ? "message deleted" : oneLine(last.body, 80)}
            </span>
          </p>
          <div aria-live="polite">
            {asked.map(({ ask, who }) => (
              <AskCard key={ask.id} ask={ask} who={who} act={act} />
            ))}
          </div>
        </>
      )}
      {open && (
        <section className="my-1 ml-3 border-l-2 pl-3" aria-label="Thread">
          {message.replies.map((reply) => (
            <Said key={reply.id} message={reply} me={me} runs={runs} act={act} onReply={null} focused={focus?.id === reply.id} />
          ))}
          <ReplyBox root={message.id} act={act} onClose={close} />
          <Button variant="link" size="xs" className="h-auto p-0 text-muted-foreground" type="button" onClick={close}>
            Hide replies
          </Button>
        </section>
      )}
    </>
  );
}
