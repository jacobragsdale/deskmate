/** The chat list: joined channels, then people, with what is waiting in each. */

import { cn } from "cn";
import { Loader2Icon } from "lucide-react";
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
