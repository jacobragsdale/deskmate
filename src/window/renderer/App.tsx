/** The window: a join form until this machine has joined a hub, then chats on the left and the open chat on the right; the setup page when something is not right. */

import { cn } from "cn";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, SyntheticEvent } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { isBranch } from "../../core/rooms.ts";
import type { Agent } from "../../core/wire.ts";
import { noticeSchema, outcomeSchema, viewSchema } from "../../shared/ipc.ts";
import type { ChatView, Check, Command, Notice, View } from "../../shared/ipc.ts";
import { ActivityPanel, panelOf } from "./Activity.tsx";
import type { Shown } from "./Activity.tsx";
import { AgentPicker, AgentsPart, FIELD, ownAgent } from "./Agents.tsx";
import { Composer } from "./Composer.tsx";
import { JoinChannel, PickRepo, Search } from "./dialogs.tsx";
import { MyAgents } from "./MyAgents.tsx";
import { runSetupCheck, SetupPage } from "./SetupPage.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Thread } from "./Thread.tsx";

const NOTICE_SECONDS = 7;

/** Sends a command and resolves with "" when it worked, or with the problem in words for the user. */
export type Submit = (command: Command) => Promise<string>;
/** Sends a command and shows the problem if there is one; then `done`, when given, hears whether it worked. */
export type Act = (command: Command, done?: (ok: boolean) => void) => void;

/** Show the user something that is not part of the picture, for a few seconds, in the corner above the status line. */
function tell(notice: Notice): void {
  const show = notice.severity === "error" ? toast.error : toast;
  if (notice.title === "") {
    show(notice.body);
  } else {
    show(notice.title, { description: notice.body });
  }
}

