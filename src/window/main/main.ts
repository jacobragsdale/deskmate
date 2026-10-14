/** The desktop app's main process: one window, the session behind it, and the operating system's notifications, badge and dialogs. */

import { join as joinPath } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import { DEFAULT_AGENT, defaultDev, defaultHome, http, join, loadClient, PlayerTwoError } from "../../desk/client.ts";
import { problemOf, Session } from "../../desk/session.ts";
import type { Hooks } from "../../desk/session.ts";
import { commandSchema } from "../../shared/ipc.ts";
import type { Arrival, Notice, Outcome, View } from "../../shared/ipc.ts";

const home = defaultHome();
let session: Session | null = null;
let window: BrowserWindow | null = null;
let pushQueued = false;
let stopped = false;

function report(error: unknown): void {
  console.error(error);
}

function view(): View {
  return session === null ? { kind: "setup", defaultAgent: DEFAULT_AGENT } : session.view();
}

/** Send the window what to draw, and put what needs the user where they see it without the window: the title and the dock badge. */
function push(): void {
  pushQueued = false;
  const current = view();
  if (window === null || window.isDestroyed()) {
    return;
  }
  window.webContents.send("view", current);
  if (current.kind === "chat") {
    window.setTitle(["Player Two", ...(current.waiting > 0 ? [`${String(current.waiting)} waiting`] : []), ...(current.unread > 0 ? [`${String(current.unread)} unread`] : [])].join(" · "));
    app.setBadgeCount(current.waiting + current.unread);
  }
}

/** Several changes in one turn of the event loop are drawn once. */
function changed(): void {
  if (!pushQueued) {
    pushQueued = true;
    setImmediate(push);
  }
}

function open(chat: string): void {
  window?.show();
  window?.focus();
  session?.handle({ do: "open", chat }).catch(report);
}

/** Tell the user about a note with the system's own notification, unless they are already looking at its chat. */
function arrived(arrival: Arrival): void {
  const looking = window?.isFocused() === true && session?.isOpen(arrival.chat) === true;
  if (looking || !Notification.isSupported()) {
    return;
  }
  const notification = new Notification({ title: arrival.title, body: arrival.body, silent: !arrival.rings });
  notification.on("click", () => {
    open(arrival.chat);
  });
  notification.show();
}

async function confirmClone(url: string, destination: string): Promise<boolean> {
  const options = {
    type: "question" as const,
    message: "Clone this repository?",
    detail: `From ${url}\nInto ${destination}\n\nIt is cloned with your own git credentials. An agent started in a repo reads that repo's instruction files.`,
    buttons: ["Clone", "Cancel"],
    defaultId: 0,
    cancelId: 1
  };
  return (await (window === null ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options))).response === 0;
}

const hooks: Hooks = {
  changed,
  arrived,
  confirmClone,
  notice: (notice: Notice) => {
    window?.webContents.send("notice", notice);
  }
};

/** Start following the hub as whoever has joined from this machine. False when nobody has. */
function startSession(): boolean {
  const client = loadClient(home, http, () => Date.now() / 1000);
  if (client === null) {
    return false;
  }
  session = new Session(client, defaultDev(), hooks);
  session.attend(window?.isFocused() ?? true);
  session.start();
  return true;
}

/** Refuse a call from anything but the window's own page. */
function fromWindow(event: IpcMainInvokeEvent): void {
  if (event.senderFrame !== window?.webContents.mainFrame) {
    throw new Error("refused: not the Player Two window");
  }
}

async function handle(raw: unknown): Promise<void> {
  const command = commandSchema.parse(raw);
  if (command.do !== "join") {
    if (session === null) {
      throw new PlayerTwoError("join a hub first");
    }
    await session.handle(command);
  } else if (session === null) {
    await join(home, command.hub.trim(), command.name.trim(), command.token.trim(), command.agent.trim() === "" ? DEFAULT_AGENT : command.agent.trim(), http);
    startSession();
    changed();
  }
}

ipcMain.handle("view", (event): View => {
  fromWindow(event);
  return view();
});

ipcMain.handle("command", async (event, raw: unknown): Promise<Outcome> => {
  fromWindow(event);
  try {
    await handle(raw);
    return { ok: true };
  } catch (error) {
    return { ok: false, problem: problemOf(error) };
  }
});

function openOutside(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    shell.openExternal(url).catch(report);
  }
}

function createWindow(): void {
  const created = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 560,
    minHeight: 360,
    title: "Player Two",
    // The window shows text written by teammates and their agents, so it gets no Node, no Electron, and nothing but the preload's four calls.
    webPreferences: { preload: joinPath(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  window = created;
  // A link in a note opens in the user's browser; the window itself never leaves its own page.
  created.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  created.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    openOutside(url);
  });
  created.on("page-title-updated", (event) => {
    event.preventDefault(); // The title says what is waiting; the page does not get to overwrite it.
  });
  created.on("focus", () => {
    session?.attend(true);
  });
  created.on("blur", () => {
    session?.attend(false);
  });
  created.on("close", (event) => {
    const { working, unsent } = session?.view().busy ?? { working: 0, unsent: 0 };
    const losing = [...(working > 0 ? [`${String(working)} agent${working > 1 ? "s" : ""} still working`] : []), ...(unsent > 0 ? [`${String(unsent)} draft${unsent > 1 ? "s" : ""} not sent`] : [])];
    const stay =
      losing.length > 0 &&
      dialog.showMessageBoxSync(created, {
        type: "warning",
        message: `${losing.join(" and ")}.`,
        detail: "Quitting stops the agents and loses the drafts.",
        buttons: ["Quit", "Cancel"],
        defaultId: 1,
        cancelId: 1
      }) === 1;
    if (stay) {
      event.preventDefault();
    }
  });
  created.on("closed", () => {
    window = null;
  });
  created.loadFile(joinPath(import.meta.dirname, "renderer", "index.html")).catch(report);
}

app.on("window-all-closed", () => {
  app.quit(); // With no window there is nobody to approve a run, so the agents and the session go too.
});

app.on("will-quit", (event) => {
  if (session !== null && !stopped) {
    stopped = true;
    event.preventDefault(); // Stop the agents and tell the chat first, then quit for real.
    session
      .stop()
      .catch(report)
      .finally(() => {
        app.quit();
      });
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    startSession();
  })
  .catch((error: unknown) => {
    dialog.showErrorBox("Player Two could not start", problemOf(error));
    app.quit();
  });
