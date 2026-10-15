/** One message in the open chat and what hangs off it: its author's edit and delete, its reactions, where each agent it tags stands, and its thread, with a box to reply in. Everything in it that someone else wrote is drawn as text. */

import { cn } from "cn";
import { ActivityIcon, ChevronDownIcon, EllipsisIcon, LinkIcon, PencilIcon, ReplyIcon, SmilePlusIcon, Trash2Icon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { spans } from "../../core/chat.ts";
import { noteLink, noteOf, notesIn } from "../../core/links.ts";
import { oneLine } from "../../core/text.ts";
import { MODES } from "../../core/wire.ts";
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

/** What each mode lets the agent do without asking, as the menu explains it. */
const ACCESS: Record<PermissionMode, string> = {
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
 * `first` is whether the line has a first button beside it; when it does not, the menu's own button says what it is for.
 */
function RunMenu({ cannot, first, offer, run }: { readonly cannot: Runs["cannot"]; readonly first: boolean; readonly offer: Choice; readonly run: (choice: Choice) => void }): JSX.Element {
  const [post, setPost] = useState(offer.post); // The delivery chosen here, for a run at a mode chosen here.
  const why = [...new Set(MODES.map((mode) => cannot[mode]).filter((reason) => reason !== ""))];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={first ? "icon-xs" : "xs"} variant="outline" className="text-foreground" type="button" aria-label="Choose how to run it" title="Choose how to run it">
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
            onSelect={() => {
              run({ mode, post });
            }}
          >
            <span className="font-medium">{mode}</span>
            <span className="text-muted-foreground">{ACCESS[mode]}</span>
          </DropdownMenuItem>
        ))}
        {why.map((reason) => (
          <DropdownMenuLabel key={reason} className="font-normal">
            {reason}.
          </DropdownMenuLabel>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One of the user's own agents, ready to run: a button that runs it as the user last ran that asker's requests of that repo, read-only with a review before they ever have,
 * unless the agent that answers cannot be held to that mode; the menu of other ways to run it; and a button that declines it.
 * A run carries `text`, the request as the user sees it here, so the desk can refuse one edited since.
 */
function ReadyLine({
  request,
  text,
  who,
  status,
  cannot,
  act,
  children
}: {
  readonly request: RequestView;
  readonly text: string;
  readonly who: string;
  readonly status: Extract<RequestView["status"], { kind: "ready" }>;
  readonly cannot: Runs["cannot"];
  readonly act: Act;
  readonly children: ReactNode; // What else the line offers: the activity of the run before, when there is one.
}): JSX.Element {
  const { id, repo } = request;
  const { offer } = status;
  const first = cannot[offer.mode] === "";
  const run = (choice: Choice): void => {
    act({ do: "run", id, repo, text, ...choice });
  };
  return (
    <p className={MINE}>
      ◆ {BEFORE[status.before]}
      {who} ·{" "}
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
      <RunMenu cannot={cannot} first={first} offer={offer} run={run} />
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

/** The short form of a commit, with the whole of it on hover. */
function Commit({ commit }: { readonly commit: string }): JSX.Element {
  return <code title={commit}>{commit.slice(0, 7)}</code>;
}

/**
 * Where and how its owner let a run go ahead: " on" the branch, ± when the checkout had changes nobody had committed, " at" the commit, and the permission mode it may act at,
 * which everyone in the chat sees. Nothing when they never did.
 */
function Ran({ accepted }: { readonly accepted: RequestView["accepted"] }): JSX.Element | null {
  return accepted === null ? null : (
    <>
      {` on ${accepted.branch}${accepted.dirty ? " ±" : ""} at `}
      <Commit commit={accepted.commit} />
      {` · ${accepted.mode}`}
    </>
  );
}

/** A teammate's agent whose owner has not acted yet. Whoever asked can take the request back until they do. */
function WaitingLine({ request, away, asker, act }: { readonly request: RequestView; readonly away: boolean; readonly asker: boolean; readonly act: Act }): JSX.Element {
  const { id, owner, repo } = request;
  return (
    <p className={LINE}>
      ◌ waiting for {owner} to approve{away ? " · they are away" : ""}
      {asker && (
        <>
          {" "}
          ·{" "}
          <Button
            size="xs"
            variant="outline"
            className="text-foreground"
            type="button"
            onClick={() => {
              act({ do: "withdraw", id, owner, repo });
            }}
          >
            ↩ Withdraw
          </Button>
        </>
      )}
    </p>
  );
}

/** Where one agent a message tags stands, and what the reader can do about it. `text` is the message as shown; `asker` is whether the reader wrote it. */
function RequestLine({ request, text, asker, runs, act }: { readonly request: RequestView; readonly text: string; readonly asker: boolean; readonly runs: Runs; readonly act: Act }): JSX.Element {
  const { id, owner, repo, status } = request;
  const who = request.mine ? `your ${repo} agent` : `${owner}'s ${repo} agent`;
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
            <Ran accepted={request.accepted} /> · <Elapsed since={status.startedAt} /> · <ShowActivity request={request} who={who} text={text} runs={runs} />{" "}
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
          {runs.asks
            .filter((ask) => ask.run === runOf(id, repo))
            .map((ask) => (
              <AskCard key={ask.id} ask={ask} who={who} act={act} />
            ))}
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
        <ReadyLine request={request} text={text} who={who} status={status} cannot={runs.cannot} act={act}>
          {activity}
        </ReadyLine>
      );
    case "working":
      // What its owner's desk last said it is doing, in job.progress's few words, once it has said.
      return (
        <p className={LINE}>
          <Spinner /> {who} is {status.summary === "" ? "working" : status.summary}
          <Ran accepted={request.accepted} />
        </p>
      );
    case "waiting":
      return <WaitingLine request={request} away={status.away} asker={asker} act={act} />;
    case "nobody":
      return <p className={LINE}>? nobody named {owner} has joined</p>;
    case "lacksRepo":
      return (
        <p className={LINE}>
          ? {owner} has no checkout of {repo}
        </p>
      );
    case "declined":
      return <p className={LINE}>× {owner} declined</p>;
    case "failed":
      return (
        <p className={LINE}>
          ✗ {who} failed
          <Ran accepted={request.accepted} />
        </p>
      );
    case "stopped":
      return (
        <p className={LINE}>
          ■ {who} was stopped
          <Ran accepted={request.accepted} />
        </p>
      );
    case "withdrawn":
      return <p className={LINE}>↩ the request was taken back</p>;
  }
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

function Body({ message, act }: { readonly message: ReplyView; readonly act: Act }): JSX.Element {
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

/** Who wrote a message, and when; for an agent's answer, which agent, and the branch and commit its owner let it run on. */
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
        <Body message={message} act={act} />
      )}
      <Reactions message={message} me={me} react={react} />
      {message.requests.map((request) => (
        <RequestLine key={`${request.owner}/${request.repo}`} request={request} text={message.body} asker={message.sender === me} runs={runs} act={act} />
      ))}
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
      )}
      {asked.map(({ ask, who }) => (
        <AskCard key={ask.id} ask={ask} who={who} act={act} />
      ))}
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
