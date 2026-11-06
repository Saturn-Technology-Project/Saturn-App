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
function program() {
  return process.env.SATURN_RUST_BIN ?? path.join(root, "target/debug", process.platform === "win32" ? "saturn-server.exe" : "saturn-server");
}

/**
 * Starts a runtime and waits until it answers. `stop()` ends it and deletes its data folder, as does a failed start.
 * `host` is what SATURN_RUNTIME_HOST is set to and what clients connect to. `dataDir` and `keepData` restart a runtime
 * on the data of an earlier one. `env` adds to or replaces the runtime's environment. `stdin` "pipe" gives the runtime the pipe a
 * desktop app holds, as `child.stdin`.
 */
export async function startRuntime({ host = "127.0.0.1", dataDir: existing, keepData = false, env = {}, stdin = "ignore" } = {}) {
  const dataDir = existing ?? await mkdtemp(path.join(os.tmpdir(), "saturn-contract-"));
  const port = await freePort();
  const file = program();
  let output = "";
  const child = spawn(file, [], {
    cwd: root,
    stdio: [stdin, "pipe", "pipe"],
    env: { ...process.env, SATURN_DATA_DIR: dataDir, SATURN_RUNTIME_HOST: host, SATURN_RUNTIME_PORT: String(port), SATURN_SECRET_STORE: "file", SATURN_NO_WAKEUP: "1", SATURN_RUNTIME_TOKEN: "", ...env },
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let failed;
  child.once("error", (error) => { failed = error; });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const origin = `http://${host}:${port}`;
  const stop = async () => {
    // A child that never started has no process to wait for.
    if (child.pid !== undefined) {
      child.kill("SIGTERM");
      await exited;
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
