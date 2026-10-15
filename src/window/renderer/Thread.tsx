/** The open chat: who is in it, and its messages, each with its thread and where each agent it tags stands (Message.tsx), with a quiet line wherever someone joined, left or pinned, and older ones loaded on the way up. */

import { cn } from "cn";
import { Fragment, useLayoutEffect, useRef } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

import type { ChatView, CurrentView, LineView, MessageView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";
import { Message } from "./Message.tsx";
import type { Runs } from "./Message.tsx";

const NEAR_BOTTOM = 80; // Pixels from the end within which new messages keep the view pinned to the end.
const NEAR_TOP = 40; // Pixels from the top within which scrolling loads the page before what is shown.
const RULE = "mt-3.5 mb-1.5 flex items-center gap-2.5 text-xs text-muted-foreground before:flex-1 before:border-t after:flex-1 after:border-t"; // A line across the thread with a word in it.

function dayLabel(ts: number): string {
  const day = new Date(ts * 1000);
  const daysAgo = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts * 1000).setHours(0, 0, 0, 0)) / 86_400_000);
  if (daysAgo === 0) {
    return "today";
  }
  return daysAgo === 1 ? "yesterday" : day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Someone joined or left the channel, or pinned a repo to it or unpinned it: one quiet line. */
function Line({ line, me }: { readonly line: LineView; readonly me: string }): JSX.Element {
  const who = line.who === me ? "you" : line.who;
  const said = { joined: `→ ${who} joined`, left: `← ${who} left`, pinned: `◆ ${who} pinned ${line.repo}`, unpinned: `◆ ${who} unpinned the repo` }[line.did];
  return (
    <p className="my-1 text-xs text-muted-foreground">
      {said} · {new Date(line.ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
    </p>
  );
}

export function Thread({
  view,
  current,
  act,
  onPin,
  onActivity
}: {
  readonly view: ChatView;
  readonly current: CurrentView;
  readonly act: Act;
  readonly onPin: () => void;
  readonly onActivity: Runs["show"];
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const shown = useRef("");
  const items: readonly (MessageView | LineView)[] = [...current.messages, ...current.lines].sort((a, b) => a.seq - b.seq); // The lines go among the messages in the order the hub stored them.
  const newest = items.at(-1)?.seq ?? 0;

  // Keep the newest message in view when the chat is opened, and when one arrives while the reader is already at the end.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box !== null && (atEnd.current || shown.current !== current.chat)) {
      box.scrollTop = box.scrollHeight;
      atEnd.current = true;
    }
    shown.current = current.chat;
  }, [current.chat, newest]);

  // Bring a new card asking the user to allow something into view, the newest when several come at once, while the reader is at the end, as a new message is: it is under its request,
  // which may be far above the newest message.
  const carded = useRef<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const fresh = current.asks.filter((ask) => !carded.current.has(ask.id)).at(-1);
    carded.current = new Set(current.asks.map((ask) => ask.id));
    if (fresh !== undefined && atEnd.current) {
      scroller.current?.querySelector(`[data-ask="${CSS.escape(fresh.id)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [current.asks]);

  // While older events are being loaded: the first item shown when they were asked for, and where it was on the screen, to keep it there as they arrive above it.
  const anchor = useRef<{ readonly chat: string; readonly seq: number; readonly top: number; answered: boolean } | null>(null);
  const topOf = (seq: number): number | undefined => scroller.current?.querySelector(`[data-seq="${String(seq)}"]`)?.getBoundingClientRect().top;

  /** Ask for the page before the oldest event loaded, once at a time. */
  const older = (): void => {
    if (!current.hasOlder || anchor.current !== null) {
      return;
    }
    const first = items[0]?.seq ?? 0;
    const asked = { chat: current.chat, seq: first, top: topOf(first) ?? 0, answered: false };
    anchor.current = asked;
    act({ do: "older" }, (ok) => {
      asked.answered = true;
      if (!ok && anchor.current === asked) {
        anchor.current = null; // Nothing is coming, so scrolling up may ask again.
      }
    });
  };

  // Each view while the page is being loaded puts the anchor back where it was. The desk answers the command before it sends the view with the page in it, so the first view after the answer has it, and is the last one to move.
  useLayoutEffect(() => {
    const box = scroller.current;
    const kept = anchor.current;
    if (box === null || kept === null) {
      return;
    }
    const top = kept.chat === current.chat ? topOf(kept.seq) : undefined;
    if (top !== undefined) {
      box.scrollTop += top - kept.top;
    }
    if (kept.answered || kept.chat !== current.chat) {
      anchor.current = null;
    }
  }, [current]);

  // Bring the message the user opened a link to into view, once each time one is opened, after the chat has been opened at its end above. It may come a view after its focus.
  const focused = useRef(0);
  useLayoutEffect(() => {
    const { focus } = current;
    const target = focus === null || focus.nth === focused.current ? null : scroller.current?.querySelector(`[data-id="${CSS.escape(focus.id)}"]`);
    if (focus !== null && target !== null && target !== undefined) {
      target.scrollIntoView({ block: "center" });
      focused.current = focus.nth;
      atEnd.current = false;
    }
  }, [current]);

  const { pinned, members } = current;
  const runs: Runs = { kept: new Set(current.activity.map((item) => item.run)), asks: current.asks, cannot: view.cannot, show: onActivity };
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
          if (box.scrollTop < NEAR_TOP) {
            older();
          }
        }}
      >
        <div className="px-4 pt-2 pb-3">
          {current.hasOlder && (
            <p className="text-center">
              <Button variant="link" size="xs" className="text-muted-foreground" type="button" onClick={older}>
                Load earlier messages
              </Button>
            </p>
          )}
          {current.messages.length === 0 && <p className="text-muted-foreground">No messages here yet. Type @ to tag an agent.</p>}
          {items.map((item, index) => {
            const before = items[index - 1];
            const newDay = before === undefined || new Date(before.ts * 1000).toDateString() !== new Date(item.ts * 1000).toDateString();
            return (
              <Fragment key={"did" in item ? `line ${String(item.seq)}` : item.id}>
                {newDay && <p className={RULE}>{dayLabel(item.ts)}</p>}
                {item === firstNew && <p className={cn(RULE, "text-destructive before:border-destructive after:border-destructive")}>new</p>}
                <div data-seq={item.seq}>{"did" in item ? <Line line={item} me={view.me} /> : <Message message={item} me={view.me} runs={runs} act={act} focus={current.focus} />}</div>
              </Fragment>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}
