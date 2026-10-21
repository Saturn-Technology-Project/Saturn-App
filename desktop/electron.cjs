const { app, BrowserWindow, Notification, desktopCapturer, dialog, ipcMain, systemPreferences } = require("electron");
const { ROOT_CONTEXT, SpanStatusCode, propagation } = require("@opentelemetry/api");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { startTelemetry, traced } = require("./telemetry.cjs");

const HOST = "127.0.0.1";
// SATURN_RUNTIME_PORT moves the runtime (and lets a second copy run beside another, e.g. for testing).
const PORT = Number(process.env.SATURN_RUNTIME_PORT) || 4700;

let runtime;
let ownsRuntime = false;

// The data folder was named after the npm package; keep it (it holds the window's local settings) while the
// app and its menus say "Saturn". SATURN_USER_DATA_DIR gives a separate profile, e.g. for a second test copy.
app.setPath("userData", process.env.SATURN_USER_DATA_DIR || path.join(app.getPath("appData"), "@saturn", "desktop"));
app.setName("Saturn");

// One Saturn at a time (on Windows each click on the .exe would start another); a second launch shows this one.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

const telemetry = startTelemetry();

function runtimeDir() {
  return path.join(__dirname, "..", "runtime");
}

function findNode() {
  if (process.env.SATURN_NODE && fs.existsSync(process.env.SATURN_NODE)) return process.env.SATURN_NODE;
  const dirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

/** With telemetry on, the probe carries `parent` in traceparent, so the runtime's GET /health joins the startup trace. */
function probe(parent = ROOT_CONTEXT) {
  const headers = {};
  propagation.inject(parent, headers);
  return new Promise((resolve) => {
    const req = http.get({ hostname: HOST, port: PORT, path: "/health", timeout: 500, headers }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startRuntime() {
  const packaged = app.isPackaged;
  const root = packaged ? path.join(process.resourcesPath, "runtime") : runtimeDir();
  const command = packaged ? process.execPath : findNode();
  const args = packaged
    ? [path.join(root, "dist", "main.js")]
    : [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "watch", path.join(root, "src", "main.ts")];
  const env = {
    ...process.env,
    SATURN_RUNTIME_HOST: HOST,
    SATURN_RUNTIME_PORT: String(PORT),
    SATURN_DESKTOP_ATTACHED: "1",
    SATURN_DESKTOP_PID: String(process.pid),
  };
  if (packaged) {
    // The built-in embedding model for the code index ships inside the app (scripts/fetch-embedding-model.mjs).
    env.SATURN_MODELS_DIR = path.join(process.resourcesPath, "models");
    env.ELECTRON_RUN_AS_NODE = "1";
    // Electron's fs treats .asar files as folders; the runtime copies and deletes bundles that contain them.
    env.ELECTRON_NO_ASAR = "1";
  }
  // The bundled Saturn IDE (see scripts/bundle-ide.cjs): an app bundle on macOS, a folder with the executable
  // elsewhere. In development the runtime finds the local build.
  const ide = path.join(process.resourcesPath, process.platform === "darwin" ? "Saturn IDE.app" : "Saturn IDE");
  const ideBinary = process.platform === "darwin" ? ide : path.join(ide, process.platform === "win32" ? "Saturn IDE.exe" : "saturn-ide");
  if (packaged && !env.SATURN_IDE_APP && fs.existsSync(ideBinary)) env.SATURN_IDE_APP = ide;
  ownsRuntime = true;
  runtime = spawn(command, args, { cwd: root, stdio: "inherit", env });
  runtime.on("error", (error) => {
    console.error("Saturn Runtime did not start.", error.message);
  });
}

function waitForRuntime(parent) {
  return traced("desktop.start_runtime", parent, async (span, context) => {
    let checks = 1;
    try {
      const reused = await probe(context);
      span.setAttribute("saturn.runtime.reused", reused);
      if (reused) return;
      startRuntime();
      if (runtime?.pid) span.setAttribute("saturn.runtime.pid", runtime.pid);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        checks += 1;
        if (await probe(context)) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      console.error("Saturn Runtime did not become ready.");
      span.setAttribute("error.type", "timeout");
      span.setStatus({ code: SpanStatusCode.ERROR, message: "Saturn Runtime did not become ready." });
    } finally {
      span.setAttribute("saturn.runtime.health_checks", checks);
    }
  });
}

const UI_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

let uiUrl = null;

/** Where the renderer is served: Vite in development, the bundled UI (started once) when packaged. */
function rendererUrl() {
  if (!app.isPackaged) return Promise.resolve("http://127.0.0.1:5174/");
  uiUrl ??= serveUi();
  return uiUrl;
}

function serveUi() {
  const root = path.join(__dirname, "dist");
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://${HOST}`);
      const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(file, (error, body) => {
        if (error) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": UI_TYPES[path.extname(file)] ?? "application/octet-stream" });
        res.end(body);
      });
    });
    const listen = (port) => {
      const onError = (error) => {
        if (error.code === "EADDRINUSE" && port !== 0) listen(0);
        else reject(error);
      };
      server.once("error", onError);
      server.listen(port, HOST, () => {
        server.off("error", onError);
        const address = server.address();
        const chosen = address && typeof address === "object" ? address.port : port;
        resolve(`http://${HOST}:${chosen}/`);
      });
    };
    listen(5174);
  });
}

let mainWindow = null;
let startedUp = false;

/** The runtime's session token, from the 0600 token file in the data dir it uses (default ~/.saturn-app). */
function runtimeToken() {
  const dir = process.env.SATURN_DATA_DIR || path.join(os.homedir(), ".saturn-app");
  try {
    return fs.readFileSync(path.join(dir, "runtime-token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** GET/POST against the local runtime from the main process; resolves undefined when it does not answer. */
function runtimeRequest(method, route, timeout = 30_000) {
  const token = runtimeToken();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: route, method, timeout, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(res.statusCode && res.statusCode < 400 ? JSON.parse(body || "null") : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

async function createWindow(parent, options = {}) {
  const window = new BrowserWindow({
    show: options.show !== false,
    width: 1320,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#161618",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  await traced("desktop.load_window", parent, async () => {
    await window.loadURL(await rendererUrl());
  });
}

let settingsWindow = null;

/**
 * Settings in a window of its own, without the Agent App: what Saturn IDE's "Saturn Settings" opens
 * (saturn://settings). A second request brings the same window forward.
 */
async function openSettingsWindow(page) {
  const hash = page ? `#settings/${page}` : "#settings";
  if (settingsWindow) {
    if (page) await settingsWindow.loadURL(`${await rendererUrl()}${hash}`);
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    show: false,
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    title: "Saturn Settings",
    backgroundColor: "#161618",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  settingsWindow = window;
  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  await window.loadURL(`${await rendererUrl()}${hash}`);
}

/** saturn://settings or saturn://settings/<page>; other links are ignored. */
function settingsLink(url) {
  try {
    const link = new URL(url);
    if (link.protocol !== "saturn:" || link.hostname !== "settings") return null;
    const page = link.pathname.replace(/^\/+/, "").split("/")[0];
    return { page: /^[a-z]+$/.test(page) ? page : undefined };
  } catch {
    return null;
  }
}

// Saturn IDE opens saturn:// links. On macOS they arrive here, also when the link is what launched Saturn.
let pendingLink = null;
app.on("open-url", (event, url) => {
  event.preventDefault();
  const link = settingsLink(url);
  if (!link) return;
  if (app.isReady() && startedUp) void openSettingsWindow(link.page);
  else pendingLink = link;
});
if (process.defaultApp) {
  // Development: register this Electron with the script it runs, so the scheme reaches the dev app.
  app.setAsDefaultProtocolClient("saturn", process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("saturn");
}

// The preload exposes the renderer's span exporter only when telemetry is exported.
ipcMain.on("saturn:telemetry:enabled", (event) => {
  event.returnValue = telemetry.enabled;
});

// The renderer reads the runtime token from here (it has no filesystem access) and sends it on every request.
ipcMain.on("saturn:runtime-token", (event) => {
  event.returnValue = runtimeToken();
});

ipcMain.on("saturn:window-focused", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  event.returnValue = Boolean(window && window.isFocused() && window.isVisible());
});

// A system notification from the renderer (an agent finished, failed, or needs an approval). Clicking it brings
// the window that sent it forward and tells it which chat to open.
ipcMain.on("saturn:notify", (event, options) => {
  if (!Notification.isSupported()) return;
  const sender = BrowserWindow.fromWebContents(event.sender);
  const notification = new Notification({ title: String(options.title || "Saturn"), body: String(options.body || ""), silent: Boolean(options.silent) });
  notification.on("click", () => {
    const window = sender && !sender.isDestroyed() ? sender : mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (options.threadId) window.webContents.send("saturn:open-thread", { agentId: options.agentId, threadId: options.threadId });
  });
  notification.show();
});

// macOS permissions for computer use, asked by Saturn itself: macOS then shows its own prompt and lists Saturn in
// System Settings, so there is nothing to find or add by hand. Accessibility prompts once per launch at most;
// Screen Recording is asked by a one-pixel capture. Elsewhere there is nothing to grant.
ipcMain.handle("saturn:request-permission", async (_event, which) => {
  if (process.platform !== "darwin") return { granted: true };
  if (which === "accessibility") return { granted: systemPreferences.isTrustedAccessibilityClient(true) };
  if (which === "screenRecording") {
    if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
      await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
    }
    return { granted: systemPreferences.getMediaAccessStatus("screen") === "granted" };
  }
  return { granted: false };
});

// Workspace folders: the native picker, attached to the window that asked.
ipcMain.handle("saturn:pick-folders", async (event, options) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(owner ?? undefined, {
    title: typeof options?.title === "string" ? options.title : "Add Folder",
    buttonLabel: "Add",
    properties: ["openDirectory", "createDirectory", ...(options?.multiple === false ? [] : ["multiSelections"])],
  });
  return result.canceled ? [] : result.filePaths;
});

if (telemetry.enabled) {
  ipcMain.on("saturn:telemetry:spans", (event, spans) => {
    if (event.sender.getType() === "window") telemetry.exportRendererSpans(spans);
  });
}

/** True while a Saturn IDE window uses the runtime (it reports in every 15 s, and counts while starting up). */
async function ideOpen() {
  const clients = await runtimeRequest("GET", "/runtime/clients", 5_000);
  return Array.isArray(clients) && clients.some((client) => client.kind === "ide");
}

let ideWatch = null;

/**
 * With no Saturn window on screen (the IDE opened at launch, or the user closed the Agent App while the IDE was
 * open), Saturn only keeps the runtime alive for Saturn IDE. Once no IDE is open any more, Saturn quits and the
 * runtime stops with it. A window on screen, or Saturn hidden by the user (⌘H), keeps it running.
 */
function watchForIde() {
  if (ideWatch || !ownsRuntime) return;
  ideWatch = setInterval(async () => {
    const onScreen = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible());
    const hiddenByUser = process.platform === "darwin" && app.isHidden();
    if (onScreen || hiddenByUser) return;
    if (await ideOpen()) return;
    clearInterval(ideWatch);
    ideWatch = null;
    app.quit();
  }, 10_000);
}

/**
 * Updates from GitHub Releases (electron-updater): downloaded in the background and installed when Saturn quits.
 * On macOS this needs a Developer ID signature (Squirrel.Mac refuses ad-hoc builds), so an unsigned build skips it
 * and says why in the log; Windows checks either way.
 */
function checkForUpdates() {
  if (!app.isPackaged || process.env.SATURN_NO_UPDATES) return;
  if (process.platform === "darwin" && !signedWithDeveloperId()) {
    console.log("[updates] skipped: this build is not signed with a Developer ID, which macOS updates require");
    return;
  }
  try {
    const { autoUpdater } = require("electron-updater");
    // Saturn's releases are pre-releases for now.
    autoUpdater.allowPrerelease = true;
    autoUpdater.on("error", (error) => console.log(`[updates] ${error?.message ?? error}`));
    autoUpdater.on("update-downloaded", (info) => console.log(`[updates] ${info.version} downloaded; it installs when Saturn quits`));
    void autoUpdater.checkForUpdatesAndNotify().catch((error) => console.log(`[updates] check failed: ${error?.message ?? error}`));
  } catch (error) {
    console.log(`[updates] unavailable: ${error?.message ?? error}`);
  }
}

/** Whether the running app bundle carries a Developer ID signature (an ad-hoc one has no team). */
function signedWithDeveloperId() {
  try {
    const bundle = path.resolve(path.dirname(process.execPath), "..", "..");
    const result = require("node:child_process").spawnSync("codesign", ["-dv", bundle], { encoding: "utf8" });
    const team = /TeamIdentifier=(\S+)/.exec(`${result.stdout}${result.stderr}`);
    return Boolean(team && team[1] !== "not" && team[1] !== "not set");
  } catch {
    return false;
  }
}

app.whenReady().then(() =>
  primary && traced("desktop.startup", ROOT_CONTEXT, async (span, context) => {
    span.setAttribute("saturn.desktop.packaged", app.isPackaged);
    // 1. Start Runtime first
    await waitForRuntime(context);
    // 2. Open the default app (Settings → General → Open at Launch). The runtime opens Saturn IDE and says whether
    //    it did; the first run may also install the bundled IDE, hence the long timeout. A settings link came from
    //    Saturn IDE, which is already open, so nothing is woken then.
    const wakeup = pendingLink ? null : await runtimeRequest("POST", "/runtime/wakeup", 180_000);
    // The Agent App hides only when the IDE really opened (or for a settings link); if waking failed, it shows,
    // so a launch never ends with nothing on screen.
    const launchIde = pendingLink !== null || (wakeup?.target === "ide" && wakeup?.opened === true);
    span.setAttribute("saturn.desktop.launch_app", launchIde ? "ide" : "agent");
    await createWindow(context, { show: !launchIde });
    if (!launchIde) {
      mainWindow?.show();
      mainWindow?.focus();
    } else {
      watchForIde();
    }
    startedUp = true;
    checkForUpdates();
    if (pendingLink) {
      const { page } = pendingLink;
      pendingLink = null;
      await openSettingsWindow(page);
    }
  }),
);

app.on("activate", () => {
  if (!app.isReady()) return;
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    void createWindow(ROOT_CONTEXT);
  }
});

app.on("window-all-closed", async () => {
  // Saturn IDE still uses the runtime: stay in the background (Dock) and quit once the IDE closes too.
  if (ownsRuntime && (await ideOpen())) {
    watchForIde();
    return;
  }
  if (ownsRuntime) runtime?.kill();
  app.quit();
});

// A second launch (Windows .exe, `open -n`): bring this Saturn forward, or open the settings link it carried.
app.on("second-instance", (_event, argv) => {
  const link = argv.map(settingsLink).find(Boolean);
  if (link && startedUp) {
    void openSettingsWindow(link.page);
    return;
  }
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (app.isReady()) {
    void createWindow(ROOT_CONTEXT);
  }
});

// Quitting (⌘Q, Dock > Quit) skips window-all-closed, so the runtime Saturn started is stopped here too.
app.on("will-quit", () => {
  if (ownsRuntime && runtime && runtime.exitCode === null) runtime.kill();
});

let flushed = false;
app.on("will-quit", (event) => {
  if (!telemetry.enabled || flushed) return;
  flushed = true;
  event.preventDefault();
  void telemetry.shutdown().finally(() => app.quit());
});
