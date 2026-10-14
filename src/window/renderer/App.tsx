/** The window: a join form until this machine has joined a hub, then chats on the left and the open chat on the right. */

import { useCallback, useEffect, useState } from "react";
import type { JSX, SyntheticEvent } from "react";

import { noticeSchema, outcomeSchema, viewSchema } from "../../shared/ipc.ts";
import type { ChatView, Command, Notice, View } from "../../shared/ipc.ts";
import { Composer } from "./Composer.tsx";
import { JoinChannel, PickRepo } from "./dialogs.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Thread } from "./Thread.tsx";

const NOTICE_SECONDS = 7;

/** Sends a command and resolves with "" when it worked, or with the problem in words for the user. */
export type Submit = (command: Command) => Promise<string>;
/** Sends a command and shows the problem if there is one. */
export type Act = (command: Command) => void;

interface Toast extends Notice {
  readonly id: number;
}

const submit: Submit = async (command) => {
  try {
    const outcome = outcomeSchema.parse(await window.deskmate.command(command));
    return outcome.ok ? "" : outcome.problem;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

function Setup({ defaultAgent, tell }: { readonly defaultAgent: string; readonly tell: (notice: Notice) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const join = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = (name: string): string => {
      const value = new FormData(event.currentTarget).get(name);
      return typeof value === "string" ? value : "";
    };
    setBusy(true);
    submit({ do: "join", hub: field("hub"), name: field("name"), token: field("token"), agent: field("agent") })
      .then((problem) => {
        setBusy(false);
        if (problem !== "") {
          tell({ title: "could not join", body: problem, severity: "error" });
        }
      })
      .catch(console.error);
  };
  return (
    <form className="setup" onSubmit={join}>
      <h1>deskmate</h1>
      <p>Join your team&rsquo;s hub. Whoever runs it has the address and the join token.</p>
      <label>
        Hub address
        <input name="hub" type="url" placeholder="https://deskmate.example.com" required autoFocus />
      </label>
      <label>
        Your name
        <input name="name" pattern="[a-z0-9][a-z0-9_\-]{0,31}" placeholder="lowercase letters, digits, - and _" required />
      </label>
      <label>
        Join token
        <input name="token" type="password" required />
      </label>
      <label>
        Agent command
        <input name="agent" defaultValue={defaultAgent} required />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Joining…" : "Join"}
      </button>
    </form>
  );
}

function Chat({ view, act, tell }: { readonly view: ChatView; readonly act: Act; readonly tell: (notice: Notice) => void }): JSX.Element {
  const [dialog, setDialog] = useState<"" | "join" | "pin">("");
  const [sidebar, setSidebar] = useState(true);
  const current = view.current;
  const chats = view.rows.map((row) => row.chat);

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
    <div className="app">
      {sidebar && (
        <Sidebar
          view={view}
          act={act}
          onJoin={() => {
            setDialog("join");
          }}
        />
      )}
      <main>
        {current === null ? (
          <p className="empty">{view.loaded ? "Nobody else has joined this hub yet. Share the install line with a teammate, or start a channel." : "Loading…"}</p>
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
        <footer className={view.link.state === "down" ? "down" : ""}>
          <span>
            {view.me} on {view.hub} · {view.agent} · {view.myRepos.length} {view.myRepos.length === 1 ? "repo" : "repos"} in {view.dev}
          </span>
          <span>{link}</span>
        </footer>
      </main>
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
    </div>
  );
}

export function App(): JSX.Element {
  const [view, setView] = useState<View | null>(null);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const tell = useCallback((notice: Notice): void => {
    const id = Date.now() + Math.random();
    setToasts((shown) => [...shown, { ...notice, id }]);
    setTimeout(() => {
      setToasts((shown) => shown.filter((toast) => toast.id !== id));
    }, NOTICE_SECONDS * 1000);
  }, []);

  const act = useCallback<Act>(
    (command) => {
      submit(command)
        .then((problem) => {
          if (problem !== "") {
            tell({ title: "", body: problem, severity: "error" });
          }
        })
        .catch(console.error);
    },
    [tell]
  );

  useEffect(() => {
    const accept = (raw: unknown): void => {
      setView(viewSchema.parse(raw));
    };
    const offView = window.deskmate.onView(accept);
    const offNotice = window.deskmate.onNotice((raw) => {
      tell(noticeSchema.parse(raw));
    });
    window.deskmate.view().then(accept).catch(console.error);
    return (): void => {
      offView();
      offNotice();
    };
  }, [tell]);

  let page = <p className="empty">Loading…</p>;
  if (view?.kind === "setup") {
    page = <Setup defaultAgent={view.defaultAgent} tell={tell} />;
  } else if (view?.kind === "chat") {
    page = <Chat view={view} act={act} tell={tell} />;
  }
  return (
    <>
      {page}
      <div className="toasts" role="status">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.severity}`}>
            {toast.title !== "" && <strong>{toast.title}</strong>}
            {toast.body}
          </div>
        ))}
      </div>
    </>
  );
}
