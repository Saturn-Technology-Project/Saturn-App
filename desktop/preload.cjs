// The renderer's only bridge to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("saturnDesktop", {
  /** Opens the native folder picker; resolves the chosen absolute paths (empty when cancelled). */
  pickFolders: (options) => ipcRenderer.invoke("saturn:pick-folders", options ?? {}),
  /** The runtime session token, read from the 0600 token file; every runtime request carries it. */
  runtimeToken: () => ipcRenderer.sendSync("saturn:runtime-token") || "",
});

// Renderer spans reach the exporter in main only while telemetry is exported.
if (ipcRenderer.sendSync("saturn:telemetry:enabled") === true) {
  contextBridge.exposeInMainWorld("saturnTelemetry", {
    exportSpans: (spans) => ipcRenderer.send("saturn:telemetry:spans", spans),
  });
}
