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

import { AGENT_CHOICES, noticeSchema, outcomeSchema, viewSchema } from "../../shared/ipc.ts";
import type { ChatView, Check, Command, Notice, View } from "../../shared/ipc.ts";
import { Composer } from "./Composer.tsx";
import { JoinChannel, PickRepo } from "./dialogs.tsx";
import { runSetupCheck, SetupPage } from "./SetupPage.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Thread } from "./Thread.tsx";

const NOTICE_SECONDS = 7;
const FIELD = "flex-col items-stretch gap-1.5"; // A label above its field.

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

function Setup({ defaultAgent, tell }: { readonly defaultAgent: string; readonly tell: (notice: Notice) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  // The command of the agent picked from those offered, or "" for one typed in under "Other".
  const [agent, setAgent] = useState<string>(AGENT_CHOICES.find((choice) => choice.command === defaultAgent)?.command ?? "");
  const join = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = (name: string): string => {
      const value = new FormData(event.currentTarget).get(name);
      return typeof value === "string" ? value : "";
    };
    setBusy(true);
    submit({ do: "join", hub: field("hub"), name: field("name"), token: field("token"), agent: agent === "" ? field("agent") : agent })
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
      <Label className={FIELD}>
        Your agent
        <select
          value={agent}
          onChange={(event) => {
            setAgent(event.currentTarget.value);
          }}
        >
          {AGENT_CHOICES.map((choice) => (
            <option key={choice.label} value={choice.command}>
              {choice.label}
            </option>
          ))}
          <option value="">Other</option>
        </select>
      </Label>
      {agent === "" && (
        <Label className={FIELD}>
          Agent command
          <Input className="font-normal" name="agent" placeholder="run in the repo's folder, with the prompt added as its last argument" required autoFocus />
        </Label>
      )}
      <Button type="submit" className="self-start" disabled={busy}>
        {busy ? "Joining…" : "Join"}
      </Button>
    </form>
  );
}

function Chat({ view, act, tell, onSetup }: { readonly view: ChatView; readonly act: Act; readonly tell: (notice: Notice) => void; readonly onSetup: () => void }): JSX.Element {
  const [dialog, setDialog] = useState<"" | "join" | "pin">("");
  const [sidebar, setSidebar] = useState(true);
  const current = view.current;
  const chats = view.rows.map((row) => row.chat);
  // The chat list's width as the user last dragged it, kept in localStorage; one layout with the list shown and one without.
  const layout = useDefaultLayout({ id: "player-two", panelIds: sidebar ? ["chats", "chat"] : ["chat"], onlySaveAfterUserInteractions: true });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key === "n") {
        event.preventDefault();
        setDialog("join");
      } else if (mod && event.key === "b") {
        event.preventDefault();
        setSidebar((shown) => !shown);
      } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && chats.length > 0) {
        event.preventDefault();
        const at = chats.indexOf(current?.chat ?? "");
        const next = chats[(at + (event.key === "ArrowDown" ? 1 : -1) + chats.length) % chats.length];
        if (next !== undefined) {
          act({ do: "open", chat: next });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return (): void => {
      window.removeEventListener("keydown", onKey);
    };
  });

  let link = "◌ connecting";
  if (view.link.state === "connected") {
    link = "● connected";
  } else if (view.link.state === "down") {
    link = `◌ ${view.link.problem} · retrying`;
  }
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
              />
              <Composer view={view} current={current} act={act} submit={submit} tell={tell} />
            </>
          )}
          <footer className="flex justify-between gap-4 border-t px-3 py-1 text-xs whitespace-nowrap text-muted-foreground">
            <span className="truncate">
              {view.me} on {view.hub} · {view.agent} · {view.myRepos.length} {view.myRepos.length === 1 ? "repo" : "repos"} in {view.dev}
            </span>
            <span className={cn("max-w-1/2 flex-none truncate", view.link.state === "down" && "text-destructive")}>
              {link} ·{" "}
              <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={onSetup}>
                Setup
              </Button>
            </span>
          </footer>
        </main>
      </ResizablePanel>
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
      {dialog === "pin" && current !== null && (
        <PickRepo
          title={`Which repo is ${current.chat} about?`}
          repos={view.myRepos}
          onDone={(repo) => {
            setDialog("");
            if (repo !== "") {
              act({ do: "pin", chat: current.chat, repo });
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
      />
    );
  } else if (view?.kind === "setup") {
    page = <Setup defaultAgent={view.defaultAgent} tell={tell} />;
  } else if (view?.kind === "chat") {
    page = (
      <Chat
        view={view}
        act={act}
        tell={tell}
        onSetup={() => {
          setSetup({ initial: null });
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
