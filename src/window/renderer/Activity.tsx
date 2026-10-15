/**
 * What the user's own agent is doing on a request, beside the chat: one row per step, newest at the bottom, each opening to show its detail; and what it asks before it acts,
 * as a card with the three answers, here and under the request. Everything in either is the agent's own output, so it is all drawn as text.
 */

import { cn } from "cn";
import { ChevronRightIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

import { runOf } from "../../shared/ipc.ts";
import type { ActivityItem, AskView, CurrentView } from "../../shared/ipc.ts";
import type { Act } from "./App.tsx";

const STALLED = 10_000; // Milliseconds with no new item before a run still going is shown as waiting.
const NEAR_BOTTOM = 40; // Pixels from the end within which a new item keeps the list pinned to the end.
const MARKS = { message: "›", thought: "›", tool: "✓", plan: "☰", permission: "?", error: "✗", state: "•" } as const; // A step that is over, by its kind.
// Failures, and steps that changed a file or ran a command, stand out; reads, searches and thoughts are dim.
const TONES = { failed: "border-destructive text-destructive", loud: "border-agent font-medium", quiet: "border-transparent text-muted-foreground", plain: "border-transparent" } as const;

/** An agent at work. */
export function Spinner(): JSX.Element {
  return <Loader2Icon aria-hidden className="inline size-3.5 align-[-2px] motion-safe:animate-spin" />;
}

/** The run the panel is open on: the chat its request is in, the run as `runOf` names it, and whose agent it is and what it was asked, to head the panel. */
export interface Shown {
  readonly chat: string;
  readonly run: string;
  readonly who: string;
  readonly asked: string;
}

/** What the panel shows of the run it was opened on. */
type Panel = Shown & { readonly items: readonly ActivityItem[]; readonly asks: readonly AskView[]; readonly running: boolean };

/** What the open chat holds of the run the panel was opened on: its items, what it waits to be allowed, and whether it is still going. Null when its chat is not open or holds nothing of it, so there is no panel. */
export function panelOf(current: CurrentView | null, shown: Shown | null): Panel | null {
  if (current === null || shown?.chat !== current.chat) {
    return null;
  }
  const items = current.activity.filter((item) => item.run === shown.run);
  const running = current.messages
    .flatMap((message) => [message, ...message.replies])
    .some((message) => message.requests.some((request) => request.status.kind === "running" && runOf(message.id, request.repo) === shown.run));
  return items.length > 0 || running ? { ...shown, items, asks: current.asks.filter((ask) => ask.run === shown.run), running } : null;
}

/** What the user's agent asks to do before it does it, the command or the change to a file below, with the three answers. "Allow for this run" allows that kind of action until the run ends. */
export function AskCard({ ask, who, act }: { readonly ask: AskView; readonly who: string; readonly act: Act }): JSX.Element {
  const answer = (answer: "allow-once" | "allow-run" | "refuse") => (): void => {
    act({ do: "permit", ask: ask.id, answer });
  };
  return (
    <section aria-label="Permission" className="my-1.5 rounded-lg border border-warn px-2.5 py-2">
      <p className="text-warn">
        ? {who} asks before it acts: <strong className="wrap-anywhere text-foreground">{ask.title}</strong>
      </p>
      {ask.detail !== "" && <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted px-2 py-1 text-xs wrap-anywhere whitespace-pre-wrap">{ask.detail}</pre>}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Button type="button" size="xs" onClick={answer("allow-once")}>
          Allow once
        </Button>
        <Button type="button" size="xs" variant="outline" title={`Allow every ${ask.action} without asking until this run ends`} onClick={answer("allow-run")}>
          Allow for this run
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={answer("refuse")}>
          Refuse
        </Button>
      </div>
    </section>
  );
}

function toneOf(item: ActivityItem): keyof typeof TONES {
  if (item.status === "failed") {
    return "failed";
  }
  return item.loud ? "loud" : item.quiet ? "quiet" : "plain";
}

/** One step: what it was and how it went, opening to show its detail when it has any. */
function Row({ item }: { readonly item: ActivityItem }): JSX.Element {
  const tone = toneOf(item);
  const outcome = item.outcome.toLowerCase() === item.title.toLowerCase() ? "" : item.outcome; // "Timed out" says how it ended once.
  const line = (
    <>
      <span className="w-4 flex-none text-center">{item.status === "running" ? <Spinner /> : item.status === "failed" ? "✗" : MARKS[item.kind]}</span>
      <span className="min-w-0 flex-1 truncate" title={item.title}>
        {item.title}
      </span>
      {outcome !== "" && <span className="flex-none text-xs text-muted-foreground">{outcome}</span>}
    </>
  );
  return (
    <li data-tone={tone} className={cn("border-l-2 pl-1", TONES[tone])}>
      {item.detail === "" ? (
        <p className="flex items-baseline gap-1.5 py-0.5 pr-1">{line}</p>
      ) : (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-baseline gap-1.5 rounded-sm py-0.5 pr-1 hover:bg-muted">
            {line}
            <ChevronRightIcon aria-hidden className="size-3 flex-none self-center group-open:rotate-90 motion-safe:transition-transform" />
          </summary>
          <pre className="mt-0.5 mb-1.5 ml-5.5 max-h-80 overflow-auto rounded bg-muted px-2 py-1 text-xs font-normal wrap-anywhere whitespace-pre-wrap text-foreground">{item.detail}</pre>
        </details>
      )}
    </li>
  );
}

/**
 * The panel: every step the open chat holds of one run, newest at the bottom, and below them what it waits to be allowed, kept in view as they come while the reader is at the end.
 * A run that exists always shows something: "starting…" before its first step, and "waiting…" after STALLED with no new one while it is still going and asks nothing.
 */
export function ActivityPanel({ panel, act, onClose }: { readonly panel: Panel; readonly act: Act; readonly onClose: () => void }): JSX.Element {
  const { run, who, items, asks, running } = panel;
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const last = items.at(-1);
  const step = `${run} ${String(items.length)} ${last?.status ?? ""} ${last?.outcome ?? ""} ${String(last?.detail.length ?? 0)} ${String(asks.length)}`; // Changes with each new item, as the newest grows, and with each ask.
  const [stalled, setStalled] = useState(""); // The step the run was at when it last went STALLED without a new one.

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setStalled(step);
    }, STALLED);
    return (): void => {
      clearTimeout(timer);
    };
  }, [step, running]);

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box !== null && atEnd.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [step]);

  return (
    <aside className="flex h-full min-w-0 flex-col" aria-label="Activity">
      <header className="flex items-baseline gap-2 border-b px-3 py-2.5">
        <h2 className="font-bold">Activity</h2>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {who} · {panel.asked}
        </span>
        <Button size="icon-xs" variant="ghost" type="button" aria-label="Close activity" title="Close" className="self-center" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <ScrollArea
        className="min-h-0 flex-1"
        viewportRef={scroller}
        onViewportScroll={(event) => {
          const box = event.currentTarget;
          atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
        }}
      >
        <div className="px-3 py-2">
          <ol className="flex flex-col gap-px">
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ol>
          {running && items.length === 0 && (
            <p className="text-muted-foreground">
              <Spinner /> starting…
            </p>
          )}
          {asks.map((ask) => (
            <AskCard key={ask.id} ask={ask} who={who} act={act} />
          ))}
          {running && items.length > 0 && asks.length === 0 && stalled === step && <p className="pl-1.5 text-muted-foreground">waiting…</p>}
        </div>
      </ScrollArea>
    </aside>
  );
}