const submit: Submit = async (command) => {
  try {
    const outcome = outcomeSchema.parse(await window.playerTwo.command(command));
    return outcome.ok ? "" : outcome.problem;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

function Setup({ presets, tell }: { readonly presets: readonly Agent[]; readonly tell: (notice: Notice) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<Agent>(presets[0] ?? ownAgent([]));
  const join = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = (name: string): string => {
      const value = new FormData(event.currentTarget).get(name);
      return typeof value === "string" ? value : "";
    };
    setBusy(true);
    submit({ do: "join", hub: field("hub"), name: field("name"), token: field("token"), agent })
      .then((problem) => {
        setBusy(false);
        if (problem !== "") {
          tell({ title: "could not join", body: problem, severity: "error" });
        }
      })
      .catch(console.error);
  };
  return (
    <form className="mx-auto flex w-90 flex-col gap-3 pt-[10vh]" onSubmit={join}>
      <h1 className="text-2xl font-bold">Player Two</h1>
      <p className="text-muted-foreground">Join your team&rsquo;s hub. Whoever runs it has the address and the join token.</p>
      <Label className={FIELD}>
        Hub address
        {/* Filled in and fixed when this copy was built for the team's hub. */}
        <Input
          className="font-normal"
          name="hub"
          type="url"
          placeholder="https://player-two.example.com"
          defaultValue={PLAYER_TWO_HUB_URL}
          readOnly={PLAYER_TWO_HUB_URL !== ""}
          required
          autoFocus={PLAYER_TWO_HUB_URL === ""}
        />
      </Label>
      <Label className={FIELD}>
        Your name
        <Input className="font-normal" name="name" pattern="[a-z0-9][a-z0-9_\-]{0,31}" placeholder="lowercase letters, digits, - and _" required autoFocus={PLAYER_TWO_HUB_URL !== ""} />
      </Label>
      <Label className={FIELD}>
        Join token
        <Input className="font-normal" name="token" type="password" required />
      </Label>
      <AgentPicker title="Your agent" presets={presets} taken={[]} value={agent} onChange={setAgent} />
      <Button type="submit" className="self-start" disabled={busy}>
        {busy ? "Joining…" : "Join"}
      </Button>
    </form>
  );
}

/** How the desk's link to the hub stands, for the status line. */
function linkLine(link: ChatView["link"]): string {
  switch (link.state) {
    case "connecting":
      return "◌ connecting";
    case "connected":
      return "● connected";
    case "down":
      return `◌ ${link.problem} · retrying`;
  }
}

interface ChatProps {
  readonly view: ChatView;
  readonly act: Act;
  readonly tell: (notice: Notice) => void;
  readonly onSetup: () => void;
  readonly onAgents: () => void; // Open the My agents page.
}

function Chat({ view, act, tell, onSetup, onAgents }: ChatProps): JSX.Element {
  const [dialog, setDialog] = useState<"" | "join" | "pin" | "search">("");
  const [sidebar, setSidebar] = useState(true);
  const [shown, setShown] = useState<Shown | null>(null); // The run the activity panel was opened on; its panel shows while its chat is open and holds something of it.
  const current = view.current;
  const chats = view.rows.map((row) => row.chat);
  const panel = panelOf(current, shown);
  // The widths of the chat list and the activity panel as the user last dragged them, kept in localStorage; one layout for each set of panels shown.
  const layout = useDefaultLayout({ id: "player-two", panelIds: [...(sidebar ? ["chats"] : []), "chat", ...(panel === null ? [] : ["activity"])], onlySaveAfterUserInteractions: true });

  /** Open the chat `by` rows down the list from the open one, or up when it is negative, going round at either end. */
  const step = (by: number): void => {
    const at = chats.indexOf(current?.chat ?? "");
    const next = chats[(at + by + chats.length) % chats.length];
    if (next !== undefined) {
      act({ do: "open", chat: next });
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (event.defaultPrevented) {
        return; // Taken already: in the search dialog's list, Ctrl+N and Ctrl+K move down and up.
      }
      if (mod && event.key === "n") {
        event.preventDefault();
        setDialog("join");
      } else if (mod && event.key === "k") {
        event.preventDefault();
        setDialog("search"); // Cmd+K on macOS, Ctrl+K elsewhere.
      } else if (mod && event.key === "b") {
        event.preventDefault();
        setSidebar((shown) => !shown);
      } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        step(event.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return (): void => {
      window.removeEventListener("keydown", onKey);
    };
  });

  return (
    <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      {sidebar && (
        <>
          <ResizablePanel id="chats" defaultSize={220} minSize={160} maxSize="50" groupResizeBehavior="preserve-pixel-size">
            <Sidebar
              view={view}
              act={act}
              onJoin={() => {
                setDialog("join");
              }}
            />
          </ResizablePanel>
          <ResizableHandle />
        </>
      )}
      <ResizablePanel id="chat">
        <main className="flex h-full min-w-0 flex-col">
          {current === null ? (
            <p className="m-auto p-8 text-center text-muted-foreground">
              {view.loaded ? "Nobody else has joined this hub yet. Share the install line with a teammate, or start a channel." : "Loading…"}
            </p>
          ) : (
            <>
              <Thread
                view={view}
                current={current}
                act={act}
                onPin={() => {
                  setDialog("pin");
                }}
                onActivity={(id, who, asked) => {
                  setShown({ chat: current.chat, run: id, who, asked });
                }}
              />
              <Composer view={view} current={current} act={act} submit={submit} tell={tell} />
            </>
          )}
          <footer className="flex justify-between gap-4 border-t px-3 py-1 text-xs whitespace-nowrap text-muted-foreground">
            <span className="truncate">
              {view.me} on {view.hub} · {view.agents.find((agent) => agent.id === view.defaultAgent)?.label} · {view.myRepos.length} {view.myRepos.length === 1 ? "repo" : "repos"} in {view.dev}
            </span>
            <span className={cn("max-w-1/2 flex-none truncate", view.link.state === "down" && "text-destructive")}>
              {linkLine(view.link)} ·{" "}
              <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={onAgents}>
                My agents
              </Button>{" "}
              ·{" "}
              <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={onSetup}>
                Setup
              </Button>
            </span>
          </footer>
        </main>
      </ResizablePanel>
      {panel !== null && (
        <>
          <ResizableHandle />
          <ResizablePanel id="activity" defaultSize={360} minSize={240} maxSize="60" groupResizeBehavior="preserve-pixel-size">
            <ActivityPanel
              panel={panel}
              act={act}
              onClose={() => {
                setShown(null);
              }}
            />
          </ResizablePanel>
        </>
      )}
      {dialog === "join" && (
        <JoinChannel
          others={view.otherChannels}
          onDone={(name) => {
            setDialog("");
            if (name !== "") {
              act({ do: "joinChannel", name });
            }
          }}
        />
      )}
      {dialog === "search" && (
        <Search
          chats={chats}
          onDone={(command) => {
            setDialog("");
            if (command !== null) {
              act(command);
            }
          }}
        />
      )}
      {dialog === "pin" && current !== null && (
        <PickRepo
          title={`Which repo is ${current.chat} about?`}
          choices={view.checkouts.flatMap(({ repo, branch }) => [{ repo, branch: null }, ...(isBranch(branch) ? [{ repo, branch }] : [])])}
          onDone={(pick) => {
            setDialog("");
            if (pick !== null) {
              act({ do: "pin", chat: current.chat, ...pick });
            }
          }}
        />
      )}
    </ResizablePanelGroup>
  );
}

export function App(): JSX.Element {
  const [view, setView] = useState<View | null>(null);
  const [setup, setSetup] = useState<{ readonly initial: readonly Check[] | null } | null>(null); // The setup page while it is open, with the list it opened on if there was one.
  const [agents, setAgents] = useState(false); // Whether the My agents page is open.
  const checkedAtLaunch = useRef(false);
  const up = view !== null && view.kind !== "stopped";

  const act = useCallback<Act>((command, done) => {
    submit(command)
      .then((problem) => {
        if (problem !== "") {
          tell({ title: "", body: problem, severity: "error" });
        }
        done?.(problem === "");
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const accept = (raw: unknown): void => {
      // Null until the desk has said what to draw; its first view follows by itself.
      if (raw !== null) {
        setView(viewSchema.parse(raw));
      }
    };
    const offView = window.playerTwo.onView(accept);
    const offNotice = window.playerTwo.onNotice((raw) => {
      tell(noticeSchema.parse(raw));
    });
    window.playerTwo.view().then(accept).catch(console.error);
    return (): void => {
      offView();
      offNotice();
    };
  }, []);

  // Once, when the desk is first up: a check that fails opens the setup page by itself. A desk that will not start shows it anyway.
  useEffect(() => {
    if (up && !checkedAtLaunch.current) {
      checkedAtLaunch.current = true;
      runSetupCheck(false)
        .then((checks) => {
          if (checks.some((check) => check.status === "fail")) {
            setSetup({ initial: checks });
          }
        })
        .catch(console.error);
    }
  }, [up]);

  let page = <p className="m-auto p-8 text-center text-muted-foreground">Loading…</p>;
  if (view?.kind === "stopped") {
    page = <SetupPage problem={view.problem} initial={null} onClose={null} tell={tell} />;
  } else if (setup !== null) {
    page = (
      <SetupPage
        problem=""
        initial={setup.initial}
        onClose={() => {
          setSetup(null);
        }}
        tell={tell}
      >
        {view?.kind === "chat" && <AgentsPart view={view} act={act} />}
      </SetupPage>
    );
  } else if (view?.kind === "setup") {
    page = <Setup presets={view.presets} tell={tell} />;
  } else if (view?.kind === "chat" && agents) {
    page = (
      <MyAgents
        view={view}
        act={act}
        onClose={() => {
          setAgents(false);
        }}
      />
    );
  } else if (view?.kind === "chat") {
    page = (
      <Chat
        view={view}
        act={act}
        tell={tell}
        onSetup={() => {
          setSetup({ initial: null });
        }}
        onAgents={() => {
          setAgents(true);
        }}
      />
    );
  }
  return (
    <TooltipProvider>
      {page}
      <Toaster duration={NOTICE_SECONDS * 1000} offset={{ bottom: 36, right: 12 }} />
    </TooltipProvider>
  );
}
