/** The open chat: who is in it, its notes, and under each note that tags an agent, where that agent stands. */

import { cn } from "cn";
import { Loader2Icon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import Markdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { spans } from "../../core/chat.ts";
import type { ChatView, CurrentView, MessageView, RequestView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const NEAR_BOTTOM = 80; // Pixels from the end within which new notes keep the view pinned to the end.
const LINE = "my-1 text-muted-foreground"; // Where a tagged agent stands, under the note.
const MINE = "my-1 text-warn"; // The same, when it waits on the user.
const BEFORE = { "": "", declined: "you declined · ", failed: "it failed · ", stopped: "stopped · ", interrupted: "interrupted · " } as const; // What happened to a request the user can run again.
const RULE = "mt-3.5 mb-1.5 flex items-center gap-2.5 text-xs text-muted-foreground before:flex-1 before:border-t after:flex-1 after:border-t"; // A line across the thread with a word in it.

/** An agent at work. */
function Spinner(): JSX.Element {
  return <Loader2Icon aria-hidden className="inline size-3.5 align-[-2px] motion-safe:animate-spin" />;
}

function dayLabel(ts: number): string {
  const day = new Date(ts * 1000);
  const daysAgo = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts * 1000).setHours(0, 0, 0, 0)) / 86_400_000);
  if (daysAgo === 0) {
    return "today";
  }
  return daysAgo === 1 ? "yesterday" : day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
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

function RequestLine({ request, act }: { readonly request: RequestView; readonly act: Act }): JSX.Element {
  const { id, owner, repo, status } = request;
  const who = request.mine ? `your ${repo} agent` : `${owner}'s ${repo} agent`;
  const on = (branch: string): string => (branch === "" ? "" : ` on ${branch}`);
  switch (status.kind) {
    case "drafted":
      return <p className={MINE}>✎ {who} has drafted an answer · it is below for you to review</p>;
    case "running":
      return (
        <p className={LINE}>
          <Spinner /> {who} is working{on(status.branch)} · <Elapsed since={status.startedAt} /> ·{" "}
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
          <Spinner /> {who} is working{on(status.branch)}
        </p>
      );
    case "waiting":
      return (
        <p className={LINE}>
          ◌ waiting for {owner} to approve{status.away ? " · they are away" : ""}
        </p>
      );
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
      return <p className={LINE}>✗ {who} failed</p>;
    case "stopped":
      return <p className={LINE}>■ {who} was stopped</p>;
    case "withdrawn":
      return <p className={LINE}>↩ the request was taken back</p>;
  }
}

function Body({ message }: { readonly message: MessageView }): JSX.Element {
  if (message.agent !== null || message.body.includes("```")) {
    // Markdown from an agent is drawn as elements, never as HTML: raw tags in it stay text. Images are not fetched: a remote one would tell its host who read the note.
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
      </div>
    );
  }
  return (
    <p className="wrap-anywhere whitespace-pre-wrap">
      {spans(message.body).map((span, index) => (
        // The pieces of one note never reorder, so their position is a stable key.
        <span key={index} className={span.tag ? "font-semibold text-tag" : undefined}>
          {span.text}
        </span>
      ))}
    </p>
  );
}

function Message({ message, me, act }: { readonly message: MessageView; readonly me: string; readonly act: Act }): JSX.Element {
  const when = new Date(message.ts * 1000);
  if (!message.trusted) {
    return <p className="my-2 text-destructive">✗ a note claiming to be from {message.sender} failed its signature check and is hidden</p>;
  }
  return (
    <article className={cn(message.agent !== null && "mt-1 border-l-3 border-agent pl-2.5")}>
      {message.header && (
        <header className="mt-2.5 flex items-baseline gap-1.5">
          <strong className={cn(message.agent !== null && "text-agent")}>{message.sender === me ? "you" : message.sender}</strong>
          {message.agent !== null && (
            <span className="text-xs text-muted-foreground">
              /{message.agent} agent{message.branch === "" ? "" : ` on ${message.branch}`}
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
      )}
      {message.quote !== "" && <p className="my-0.5 truncate border-l-3 pl-2 text-muted-foreground">{message.quote}</p>}
      <Body message={message} />
      {message.requests.map((request) => (
        <RequestLine key={`${request.owner}/${request.repo}`} request={request} act={act} />
      ))}
    </article>
  );
}

export function Thread({ view, current, act, onPin }: { readonly view: ChatView; readonly current: CurrentView; readonly act: Act; readonly onPin: () => void }): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const shown = useRef("");
  const newest = current.messages.at(-1)?.seq ?? 0;

  // Keep the newest note in view when the chat is opened, and when one arrives while the reader is already at the end.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box !== null && (atEnd.current || shown.current !== current.chat)) {
      box.scrollTop = box.scrollHeight;
      atEnd.current = true;
    }
    shown.current = current.chat;
  }, [current.chat, newest]);

  const { pinned, members } = current;
  const firstNew = current.newAfter === null ? undefined : current.messages.find((message) => message.seq > (current.newAfter ?? 0) && message.sender !== view.me);
  return (
    <>
      <header className="flex items-baseline gap-3 border-b px-4 py-2.5">
        <h1 className="text-base font-bold">{current.chat}</h1>
        <span className="flex-1 truncate text-muted-foreground">
          {pinned !== null && `${pinned.name} (${String(pinned.have)} of ${String(members?.length ?? 0)} have it) · `}
          {members?.join(", ")}
        </span>
        {current.joined && (
          <span className="flex flex-none gap-1.5">
            {pinned === null ? (
              <Button size="xs" variant="outline" className="text-foreground" type="button" onClick={onPin}>
                ◆ Pin a repo
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                className="text-foreground"
                type="button"
                onClick={() => {
                  act({ do: "unpin", chat: current.chat });
                }}
              >
                ◆ Unpin {pinned.name}
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              className="text-foreground"
              type="button"
              onClick={() => {
                act({ do: "leaveChannel", chat: current.chat });
              }}
            >
              × Leave
            </Button>
          </span>
        )}
      </header>
      {pinned !== null && !pinned.mine && view.loaded && (
        <p className="border-b px-4 py-1.5 text-warn">
          ◆ This channel is about {pinned.name}, which you have no checkout of ·{" "}
          <Button
            size="xs"
            variant="outline"
            className="text-foreground"
            type="button"
            onClick={() => {
              act({ do: "clone", repo: pinned.name });
            }}
          >
            ⇣ Clone it
          </Button>
        </p>
      )}
      <ScrollArea
        className="min-h-0 flex-1"
        viewportRef={scroller}
        onViewportScroll={(event) => {
          const box = event.currentTarget;
          atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
        }}
      >
        <div className="px-4 pt-2 pb-3">
          {current.messages.length === 0 && <p className="text-muted-foreground">No notes here yet. Type @ to tag an agent.</p>}
          {current.messages.map((message, index) => {
            const before = current.messages[index - 1];
            const newDay = before === undefined || new Date(before.ts * 1000).toDateString() !== new Date(message.ts * 1000).toDateString();
            return (
              <Fragment key={message.id}>
                {newDay && <p className={RULE}>{dayLabel(message.ts)}</p>}
                {message === firstNew && <p className={cn(RULE, "text-destructive before:border-destructive after:border-destructive")}>new</p>}
                <Message message={message} me={view.me} act={act} />
              </Fragment>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}
