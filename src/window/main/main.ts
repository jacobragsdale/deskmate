/** The desktop app's main process: one window, the desk it starts and speaks to, and the operating system's notifications, badge and dialogs. The session is not here: it is in the desk, a process of its own. */

import { join as joinPath } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import { problemOf } from "../../core/text.ts";
import { commandSchema } from "../../shared/ipc.ts";
import type { Arrival, Check, DistroChoice, Outcome, Question, View } from "../../shared/ipc.ts";
import { DeskProcess, localLaunch, windowChecks, wslLaunch } from "./deskProcess.ts";
import { distroSchema, loadSettings, saveSettings } from "./settings.ts";
import { listDistros } from "./wsl.ts";

const START_WAIT = 120_000; // Milliseconds the setup page waits for a desk it started afresh: WSL can take half a minute to start, and the runtime is unpacked first.

let window: BrowserWindow | null = null;
let current: View | null = null; // What the desk last said to draw; null until it has said anything.
let stopped = false;

function report(error: unknown): void {
  console.error(error);
}

/** Send the window what to draw, and put what needs the user where they see it without the window: the title and the dock badge. */
function show(view: View): void {
  current = view;
  if (window === null || window.isDestroyed()) {
    return;
  }
  window.webContents.send("view", view);
  if (view.kind === "chat") {
    window.setTitle(["Player Two", ...(view.waiting > 0 ? [`${String(view.waiting)} waiting`] : []), ...(view.unread > 0 ? [`${String(view.unread)} unread`] : [])].join(" · "));
    app.setBadgeCount(view.waiting + view.unread);
  }
}

function open(chat: string): void {
  window?.show();
  window?.focus();
  desk.send({ do: "open", chat }).catch(report);
}

/** Tell the user about a message or an answer with the system's own notification, unless they are already looking at its chat. */
function arrived(arrival: Arrival): void {
  const looking = window?.isFocused() === true && current?.kind === "chat" && current.current?.chat === arrival.chat;
  if (looking || !Notification.isSupported()) {
    return;
  }
  const notification = new Notification({ title: arrival.title, body: arrival.body, silent: !arrival.rings });
  notification.on("click", () => {
    open(arrival.chat);
  });
  notification.show();
}

/** Put the desk's question to the user in a dialog of the system's own, and give the desk their answer. A dialog that could not be shown is a no. */
function ask(id: number, question: Question): void {
  const options = { type: "question" as const, message: question.message, detail: question.detail, buttons: [question.confirm, "Cancel"], defaultId: 0, cancelId: 1 };
  (window === null ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options)).then(
    ({ response }) => {
      desk.answer(id, response === 0);
    },
    (error: unknown) => {
      report(error);
      desk.answer(id, false);
    }
  );
}

// On Windows the desk runs inside WSL, in the distribution chosen in settings.json, from the runtime the installer put among the app's resources. Anywhere else it runs beside the window.
const desk = new DeskProcess(process.platform === "win32" ? () => wslLaunch(loadSettings(app.getPath("userData")).distro, process.resourcesPath) : localLaunch, {
  view: show,
  notice: (notice) => {
    window?.webContents.send("notice", notice);
  },
  arrival: arrived,
  ask
});

/** Refuse a call from anything but the window's own page. */
function fromWindow(event: IpcMainInvokeEvent): void {
  if (event.senderFrame !== window?.webContents.mainFrame) {
    throw new Error("refused: not the Player Two window");
  }
}

ipcMain.handle("view", (event): View | null => {
  fromWindow(event);
  return current;
});

ipcMain.handle("command", async (event, raw: unknown): Promise<Outcome> => {
  fromWindow(event);
  // Checked here as well as in the desk: the desk answers only a line it can read, so one it cannot would leave the window waiting.
  const command = commandSchema.safeParse(raw);
  return command.success ? desk.send(command.data) : { ok: false, problem: problemOf(command.error) };
});

/** Stop the desk and start it again, then wait until it has said hello or been given up on, or for START_WAIT. */
async function startAfresh(): Promise<void> {
  await desk.restart();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    desk.started(),
    new Promise((resolve) => {
      timer = setTimeout(resolve, START_WAIT);
    })
  ]);
  clearTimeout(timer);
}

// The setup check. On Windows the window's own part comes first, and only once it passes is there a desk to ask for the rest.
ipcMain.handle("doctor", async (event, again: unknown): Promise<Check[]> => {
  fromWindow(event);
  // "Check again" starts afresh a desk that is not up, so that what the user fixed is tried. One that is up is left alone, and its agents with it.
  if (again === true && !desk.saidHello) {
    await startAfresh();
  }
  const own = process.platform === "win32" ? await windowChecks(loadSettings(app.getPath("userData")).distro, process.resourcesPath, desk.saidHello) : [];
  if (own.some((check) => check.status === "fail")) {
    return own;
  }
  const asked = await desk.send({ do: "doctor" });
  return [...own, ...(asked.ok ? (asked.data ?? []) : [{ id: "desk", title: "The desk answers", status: "fail" as const, detail: asked.problem, fix: "" }])];
});

// Run the desk in another WSL distribution from now on, or with null in the default one, for the setup page's picker.
ipcMain.handle("distro", async (event, raw: unknown): Promise<Outcome> => {
  fromWindow(event);
  const distro = distroSchema.safeParse(raw);
  if (!distro.success) {
    return { ok: false, problem: problemOf(distro.error) };
  }
  saveSettings(app.getPath("userData"), { distro: distro.data });
  await startAfresh();
  return { ok: true };
});

// The distributions to choose from on the setup page, and the one chosen. Off Windows there is no choice to make.
ipcMain.handle("distros", async (event): Promise<DistroChoice | null> => {
  fromWindow(event);
  if (process.platform !== "win32") {
    return null;
  }
  const listed = await listDistros();
  return { chosen: loadSettings(app.getPath("userData")).distro, names: listed.ok ? listed.value.map((each) => each.name) : [] };
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
    // The window shows text written by teammates and their agents, so it gets no Node, no Electron, and nothing but the preload's few calls.
    webPreferences: { preload: joinPath(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  window = created;
  // A link in a message opens in the user's browser; the window itself never leaves its own page.
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
    desk.attend(true);
  });
  created.on("blur", () => {
    desk.attend(false);
  });
  created.on("close", (event) => {
    const { working, unsent } = current?.kind === "chat" ? current.busy : { working: 0, unsent: 0 };
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
  app.quit(); // With no window there is nobody to approve a run, so the desk and its agents go too.
});

app.on("will-quit", (event) => {
  if (!stopped) {
    stopped = true;
    event.preventDefault(); // Let the desk stop its agents and tell the chat first, then quit for real.
    desk
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
    desk.start();
    desk.attend(window?.isFocused() ?? true);
  })
  .catch((error: unknown) => {
    dialog.showErrorBox("Player Two could not start", problemOf(error));
    app.quit();
  });
