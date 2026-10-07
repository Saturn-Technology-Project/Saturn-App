const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 4700;

let runtime;
let ownsRuntime = false;

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

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: HOST, port: PORT, path: "/health", timeout: 500 }, (res) => {
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
    : [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "main.ts")];
  const env = {
    ...process.env,
    SATURN_RUNTIME_HOST: HOST,
    SATURN_RUNTIME_PORT: String(PORT),
  };
  if (packaged) env.ELECTRON_RUN_AS_NODE = "1";
  ownsRuntime = true;
  runtime = spawn(command, args, { cwd: root, stdio: "inherit", env });
  runtime.on("error", (error) => {
    console.error("Saturn Runtime did not start.", error.message);
  });
}

async function waitForRuntime() {
  if (await probe()) return;
  startRuntime();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error("Saturn Runtime did not become ready.");
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

async function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#121417",
    webPreferences: { contextIsolation: true },
  });
  if (app.isPackaged) await window.loadURL(await serveUi());
  else await window.loadURL("http://127.0.0.1:5174");
}

app.whenReady().then(async () => {
  await waitForRuntime();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (ownsRuntime) runtime?.kill();
  app.quit();
});
