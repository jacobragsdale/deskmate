/**
 * The desktop app's main process: one window, the desk it starts and speaks to, and the operating system's notifications, badge, dialogs and tray icon. The session is not here: it is in the desk,
 * a process of its own. While a grant of the user's is live, closing the window hides it to the tray, so the desk goes on answering under it; Quit in the tray's menu quits.
 */

import { join as joinPath } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import type { IpcMainInvokeEvent, NativeImage } from "electron";

import { noteIn, noteOf } from "../../core/links.ts";
import { problemOf } from "../../core/text.ts";
import { commandSchema } from "../../shared/ipc.ts";
import type { Arrival, Check, DistroChoice, Notice, Outcome, Question, View } from "../../shared/ipc.ts";
import { DeskProcess, localLaunch, windowChecks, wslLaunch } from "./deskProcess.ts";
import { distroSchema, loadSettings, saveSettings } from "./settings.ts";
import type { Settings } from "./settings.ts";
import { listDistros } from "./wsl.ts";

const START_WAIT = 120_000; // Milliseconds the setup page waits for a desk it started afresh: WSL can take half a minute to start, and the runtime is unpacked first.
const HIDDEN = "--hidden"; // How the app is started at login on Windows: with its window hidden, in the tray.
// Whether the app can start itself at login: Electron can on Windows and macOS, and a copy run from its source, as in development, would register the bare Electron binary.
const LOGIN = (process.platform === "win32" || process.platform === "darwin") && app.isPackaged;
const ICON = 32; // Pixels across the tray's icon, drawn at twice the size it is shown, for screens that scale by two.
const ICON_BGR = [0xc4, 0x3f, 0x7a] as const; // Its colour, an agent's answer's (#7a3fc4), in the order a bitmap holds it.

let window: BrowserWindow | null = null;
let current: View | null = null; // What the desk last said to draw; null until it has said anything.
let stopped = false;
let quitting = false; // Once the user, the tray's Quit or the system has asked the app to quit: the window then closes for real.
let tray: Tray | null = null;
let linked: string | null = noteIn(process.argv); // A note a link asked for that the desk has not been asked to open yet: one the app was started with waits until the chats are loaded.

function report(error: unknown): void {
  console.error(error);
}

/** The window's own settings, as saved. */
function settings(): Settings {
  return loadSettings(app.getPath("userData"));
}

/** Whether a grant of the user's is live: a teammate's request may then need their agent while nobody looks at the window. */
function granting(): boolean {
  return current?.kind === "chat" && current.grants.length > 0;
}

/** Start at login, hidden, or stop doing so, where the app can, and say so in the tray's menu. */
function startAtLogin(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN] });
  saveSettings(app.getPath("userData"), { atLogin: on });
  trayMenu();
}

/** Send the window what to draw, and put what needs the user where they see it without the window: the title and the dock badge. The first grant turns starting at login on, until the user turns it off. */
function show(view: View): void {
  current = view;
  openLinked();
  if (LOGIN && granting() && settings().atLogin === undefined) {
    startAtLogin(true);
  }
  if (window === null || window.isDestroyed()) {
    return;
  }
  window.webContents.send("view", view);
  if (view.kind === "chat") {
    window.setTitle(["Player Two", ...(view.waiting > 0 ? [`${String(view.waiting)} waiting`] : []), ...(view.unread > 0 ? [`${String(view.unread)} unread`] : [])].join(" · "));
    app.setBadgeCount(view.waiting + view.unread);
  }
}

/** Bring the window to the front, from the taskbar too. */
function bringUp(): void {
  if (window?.isMinimized() === true) {
    window.restore();
  }
  window?.show();
  window?.focus();
}

function open(chat: string): void {
  bringUp();
  desk.send({ do: "open", chat }).catch(report);
}

/** Have the desk open the note a link asked for, once it has loaded the chats. A note the user cannot see is said so in the window, as the desk words it. */
function openLinked(): void {
  const id = linked;
  if (id === null || current?.kind !== "chat" || !current.loaded) {
    return;
  }
  linked = null;
  desk
    .send({ do: "openNote", id })
    .then((outcome) => {
      if (!outcome.ok) {
        const notice: Notice = { title: "", body: outcome.problem, severity: "error" };
        window?.webContents.send("notice", notice);
      }
    })
    .catch(report);
}

