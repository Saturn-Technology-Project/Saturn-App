// The renderer's only bridge to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("saturnDesktop", {
  /** Opens the native folder picker; resolves the chosen absolute paths (empty when cancelled). */
  pickFolders: (options) => ipcRenderer.invoke("saturn:pick-folders", options ?? {}),
  /** The runtime session token, read from the 0600 token file; every runtime request carries it. */
  runtimeToken: () => ipcRenderer.sendSync("saturn:runtime-token") || "",
  /** A system notification; clicking it brings Saturn forward and opens the chat named by `threadId`. */
  notify: (options) => ipcRenderer.send("saturn:notify", options ?? {}),
  /** Called with { agentId, threadId } when a notification is clicked. */
  onOpenThread: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("saturn:open-thread", handler);
    return () => ipcRenderer.removeListener("saturn:open-thread", handler);
  },
  /** Asks macOS for Accessibility or Screen Recording (its own prompt, and Saturn listed in System Settings). */
  requestPermission: (which) => ipcRenderer.invoke("saturn:request-permission", which),
  /** Whether this window is the one the user is looking at (notifications are skipped then). */
  isFocused: () => ipcRenderer.sendSync("saturn:window-focused") === true,
});

// Renderer spans reach the exporter in main only while telemetry is exported.
if (ipcRenderer.sendSync("saturn:telemetry:enabled") === true) {
  contextBridge.exposeInMainWorld("saturnTelemetry", {
    exportSpans: (spans) => ipcRenderer.send("saturn:telemetry:spans", spans),
  });
}
