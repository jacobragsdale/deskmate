/** The chat list: joined channels, then people, with what is waiting in each. */

import { cn } from "cn";
import type { JSX, ReactElement } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ChatView, RowView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const MARKS = { "": "", working: "", draft: "✎", asked: "▶" } as const;
const MARK_TITLES = { "": "", working: "your agent is working here", draft: "a draft is waiting for your review", asked: "a request is waiting for your agent" } as const;
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
            <span className={row.here ? "dot here" : "dot"} />
          </Mark>
        )}
        <span className={cn("flex-1 truncate text-left", row.unread > 0 && "font-bold")}>{row.chat}</span>
        {row.mark !== "" && (
          <Mark meaning={MARK_TITLES[row.mark]}>
            <Badge variant="outline">{row.mark === "working" ? <span className="spinner" /> : MARKS[row.mark]}</Badge>
          </Mark>
        )}
        {row.unread > 0 && <Badge>{row.unread}</Badge>}
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
      <nav className="sidebar">
        <h2>Channels</h2>
        <ul>
          {channels.map((row) => (
            <Row key={row.chat} row={row} open={row.chat === open} act={act} />
          ))}
          <li>
            <Button type="button" variant="ghost" className={cn(ROW, "text-muted-foreground")} onClick={onJoin}>
              + Join or create
            </Button>
          </li>
        </ul>
        <h2>People</h2>
        <ul>
          {people.map((row) => (
            <Row key={row.chat} row={row} open={row.chat === open} act={act} />
          ))}
        </ul>
        {view.loaded && people.length === 0 && <p className="quiet">nobody else yet</p>}
      </nav>
    </ScrollArea>
  );
}
