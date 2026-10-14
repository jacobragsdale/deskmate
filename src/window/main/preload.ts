/** The only door between the window and the main process: a few calls, no Node, no Electron. */

import { contextBridge, ipcRenderer } from "electron";

import type { Bridge } from "../../shared/ipc.ts";

function subscribe(channel: string): (listener: (payload: unknown) => void) => () => void {
  return (listener) => {
    const handler = (_event: unknown, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

const bridge: Bridge = {
  view: () => ipcRenderer.invoke("view"),
  command: (command) => ipcRenderer.invoke("command", command),
  onView: subscribe("view"),
  onNotice: subscribe("notice"),
  doctor: (again) => ipcRenderer.invoke("doctor", again),
  distros: () => ipcRenderer.invoke("distros"),
  distro: (name) => ipcRenderer.invoke("distro", name)
};

contextBridge.exposeInMainWorld("playerTwo", bridge);
