import { execFile, spawn } from "node:child_process";
import { errorText, logger } from "../infrastructure/logger.js";
import { instruments, traced } from "../infrastructure/telemetry.js";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { respond } from "./http.js";
import { launchEnv } from "../infrastructure/launch-env.js";
import { shellInvocation, terminalEnv } from "../infrastructure/shell.js";

const runExec = promisify(execFile);
const CWD_MARKER = "__SATURN_CWD__:";

/**
 * Starts a desktop app detached from the runtime. A missing program (no xdg-open, no Terminal) arrives
 * as an "error" event on the child; without a listener it would crash the runtime, so it is logged instead.
 */
function launch(what: string, command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", env: launchEnv() });
  child.on("error", (error) => logger.warn("workspace", `Could not open ${what} with ${command}: ${errorText(error)}`));
  child.unref();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function mountWorkspace(app: Express, services: AppServices): void {
  const getActiveRoot = async (): Promise<string> => {
    try {
      const active = await services.getActiveProject();
      if (active?.path) return active.path;
    } catch {
      // Fallback
    }
    const root = path.join(services.kernel.store.root, "workspace");
    await mkdir(root, { recursive: true });
    return root;
  };

  app.get("/workspace/info", (_req, res, next) => {
    respond(res, next, async () => {
      const root = await getActiveRoot();
      await mkdir(root, { recursive: true });
      let username = "user";
      try {
        username = os.userInfo().username;
      } catch {
        // Fallback if os.userInfo fails
      }
      return {
        cwd: root,
        shell: process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh"),
        user: username,
        hostname: os.hostname().replace(/\.local$/i, ""),
      };
    });
  });

  app.post("/workspace/terminal", (req, res, next) => {
    respond(res, next, async () => {
      const root = await getActiveRoot();
      await mkdir(root, { recursive: true });

      const rawCommand = String(req.body?.command ?? "").trim();
      const requestedCwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() ? req.body.cwd.trim() : root;

      let cwd = requestedCwd;
      try {
        const info = await stat(cwd);
        if (!info.isDirectory()) cwd = root;
      } catch {
        cwd = root;
      }

      if (!rawCommand) {
        return { stdout: "", stderr: "", exitCode: 0, cwd };
      }

      const isWin = process.platform === "win32";
      const wrappedCommand = isWin
        ? `${rawCommand} & echo ${CWD_MARKER}%CD%`
        : `${rawCommand}\n__saturn_ec=$?\nprintf "\\n${CWD_MARKER}%s\\n" "$(pwd)"\nexit $__saturn_ec`;
      const invocation = shellInvocation(wrappedCommand, process.env.SHELL || "/bin/zsh");
      const shell = invocation.file;
      const env = terminalEnv(launchEnv());

      // Only the program name is recorded; arguments may carry secrets.
      return traced("workspace.exec", {
        attributes: {
          "process.executable.name": path.basename(shell),
          "saturn.command.name": rawCommand.split(/\s+/)[0] ?? "",
        },
      }, async (span) => {
        try {
          const { stdout, stderr } = await runExec(shell, invocation.args, {
            cwd,
            timeout: 30_000,
            maxBuffer: 512 * 1024,
            env,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          });
          const parsed = extractCwd(stdout, cwd);
          span.setAttribute("process.exit.code", 0);
          instruments().commands.add(1, { "saturn.command.outcome": "ok" });
          return {
            stdout: parsed.stdout,
            stderr: stderr || "",
            exitCode: 0,
            cwd: parsed.cwd,
          };
        } catch (error) {
          const failed = error as { stdout?: string; stderr?: string; code?: number; message?: string };
          const parsed = extractCwd(failed.stdout || "", cwd);
          const exitCode = typeof failed.code === "number" ? failed.code : 1;
          span.setAttribute("process.exit.code", exitCode);
          span.setAttribute("error.type", "nonzero_exit");
          instruments().commands.add(1, { "saturn.command.outcome": "failed" });
          return {
            stdout: parsed.stdout,
            stderr: failed.stderr || failed.message || "Command failed",
            exitCode,
            cwd: parsed.cwd,
          };
        }
      });
    });
  });

  app.post("/workspace/terminal/open", (req, res, next) => {
    respond(res, next, async () => {
      const root = await getActiveRoot();
      await mkdir(root, { recursive: true });
      const cwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() ? req.body.cwd.trim() : root;

      if (process.platform === "darwin") {
        launch("a terminal", "open", ["-a", "Terminal", cwd]);
      } else if (process.platform === "win32") {
        launch("a terminal", "cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${cwd}"`]);
      } else {
        launch("a terminal", "x-terminal-emulator", ["--working-directory", cwd]);
      }
      logger.info("workspace", `Opened a terminal in ${cwd}`);
      return { opened: true, cwd };
    });
  });

  app.post("/workspace/editor/open", (_req, res, next) => {
    respond(res, next, async () => {
      // Open IDE always means Saturn IDE; its errors (not installed, no project) reach the user as they are.
      const active = await services.getActiveProject();
      return await services.openProjectEditor(active.id);
    });
  });

  app.post("/runtime/wakeup", (_req, res, next) => {
    respond(res, next, async () => {
      return await services.wakeupDefaultApp();
    });
  });

  // Saturn IDE windows report in every 15 s; the desktop app quits (and stops this runtime) only once none is open.
  app.post("/runtime/clients", (req, res, next) => {
    respond(res, next, () => {
      services.kernel.clients.beat(String(req.body?.id ?? ""), String(req.body?.kind ?? "ide"));
      return { ok: true };
    });
  });

  app.delete("/runtime/clients/:id", (req, res, next) => {
    respond(res, next, () => services.kernel.clients.leave(String(req.params.id)), 204);
  });

  app.get("/runtime/clients", (_req, res, next) => {
    respond(res, next, () => services.kernel.clients.list());
  });

  app.get("/runtime/wakeup", (_req, res, next) => {
    respond(res, next, async () => {
      const target = services.settings().launchApp ?? "agent";
      return { target };
    });
  });

  app.post("/workspace/browser/open", (req, res, next) => {
    respond(res, next, async () => {
      const url = normalizeUrl(String(req.body?.url ?? "https://www.google.com"));
      if (process.platform === "darwin") {
        launch("the browser", "open", [url]);
      } else if (process.platform === "win32") {
        launch("the browser", "cmd.exe", ["/c", "start", "", url]);
      } else {
        launch("the browser", "xdg-open", [url]);
      }
      // Host only: the rest of a URL can carry tokens.
      logger.info("workspace", `Opened ${hostOf(url)} in the system browser`);
      return { opened: true, url };
    });
  });

  app.get("/workspace/browser/proxy", async (req, res) => {
    const rawUrl = typeof req.query.url === "string" ? req.query.url : "https://example.com";
    const targetUrl = normalizeUrl(rawUrl);
    try {
      const response = await fetch(targetUrl, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(12_000),
      });
      const finalUrl = response.url || targetUrl;
      const contentType = response.headers.get("content-type") || "text/html; charset=utf-8";
      const body = await response.text();

      res.setHeader("Content-Type", contentType.includes("html") ? "text/html; charset=utf-8" : contentType);
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");

      if (contentType.includes("html")) {
        const baseTag = `<base href="${escapeAttr(finalUrl)}">`;
        const injected = /<head[^>]*>/i.test(body)
          ? body.replace(/<head[^>]*>/i, (match) => `${match}${baseTag}`)
          : `${baseTag}${body}`;
        res.status(200).send(injected);
      } else {
        res.status(200).send(body);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to load page";
      // The page below is sent with 200, so the request span looks successful; this is the only record.
      logger.warn("workspace", `Browser preview could not load ${hostOf(targetUrl)}: ${msg}`);
      res
        .status(200)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;background:#111318;color:#e5e7eb;padding:32px;line-height:1.5}code{background:#1f2430;padding:2px 6px;border-radius:4px;color:#93c5fd}</style></head><body><h3>Could not load page</h3><p><code>${escapeAttr(targetUrl)}</code></p><p>${escapeAttr(msg)}</p></body></html>`,
        );
    }
  });

  app.get("/workspace/files", (req, res, next) => {
    respond(res, next, async () => {
      const root = await getActiveRoot();
      await mkdir(root, { recursive: true });
      const relPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
      const safeTarget = path.resolve(root, relPath || ".");
      const target = safeTarget.startsWith(root) ? safeTarget : root;
      if (target !== safeTarget) logger.warn("workspace", `Refused a file path outside the workspace: ${relPath}`);

      const info = await stat(target);
      if (info.isDirectory()) {
        const entries = await readdir(target, { withFileTypes: true });
        return {
          kind: "directory",
          path: path.relative(root, target) || ".",
          entries: entries
            .filter((item) => !item.name.startsWith("."))
            .map((item) => ({
              name: item.name,
              path: path.relative(root, path.join(target, item.name)),
              kind: item.isDirectory() ? "directory" : "file",
            })),
        };
      }
      const content = await readFile(target, "utf8");
      return {
        kind: "file",
        path: path.relative(root, target),
        content: content.slice(0, 100_000),
      };
    });
  });
}

function extractCwd(output: string, fallbackCwd: string): { stdout: string; cwd: string } {
  const idx = output.lastIndexOf(CWD_MARKER);
  if (idx === -1) return { stdout: output, cwd: fallbackCwd };
  const before = output.slice(0, idx).replace(/\r?\n$/, "");
  const after = output
    .slice(idx + CWD_MARKER.length)
    .split(/\r?\n/)[0]
    ?.trim();
  return {
    stdout: before,
    cwd: after || fallbackCwd,
  };
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "https://example.com";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
