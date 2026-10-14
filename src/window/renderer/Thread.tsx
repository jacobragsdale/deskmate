/** The open chat: who is in it, its notes, and under each note that tags an agent, where that agent stands. */

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import Markdown from "react-markdown";

import { spans } from "../../core/chat.ts";
import type { ChatView, CurrentView, MessageView, RequestView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const NEAR_BOTTOM = 80; // Pixels from the end within which new notes keep the view pinned to the end.

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

function RequestLine({ request, act }: { readonly request: RequestView; readonly act: Act }): JSX.Element {
  const { noteId, owner, repo, status } = request;
  const who = request.mine ? `your ${repo} agent` : `${owner}'s ${repo} agent`;
  const on = (branch: string): string => (branch === "" ? "" : ` on ${branch}`);
  switch (status.kind) {
    case "drafted":
      return <p className="request mine">✎ {who} has drafted an answer · it is below for you to review</p>;
    case "running":
      return (
        <p className="request">
          <span className="spinner" /> {who} is working{on(status.branch)} · <Elapsed since={status.startedAt} /> ·{" "}
          <button
            type="button"
            onClick={() => {
              act({ do: "stop", noteId, repo });
            }}
          >
            ■ Stop
          </button>
        </p>
      );
    case "noCheckout":
      return (
        <p className="request mine">
          ? you have no checkout of {repo} ·{" "}
          <button
            type="button"
            onClick={() => {
              act({ do: "clone", repo });
            }}
          >
            ⇣ Clone it
          </button>
        </p>
      );
    case "ready":
      return (
        <p className="request mine">
          ◆ {{ "": "", declined: "you declined · ", failed: "it failed · ", stopped: "stopped · ", interrupted: "interrupted · " }[status.before]}
          {who} ·{" "}
          <button
            type="button"
            onClick={() => {
              act({ do: "run", noteId, repo, post: false });
            }}
          >
            ▶ Run and review
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              act({ do: "run", noteId, repo, post: true });
            }}
          >
            ▶▶ Run and post
          </button>
          {status.canDecline && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => {
                  act({ do: "decline", noteId, repo });
                }}
              >
                × Decline
              </button>
            </>
          )}
        </p>
      );
    case "working":
      return (
        <p className="request">
          <span className="spinner" /> {who} is working{on(status.branch)}
        </p>
      );
    case "waiting":
      return (
        <p className="request">
          ◌ waiting for {owner} to approve{status.away ? " · they are away" : ""}
        </p>
      );
    case "nobody":
      return <p className="request">? nobody named {owner} has joined</p>;
    case "lacksRepo":
      return (
        <p className="request">
          ? {owner} has no checkout of {repo}
        </p>
      );
    case "declined":
      return <p className="request">× {owner} declined</p>;
    case "failed":
      return <p className="request">✗ {who} failed</p>;
    case "stopped":
      return <p className="request">■ {who} was stopped</p>;
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
              <span className="quiet">
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
    <p className="text">
      {spans(message.body).map((span, index) => (
        // The pieces of one note never reorder, so their position is a stable key.
        <span key={index} className={span.tag ? "tag" : undefined}>
          {span.text}
        </span>
      ))}
    </p>
  );
}

function Message({ message, me, act }: { readonly message: MessageView; readonly me: string; readonly act: Act }): JSX.Element {
  const when = new Date(message.ts * 1000);
  if (!message.trusted) {
    return <p className="untrusted">✗ a note claiming to be from {message.sender} failed its signature check and is hidden</p>;
  }
  return (
    <article className={message.agent === null ? "message" : "message agent"}>
      {message.header && (
        <header>
          <strong>{message.sender === me ? "you" : message.sender}</strong>
          {message.agent !== null && (
            <span>
              /{message.agent} agent{message.branch === "" ? "" : ` on ${message.branch}`}
            </span>
          )}
          <time dateTime={when.toISOString()} title={when.toLocaleString()}>
            {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </time>
        </header>
      )}
      {message.quote !== "" && <p className="quote">{message.quote}</p>}
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
  const newest = current.messages.at(-1)?.id ?? 0;

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
  const firstNew = current.newAfter === null ? undefined : current.messages.find((message) => message.id > (current.newAfter ?? 0) && message.sender !== view.me);
  return (
    <>
      <header className="title">
        <h1>{current.chat}</h1>
        <span className="quiet">
          {pinned !== null && `${pinned.name} (${String(pinned.have)} of ${String(members?.length ?? 0)} have it) · `}
          {members?.join(", ")}
        </span>
        {current.joined && (
          <span className="actions">
            {pinned === null ? (
              <button type="button" onClick={onPin}>
                ◆ Pin a repo
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  act({ do: "unpin", chat: current.chat });
                }}
              >
                ◆ Unpin {pinned.name}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                act({ do: "leaveChannel", chat: current.chat });
              }}
            >
              × Leave
            </button>
          </span>
        )}
      </header>
      {pinned !== null && !pinned.mine && view.loaded && (
        <p className="banner">
          ◆ This channel is about {pinned.name}, which you have no checkout of ·{" "}
          <button
            type="button"
            onClick={() => {
              act({ do: "clone", repo: pinned.name });
            }}
          >
            ⇣ Clone it
          </button>
        </p>
      )}
      <div
        className="thread"
        ref={scroller}
        onScroll={(event) => {
          const box = event.currentTarget;
          atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
        }}
      >
        {current.messages.length === 0 && <p className="quiet">No notes here yet. Type @ to tag an agent.</p>}
        {current.messages.map((message, index) => {
          const before = current.messages[index - 1];
          const newDay = before === undefined || new Date(before.ts * 1000).toDateString() !== new Date(message.ts * 1000).toDateString();
          return (
            <Fragment key={message.id}>
              {newDay && <p className="rule">{dayLabel(message.ts)}</p>}
              {message === firstNew && <p className="rule new">new</p>}
              <Message message={message} me={view.me} act={act} />
            </Fragment>
          );
        })}
      </div>
    </>
  );
}