/** A link the system handed over, as the id of the note it names, already checked to be exactly a note link, or null for anything else: the window comes up either way, and only a note is opened. */
function follow(id: string | null): void {
  bringUp();
  if (id !== null) {
    linked = id;
    openLinked();
  }
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

/** The tray's icon: a filled circle, drawn here, as the app ships no image of its own. Its edge is smoothed, and its colour premultiplied by its opacity, as a bitmap's is. */
function trayIcon(): NativeImage {
  const pixels = Buffer.alloc(ICON * ICON * 4);
  for (let y = 0; y < ICON; y += 1) {
    for (let x = 0; x < ICON; x += 1) {
      const cover = Math.min(1, Math.max(0, ICON / 2 - Math.hypot(x + 0.5 - ICON / 2, y + 0.5 - ICON / 2)));
      pixels.set([...ICON_BGR.map((each) => Math.round(each * cover)), Math.round(cover * 255)], (y * ICON + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: ICON, height: ICON, scaleFactor: 2 });
}

/** The tray's menu: open the window, start at login where the app can, and quit for real. */
function trayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Player Two", click: bringUp },
      ...(LOGIN
        ? [
            {
              label: "Start at login, hidden",
              type: "checkbox" as const,
              checked: settings().atLogin === true,
              click: (item: { readonly checked: boolean }): void => {
                startAtLogin(item.checked);
              }
            }
          ]
        : []),
      { type: "separator" },
      {
        label: "Quit",
        click: (): void => {
          app.quit();
        }
      }
    ])
  );
}

/** Put the app in the tray. Where the system has no tray to show it in, it is still there to take, and starting the app again brings the window back. */
function makeTray(): void {
  try {
    tray = new Tray(trayIcon());
  } catch (error) {
    report(error);
    return;
  }
  tray.setToolTip("Player Two");
  tray.on("click", bringUp);
  trayMenu();
}

/** Tell the user, the first time ever, that closing the window hid it rather than quitting, and how to quit. */
function toldHidden(): void {
  if (settings().toldHidden === true) {
    return;
  }
  saveSettings(app.getPath("userData"), { toldHidden: true });
  if (Notification.isSupported()) {
    new Notification({
      title: "Player Two is still running",
      body: "A grant of yours is live, so Player Two stays in the tray to let your agent answer under it. Quit from the tray icon's menu to stop it."
    }).show();
  }
}

function openOutside(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    shell.openExternal(url).catch(report);
  }
}

/** The window, shown at once unless the app was started at login, when it waits in the tray. */
function createWindow(hidden: boolean): void {
  const created = new BrowserWindow({
    show: !hidden,
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
  created.on("session-end", () => {
    quitting = true; // Windows is shutting down or signing the user out, which does not say before-quit: the window closes for real.
  });
  created.on("close", (event) => {
    if (!quitting && granting()) {
      event.preventDefault(); // Hidden, not closed: the desk goes on answering under the user's grants.
      created.hide();
      toldHidden();
      return;
    }
    const { working, unsent } = current?.kind === "chat" ? current.busy : { working: 0, unsent: 0 };
    const losing = [...(working > 0 ? [`${String(working)} agent${working > 1 ? "s" : ""} still working`] : []), ...(unsent > 0 ? [`${String(unsent)} draft${unsent > 1 ? "s" : ""} not sent`] : [])];
    if (losing.length > 0) {
      bringUp(); // Quitting from the tray: the warning is about this window's agents and drafts.
    }
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
      quitting = false; // The user stayed: closing the window later hides it again while a grant is live.
    }
  });
  created.on("closed", () => {
    window = null;
  });
  created.loadFile(joinPath(import.meta.dirname, "renderer", "index.html")).catch(report);
}

// One copy of the app at a time, so that a link opened while it runs goes to the window already open: a second copy hands the first its arguments and quits.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
}
app.on("second-instance", (_event, argv) => {
  follow(noteIn(argv));
});
// On macOS a link comes this way, at start-up as later, rather than among the arguments.
app.on("open-url", (event, url) => {
  event.preventDefault();
  follow(noteOf(url));
});

app.on("window-all-closed", () => {
  app.quit(); // With no window there is nobody to approve a run, so the desk and its agents go too.
});

app.on("before-quit", () => {
  quitting = true;
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
    if (!primary) {
      return;
    }
    // Links to notes open this app. A copy run from its source, as in development and the smoke test, leaves the system's handler alone: it would be the bare Electron binary.
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient("player-two");
    }
    // Started at login it waits in the tray: on Windows it is given HIDDEN, and macOS says whether it opened it at login.
    createWindow(process.argv.includes(HIDDEN) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin));
    makeTray();
    desk.start();
    desk.attend(window?.isFocused() ?? true);
  })
  .catch((error: unknown) => {
    dialog.showErrorBox("Player Two could not start", problemOf(error));
    app.quit();
  });
