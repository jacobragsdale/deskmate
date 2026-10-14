/** The open chat: who is in it, and its messages, each with its thread and where each agent it tags stands (Message.tsx), with a quiet line wherever someone joined, left or pinned. */

import { cn } from "cn";
import { Fragment, useLayoutEffect, useRef } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

import type { ChatView, CurrentView, LineView, MessageView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";
import { Message } from "./Message.tsx";

const NEAR_BOTTOM = 80; // Pixels from the end within which new messages keep the view pinned to the end.
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

export function Thread({ view, current, act, onPin }: { readonly view: ChatView; readonly current: CurrentView; readonly act: Act; readonly onPin: () => void }): JSX.Element {
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
          {current.messages.length === 0 && <p className="text-muted-foreground">No messages here yet. Type @ to tag an agent.</p>}
          {items.map((item, index) => {
            const before = items[index - 1];
            const newDay = before === undefined || new Date(before.ts * 1000).toDateString() !== new Date(item.ts * 1000).toDateString();
            return (
              <Fragment key={"did" in item ? `line ${String(item.seq)}` : item.id}>
                {newDay && <p className={RULE}>{dayLabel(item.ts)}</p>}
                {item === firstNew && <p className={cn(RULE, "text-destructive before:border-destructive after:border-destructive")}>new</p>}
                {"did" in item ? <Line line={item} me={view.me} /> : <Message message={item} me={view.me} act={act} />}
              </Fragment>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}
