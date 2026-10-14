/** The chat list: joined channels, then people, with what is waiting in each. */

import type { JSX } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";

import type { ChatView, RowView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const MARKS = { "": "", working: "", draft: "✎", asked: "▶" } as const;
const MARK_TITLES = { "": "", working: "your agent is working here", draft: "a draft is waiting for your review", asked: "a request is waiting for your agent" } as const;

function Row({ row, open, act }: { readonly row: RowView; readonly open: boolean; readonly act: Act }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={open ? "row open" : "row"}
        aria-current={open}
        onClick={() => {
          act({ do: "open", chat: row.chat });
        }}
      >
        {row.here !== null && <span className={row.here ? "dot here" : "dot"} title={row.here ? "here now" : "away"} />}
        <span className={row.unread > 0 ? "name unread" : "name"}>{row.chat}</span>
        {row.mark === "working" ? <span className="spinner" title={MARK_TITLES.working} /> : row.mark !== "" && <span title={MARK_TITLES[row.mark]}>{MARKS[row.mark]}</span>}
        {row.unread > 0 && <span className="count">{row.unread}</span>}
      </button>
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
            <button type="button" className="row quiet" onClick={onJoin}>
              + Join or create
            </button>
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
