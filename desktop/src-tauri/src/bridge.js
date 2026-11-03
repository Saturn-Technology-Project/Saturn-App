// The renderer's only bridge to the app, in the main frame only: it holds the runtime token, which no iframe may see.
(() => {
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const threadListeners = new Set();
  let windowButtons = null;

  // On Windows the window has no frame: Saturn draws the three buttons over the top right of the page.
  function drawWindowButtons() {
    windowButtons = document.createElement("div");
    windowButtons.style.cssText = "position:fixed;top:0;right:0;height:38px;display:flex;z-index:2147483647;background:#1c1c1f;color:#f4f4f5;--app-region:no-drag";
    for (const [label, glyph, command] of [["Minimize", "\uE921", "minimize_window"], ["Maximize", "\uE922", "toggle_maximize"], ["Close", "\uE8BB", "close_window"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = glyph;
      button.setAttribute("aria-label", label);
      button.style.cssText = "width:46px;height:100%;border:0;background:transparent;color:inherit;font:10px 'Segoe MDL2 Assets';cursor:default";
      button.addEventListener("click", () => void invoke(command));
      windowButtons.append(button);
    }
    document.documentElement.append(windowButtons);
  }

  function paintWindowButtons(colors) {
    const hex = /^#[0-9a-f]{6}$/i;
    if (!windowButtons || !hex.test(colors.color) || !hex.test(colors.symbolColor)) return;
    windowButtons.style.background = colors.color;
    windowButtons.style.color = colors.symbolColor;
  }

  if (__SATURN_WINDOW_BUTTONS__) {
    if (document.documentElement) drawWindowButtons();
    else document.addEventListener("DOMContentLoaded", drawWindowButtons, { once: true });
  }

  window.saturnDesktop = Object.freeze({
    /** Opens the native folder picker; resolves the chosen absolute paths (empty when cancelled). */
    pickFolders: (options) => invoke("pick_folders", { options: options ?? {} }),
    /** The runtime session token; every runtime request carries it. */
    runtimeToken: () => __SATURN_TOKEN__,
    /** Where the runtime listens. */
    runtimeOrigin: () => __SATURN_ORIGIN__,
    /** Whether this window is the one the user is looking at (notifications are skipped then). */
    isFocused: () => document.hasFocus() && document.visibilityState === "visible",
    /** A system notification; clicking it brings Saturn forward and opens the chat named by `threadId`. */
    notify: (options) => void invoke("notify", { options: options ?? {} }),
    /** Asks macOS for Accessibility or Screen Recording (its own prompt, and Saturn listed in System Settings). */
    requestPermission: (which) => invoke("request_permission", { which }),
    /** Recolors the minimize, maximize and close buttons (Windows only). */
    setWindowControls: (colors) => paintWindowButtons(colors ?? {}),
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
