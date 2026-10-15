/** The chat list: joined channels, then people, with what is waiting in each, and the branch rooms worth starting. */

import { cn } from "cn";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import type { JSX, ReactElement } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ChatView, RowView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const MARKS = { "": "", working: "", draft: "✎", asked: "▶" } as const;
const MARK_TITLES = { "": "", working: "your agent is working here", draft: "a draft is waiting for your review", asked: "a request is waiting for your agent" } as const;
const HEADING = "mx-2 mt-3 mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const ROW = "h-auto w-full justify-start gap-1.5 px-2 py-1 font-normal"; // A line of the list, the open chat's in bold on a shade.

/** A mark beside a chat, saying on hover what it means. */
function Mark({ meaning, children }: { readonly meaning: string; readonly children: ReactElement }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{meaning}</TooltipContent>
    </Tooltip>
  );
}

function Row({ row, open, act }: { readonly row: RowView; readonly open: boolean; readonly act: Act }): JSX.Element {
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        className={cn(ROW, "aria-[current=true]:bg-muted aria-[current=true]:font-semibold")}
        aria-current={open}
        onClick={() => {
          act({ do: "open", chat: row.chat });
        }}
      >
        {row.here !== null && (
          <Mark meaning={row.here ? "here now" : "away"}>
            <span className={cn("size-2 flex-none rounded-full border border-muted-foreground", row.here && "border-emerald-600 bg-emerald-600")} />
          </Mark>
        )}
        <span className={cn("flex-1 truncate text-left", row.unread > 0 && "font-bold")}>{row.chat}</span>
        {row.mark !== "" && (
          <Mark meaning={MARK_TITLES[row.mark]}>
            <Badge variant="outline">{row.mark === "working" ? <Loader2Icon aria-hidden className="motion-safe:animate-spin" /> : MARKS[row.mark]}</Badge>
          </Mark>
        )}
        {row.unread > 0 && <Badge>{row.unread}</Badge>}
      </Button>
    </li>
  );
}

const PEOPLE = new Intl.ListFormat("en-GB"); // "bob, carol and dave".

/**
 * A branch room worth starting, "bob is also on uploader/feature-retry", with a button that starts it and one that stops suggesting it. The second click of a double click does nothing:
 * on Start it would start a second room, and on × it would land on the suggestion that the first moved under the pointer.
 */
function Suggested({ room, act }: { readonly room: ChatView["rooms"][number]; readonly act: Act }): JSX.Element {
  const { repo, branch, others } = room;
  const [starting, setStarting] = useState(false); // While the desk starts the room, Start does nothing more.
  return (
    <li className="mx-2 my-1 text-xs text-muted-foreground" data-room={`${repo}/${branch}`}>
      {PEOPLE.format(others)} {others.length === 1 ? "is" : "are"} also on {repo}/{branch} ·{" "}
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto p-0"
        disabled={starting}
        onClick={(event) => {
          if (event.detail > 1) {
            return;
          }
          setStarting(true);
          act({ do: "startRoom", repo, branch }, () => {
            setStarting(false);
          });
        }}
      >
        Start a room
      </Button>{" "}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-auto px-1 py-0"
        aria-label={`Do not suggest a room for ${repo}/${branch}`}
        title="Do not suggest it again"
        onClick={(event) => {
          if (event.detail <= 1) {
            act({ do: "dismissRoom", repo, branch });
          }
        }}
      >
        ×
      </Button>
    </li>
  );
}

export function Sidebar({ view, act, onJoin }: { readonly view: ChatView; readonly act: Act; readonly onJoin: () => void }): JSX.Element {
  const channels = view.rows.filter((row) => row.here === null);
  const people = view.rows.filter((row) => row.here !== null);
  const open = view.current?.chat ?? "";
  return (
    <ScrollArea className="h-full bg-sidebar">
      <nav className="p-2">
        <h2 className={HEADING}>Channels</h2>
        <ul>
          {channels.map((row) => (
            <Row key={row.chat} row={row} open={row.chat === open} act={act} />
          ))}
          {view.rooms.map((room) => (
            <Suggested key={`${room.repo}/${room.branch}`} room={room} act={act} />
          ))}
          <li>
            <Button type="button" variant="ghost" className={cn(ROW, "text-muted-foreground")} onClick={onJoin}>
              + Join or create
            </Button>
          </li>
        </ul>
        <h2 className={HEADING}>People</h2>
        <ul>
          {people.map((row) => (
            <Row key={row.chat} row={row} open={row.chat === open} act={act} />
          ))}
        </ul>
        {view.loaded && people.length === 0 && <p className="mx-2 my-1 text-muted-foreground">nobody else yet</p>}
      </nav>
    </ScrollArea>
  );
}
