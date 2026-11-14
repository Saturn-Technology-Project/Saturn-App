// Starts the Saturn runtime for the contract tests, on a free port with a temporary data folder, never the developer's
// own Saturn. SATURN_RUST_BIN picks the program; the default is the workspace's debug build.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The runtime's program. */
export function program() {
  return process.env.SATURN_RUST_BIN ?? path.join(root, "target/debug", process.platform === "win32" ? "saturn-server.exe" : "saturn-server");
}

/**
 * Starts a runtime and waits until it answers. `stop()` ends it and deletes its data folder, as does a failed start.
 * `host` is what SATURN_RUNTIME_HOST is set to and what clients connect to. `dataDir` and `keepData` restart a runtime
 * on the data of an earlier one. `env` adds to or replaces the runtime's environment. `stdin` "pipe" gives the runtime the pipe a
 * desktop app holds, as `child.stdin`. `cwd` is the folder it starts in, the repository unless given.
 */
export async function startRuntime({ host = "127.0.0.1", dataDir: existing, keepData = false, env = {}, stdin = "ignore", cwd = root } = {}) {
  const dataDir = existing ?? await mkdtemp(path.join(os.tmpdir(), "saturn-contract-"));
  const port = await freePort();
  const file = program();
  let output = "";
  // Windows has no signal that asks a program to stop: there the runtime is started as the desktop app starts it,
  // holding a pipe, and is asked to stop as the app asks, by closing the pipe. Killing it would lose what it saves
  // as it stops.
  const piped = process.platform === "win32" && stdin === "ignore";
  const child = spawn(file, [], {
    cwd,
    stdio: [piped ? "pipe" : stdin, "pipe", "pipe"],
    env: { ...process.env, SATURN_DATA_DIR: dataDir, SATURN_RUNTIME_HOST: host, SATURN_RUNTIME_PORT: String(port), SATURN_SECRET_STORE: "file", SATURN_RUNTIME_TOKEN: "", ...(piped ? { SATURN_DESKTOP_ATTACHED: "1" } : {}), ...env },
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let failed;
  child.once("error", (error) => { failed = error; });
  // For finding out why a runtime went: SATURN_CONTRACT_TRACE prints how each one ended and the last it said.
  if (process.env.SATURN_CONTRACT_TRACE) child.once("exit", (code, signal) => console.error(`runtime ${child.pid} on ${port} ended: code ${code}, signal ${signal}\n${output.slice(-1500)}`));
  // On Windows a program the runtime started holds the runtime's own output pipes, so they close only when that
  // program ends too: there the runtime is gone when it exits.
  const exited = new Promise((resolve) => child.once(process.platform === "win32" ? "exit" : "close", resolve));
  const origin = `http://${host}:${port}`;
  const stop = async () => {
    // A child that never started has no process to wait for.
    if (child.pid !== undefined) {
      if (piped) child.stdin.end();
      else child.kill("SIGTERM");
      // The runtime gives itself ten seconds to stop; one still there long after is ended, and what it said is shown,
      // so a test file never hangs on it.
      let timer;
      const late = await Promise.race([exited.then(() => false), new Promise((resolve) => { timer = setTimeout(() => resolve(true), 20_000); })]);
      clearTimeout(timer);
      if (late) {
        child.kill("SIGKILL");
        await exited;
        if (!keepData) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        throw new Error(`The runtime did not stop within 20 s of being asked:\n${output.slice(-4000)}`);
      }
    }
    if (!keepData) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (failed) throw new Error(`Could not start the runtime (${file}): ${failed.message}`);
      if (child.exitCode !== null) throw new Error(`The runtime exited early:\n${output}`);
      if (Date.now() > deadline) throw new Error(`The runtime did not answer within a minute:\n${output}`);
      try {
        if ((await fetch(`${origin}/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return { origin, port, dataDir, stop, child };
}

/**
 * A value with each of `folders` (pairs of a folder and a name for it) written as its name, in every string in it.
 * A path that held one is then written with "/", as macOS writes it, so that what was recorded there reads the same
 * on Windows.
 */
export function placed(value, folders) {
  const each = (item) => {
    if (typeof item === "string") {
      let text = item;
      for (const [folder, name] of folders) {
        if (!text.includes(folder)) continue;
        text = text.replaceAll(folder, name);
        if (path.sep === "\\") text = text.replaceAll("\\", "/");
      }
      return text;
    }
    if (Array.isArray(item)) return item.map(each);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, each(inner)]));
    return item;
  };
  return each(value);
}

/** Why a test that waits for Saturn to open a web page is skipped on Windows, where it runs. */
export const opensPages = { skip: process.platform === "win32" && "Windows opens a page through its own rundll32, found before anything on PATH, so no stand-in can note it" };
