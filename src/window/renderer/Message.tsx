/** One message in the open chat and what hangs off it: its author's edit and delete, its reactions, where each agent it tags stands, and its thread, with a box to reply in. Everything in it that someone else wrote is drawn as text. */

import { cn } from "cn";
import { EllipsisIcon, Loader2Icon, PencilIcon, ReplyIcon, SmilePlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type { JSX, SyntheticEvent } from "react";
import Markdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { spans } from "../../core/chat.ts";
import { oneLine } from "../../core/text.ts";
import type { MessageView, ReplyView, RequestView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const LINE = "my-1 text-muted-foreground"; // Where a tagged agent stands, under the message.
const MINE = "my-1 text-warn"; // The same, when it waits on the user.
const COMMON = ["👍", "❤️", "😂", "🎉", "👀"] as const; // The emoji offered in one click; any other is typed.
const BEFORE = { "": "", declined: "you declined · ", failed: "it failed · ", stopped: "stopped · ", interrupted: "interrupted · " } as const; // What happened to a request the user can run again.

/** An agent at work. */
function Spinner(): JSX.Element {
  return <Loader2Icon aria-hidden className="inline size-3.5 align-[-2px] motion-safe:animate-spin" />;
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

/** One of the user's own agents, ready to run: the buttons that run it, and one that declines it. */
function ReadyLine({
  request,
  who,
  before,
  canDecline,
  act
}: {
  readonly request: RequestView;
  readonly who: string;
  readonly before: keyof typeof BEFORE;
  readonly canDecline: boolean;
  readonly act: Act;
}): JSX.Element {
  const { id, repo } = request;
  return (
    <p className={MINE}>
      ◆ {BEFORE[before]}
      {who} ·{" "}
      <Button
        size="xs"
        variant="outline"
        className="text-foreground"
        type="button"
        onClick={() => {
          act({ do: "run", id, repo, post: false });
        }}
      >
        ▶ Run and review
      </Button>{" "}
      <Button
        size="xs"
        variant="outline"
        className="text-foreground"
        type="button"
        onClick={() => {
          act({ do: "run", id, repo, post: true });
        }}
      >
        ▶▶ Run and post
      </Button>
      {canDecline && (
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
    </p>
  );
}

/** The short form of a commit, with the whole of it on hover. */
function Commit({ commit }: { readonly commit: string }): JSX.Element {
  return <code title={commit}>{commit.slice(0, 7)}</code>;
}

/** Where its owner let a run go ahead: " on" the branch, ± when the checkout had changes nobody had committed, and " at" the commit. Nothing when they never did. */
function Ran({ accepted }: { readonly accepted: RequestView["accepted"] }): JSX.Element | null {
  return accepted === null ? null : (
    <>
      {` on ${accepted.branch}${accepted.dirty ? " ±" : ""} at `}
      <Commit commit={accepted.commit} />
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

/** Where one agent a message tags stands, and what the reader can do about it. `asker` is whether the reader wrote the message. */
function RequestLine({ request, asker, act }: { readonly request: RequestView; readonly asker: boolean; readonly act: Act }): JSX.Element {
  const { id, owner, repo, status } = request;
  const who = request.mine ? `your ${repo} agent` : `${owner}'s ${repo} agent`;
  switch (status.kind) {
    case "drafted":
      return <p className={MINE}>✎ {who} has drafted an answer · it is below for you to review</p>;
    case "running":
      return (
        <p className={LINE}>
          <Spinner /> {who} is working
          <Ran accepted={request.accepted} /> · <Elapsed since={status.startedAt} /> ·{" "}
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
      return <ReadyLine request={request} who={who} before={status.before} canDecline={status.canDecline} act={act} />;
    case "working":
      return (
        <p className={LINE}>
          <Spinner /> {who} is working
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

function Body({ message }: { readonly message: ReplyView }): JSX.Element {
  if (message.deleted) {
    return <p className="text-muted-foreground italic">message deleted</p>;
  }
  if (message.agent !== null || message.body.includes("```")) {
    // Markdown from an agent is drawn as elements, never as HTML: raw tags in it stay text. Images are not fetched: a remote one would tell its host who read the message.
    return (
      <div className="markdown">
        <Markdown
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
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
      {spans(message.body).map((span, index) => (
        // The pieces of one message never reorder, so their position is a stable key.
        <span key={index} className={span.tag ? "font-semibold text-tag" : undefined}>
          {span.text}
        </span>
      ))}
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

/** The menu of what only the author can do. It gives the focus back to nobody when it closes, so that the edit box keeps it. */
function OwnMenu({ own }: { readonly own: Own }): JSX.Element {
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
        <DropdownMenuItem onSelect={own.edit}>
          <PencilIcon /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={own.remove}>
          <Trash2Icon /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the user can do to a message, shown while the pointer is over it or the keyboard is in it: react, reply to one at the top of the chat, and edit or delete their own. */
function Actions({ react, onReply, own }: { readonly react: (emoji: string) => void; readonly onReply: (() => void) | null; readonly own: Own | null }): JSX.Element {
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
      {own !== null && <OwnMenu own={own} />}
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

/** One message or answer. `onReply` opens its thread; null for a reply, which is in its thread already. */
function Said({ message, me, act, onReply }: { readonly message: ReplyView; readonly me: string; readonly act: Act; readonly onReply: (() => void) | null }): JSX.Element {
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
    <article className={cn("group relative", message.agent !== null && "mt-1 border-l-3 border-agent pl-2.5")}>
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
        <Body message={message} />
      )}
      <Reactions message={message} me={me} react={react} />
      {message.requests.map((request) => (
        <RequestLine key={`${request.owner}/${request.repo}`} request={request} asker={message.sender === me} act={act} />
      ))}
      {!message.deleted && !editing && <Actions react={react} onReply={onReply} own={own} />}
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

/** A message at the top of the chat, and under it its thread: how many replies and the last one while it is closed, and every reply with a box to add one while it is open. */
export function Message({ message, me, act }: { readonly message: MessageView; readonly me: string; readonly act: Act }): JSX.Element {
  const [open, setOpen] = useState(false);
  const last = message.replies.at(-1);
  const close = (): void => {
    setOpen(false);
  };
  return (
    <>
      <Said
        message={message}
        me={me}
        act={act}
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
      {open && (
        <section className="my-1 ml-3 border-l-2 pl-3" aria-label="Thread">
          {message.replies.map((reply) => (
            <Said key={reply.id} message={reply} me={me} act={act} onReply={null} />
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
