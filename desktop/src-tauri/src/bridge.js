// The renderer's only bridge to the app, in the main frame only: it holds the runtime token, which no iframe may see.
(() => {
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const threadListeners = new Set();

  window.saturnDesktop = Object.freeze({
    /** Opens the native folder picker; resolves the chosen absolute paths (empty when cancelled). */
    pickFolders: (options) => invoke("pick_folders", { options: options ?? {} }),
    /** The runtime session token; every runtime request carries it. */
    runtimeToken: () => __SATURN_TOKEN__,
    /** Where the runtime listens. */
    runtimeOrigin: () => __SATURN_ORIGIN__,
    /** Whether this window is the one the user is looking at (notifications are skipped then). */
    isFocused: () => document.hasFocus() && document.visibilityState === "visible",
    /** Called with { agentId, threadId } when a notification is clicked. */
    onOpenThread: (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
  });
  // The app calls this when a notification is clicked.
  Object.defineProperty(window, "__saturnOpenThread", {
    value: (payload) => threadListeners.forEach((listener) => listener(payload)),
  });

  // Dragging the window. WebKit has no app-region, so the stylesheet marks regions with --app-region (inherited, and
  // reset with "no-drag" on what stays clickable) and this starts the native drag.
  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (getComputedStyle(event.target).getPropertyValue("--app-region").trim() !== "drag") return;
    event.preventDefault();
    void invoke(event.detail === 2 ? "toggle_maximize" : "start_dragging");
  });
})();
