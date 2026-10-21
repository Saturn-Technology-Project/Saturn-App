import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installCli, launcherScript } from "../src/application/cli-install.js";
import { describeAction, main, parseArgs } from "../src/cli.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { TEST_TOKEN } from "./runtime-token.js";
import { toolSteps } from "./tool-steps.js";

test("arguments, step lines and the launcher scripts", () => {
  assert.deepEqual(parseArgs(["fix", "it", "--agent", "Saturn", "--json", "--mode=plan", "--", "--literal"]), { positional: ["fix", "it", "--literal"], flags: { agent: "Saturn", json: true, mode: "plan" } });
  assert.equal(describeAction({ id: "a", toolId: "code", arguments: { command: "npm test" }, status: "completed" }), "code npm test");
  assert.equal(describeAction({ id: "a", toolId: "files", arguments: { path: "x.ts" }, status: "denied", reason: "no" }), "files x.ts (denied: no)");

  const app = launcherScript({ platform: "darwin", exec: "/Applications/Saturn.app/Contents/MacOS/Saturn", entry: { file: "/Applications/Saturn.app/Contents/Resources/runtime/dist/cli.js", typescript: false }, electron: true, env: {} });
  assert.equal(app, "#!/bin/sh\n# Saturn command line: runs the Saturn app's own CLI. Written by Saturn (Settings → General).\nexport ELECTRON_RUN_AS_NODE='1'\nexec '/Applications/Saturn.app/Contents/MacOS/Saturn' '/Applications/Saturn.app/Contents/Resources/runtime/dist/cli.js' \"$@\"\n");
  const windows = launcherScript({ platform: "win32", exec: "C:\\Saturn\\Saturn.exe", entry: { file: "C:\\Saturn\\resources\\runtime\\dist\\cli.js", typescript: false }, electron: true, env: { SATURN_RUNTIME_PORT: "4791" } });
  assert.match(windows, /@set "SATURN_RUNTIME_PORT=4791"\r\n@set "ELECTRON_RUN_AS_NODE=1"\r\n@"C:\\Saturn\\Saturn.exe" "C:\\Saturn\\resources\\runtime\\dist\\cli.js" %\*/);
  const dev = launcherScript({ platform: "linux", exec: "/usr/bin/node", entry: { file: "/repo/runtime/src/cli.ts", typescript: true }, electron: false, env: { SATURN_RUNTIME_PORT: "4700" } });
  assert.match(dev, /exec '\/usr\/bin\/node' '\/repo\/runtime\/node_modules\/tsx\/dist\/cli\.mjs' '\/repo\/runtime\/src\/cli\.ts' "\$@"/);
  assert.ok(!dev.includes("SATURN_RUNTIME_PORT"), "the default port is not written");
});

test("installCli writes an executable launcher in ~/.local/bin", { skip: process.platform === "win32" && "HOME is not the home folder on Windows" }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "saturn-cli-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const status = await installCli();
    assert.equal(status.path, path.join(home, ".local", "bin", "saturn"));
    assert.equal(status.installed, true);
    assert.equal(status.current, true);
    assert.ok(((await stat(status.path)).mode & 0o111) !== 0, "executable");
    assert.match(await readFile(status.path, "utf8"), /cli\.ts/);
  } finally {
    process.env.HOME = saved;
  }
});

test("saturn run follows a run to its answer, exits 3 on an approval it cannot ask about, and refuses Claude Code unattended", async () => {
  // A model that runs one shell command (asked about in Review mode), then answers.
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const ran = toolSteps(messages).length > 0;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: ran ? { content: "all done" } : { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo cli" }) } }] } }] }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-cli-")));
  await store.load();
  const { app, services } = createApp(store);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const saved = { port: process.env.SATURN_RUNTIME_PORT, token: process.env.SATURN_RUNTIME_TOKEN };
  process.env.SATURN_RUNTIME_PORT = String((server.address() as { port: number }).port);
  process.env.SATURN_RUNTIME_TOKEN = TEST_TOKEN;
  const lines: string[] = [];
  const out = (text: string) => lines.push(text);
  try {
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}` });
    await services.createAgent({ name: "Doer", modelConnectionId: connection.id, autonomy: "bypass" });
    await services.createAgent({ name: "Careful", modelConnectionId: connection.id, autonomy: "review" });
    const plan = await services.createModel({ provider: "claude-code", model: "claude-sonnet-5-5" });
    await services.createAgent({ name: "Planner", modelConnectionId: plan.id });

    assert.equal(await main(["run", "do it", "--agent", "Doer", "--json"], out), 0);
    const done = JSON.parse(lines.at(-1)!) as { status: string; output: string; actions: { status: string }[] };
    assert.equal(done.status, "completed");
    assert.equal(done.output, "all done");
    assert.equal(done.actions[0]?.status, "completed");

    assert.equal(await main(["run", "do it carefully", "--agent", "Careful", "--json"], out), 3, "waiting for approval, no terminal to ask on");
    const waiting = JSON.parse(lines.at(-1)!) as { id: string; status: string; actions: { id: string; status: string }[] };
    assert.equal(waiting.status, "waiting_approval");
    const action = waiting.actions.find((item) => item.status === "waiting_approval")!;
    assert.equal(await main(["approve", waiting.id, action.id], out), 0);
    assert.equal(lines.at(-1), "Approved.");

    await assert.rejects(main(["run", "plan it", "--agent", "Planner", "--json"], out), /violation of Anthropic's policy/);
    await assert.rejects(main(["run", "", "--agent", "Doer"], out), /Give the prompt/);
    assert.equal(await main(["agents"], out), 0);
    assert.ok(lines.some((line) => line.startsWith("Doer\tLocal\t")));
    await assert.rejects(main(["frobnicate"], out), /Unknown command/);
  } finally {
    process.env.SATURN_RUNTIME_PORT = saved.port;
    process.env.SATURN_RUNTIME_TOKEN = saved.token;
    server.close();
    model.close();
  }
});
