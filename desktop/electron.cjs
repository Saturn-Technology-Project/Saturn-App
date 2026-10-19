const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { ROOT_CONTEXT, SpanStatusCode, propagation } = require("@opentelemetry/api");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { startTelemetry, traced } = require("./telemetry.cjs");

const HOST = "127.0.0.1";
const PORT = 4700;

let runtime;
let ownsRuntime = false;

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
  if (packaged) env.ELECTRON_RUN_AS_NODE = "1";
  // The bundled Saturn IDE (see scripts/bundle-ide.cjs); in development the runtime finds the local build.
  const ide = path.join(process.resourcesPath, "Saturn IDE.app");
  if (packaged && !env.SATURN_IDE_APP && fs.existsSync(ide)) env.SATURN_IDE_APP = ide;
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
function runtimeRequest(method, route) {
  const token = runtimeToken();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: route, method, timeout: 30_000, headers }, (res) => {
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

app.whenReady().then(() =>
  traced("desktop.startup", ROOT_CONTEXT, async (span, context) => {
    span.setAttribute("saturn.desktop.packaged", app.isPackaged);
    // 1. Start Runtime first
    await waitForRuntime(context);
    // 2. Runtime wakes up Saturn IDE or Agent App based on settings.launchApp
    // A settings link came from Saturn IDE, which is already open: do not wake an app.
    const wakeup = pendingLink ? null : (await runtimeRequest("GET", "/runtime/wakeup")) || (await runtimeRequest("GET", "/settings"));
    // Launched by a saturn://settings link: only the Settings window shows; the Agent App stays hidden in the Dock.
    const launchIde = pendingLink !== null || (wakeup?.target || wakeup?.launchApp) === "ide";
    span.setAttribute("saturn.desktop.launch_app", launchIde ? "ide" : "agent");
    await createWindow(context, { show: !launchIde });
    if (!launchIde) {
      mainWindow?.show();
      mainWindow?.focus();
    }
    startedUp = true;
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

app.on("window-all-closed", () => {
  if (ownsRuntime) runtime?.kill();
  app.quit();
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
