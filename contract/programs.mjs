// Stand-ins for the official `claude` and `codex` programs, for the contract tests. Each one is placed where the runtime finds its
// own download, so no test starts a real program. They were checked against the official SDKs, which talked to them on the
// TypeScript runtime until it was removed: what these answer is what those SDKs accept, and the tests expect what they sent.
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startRuntime } from "./runtime.mjs";

/** The version a test's manifest pins, and so the folder its stand-ins live in. */
export const VERSION = "9.9.9";
export const PLATFORM = `${process.platform}-${process.arch}`;

/** Environment variables a stand-in writes down when it starts. */
const NOTED = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ELECTRON_RUN_AS_NODE", "NO_COLOR", "SATURN_SKILLS_TOKEN", "CLAUDE_CODE_USE_BEDROCK"];

/** What both stand-ins share: the scenario file, and a journal of what happened. */
const preamble = (folder) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const folder = ${JSON.stringify(folder)};
const scenario = JSON.parse(fs.readFileSync(path.join(folder, "scenario.json"), "utf8"));
const note = (entry) => fs.appendFileSync(path.join(folder, "journal.jsonl"), JSON.stringify(entry) + "\\n");
const env = {};
for (const key of ${JSON.stringify(NOTED)}) if (process.env[key] !== undefined) env[key] = process.env[key];
note({ started: true, program: path.basename(process.argv[1]), args: process.argv.slice(2), cwd: process.cwd(), env });
process.on("SIGTERM", () => { note({ signal: "SIGTERM" }); process.exit(143); });
const finish = (answer) => {
  if (answer.stdout) process.stdout.write(answer.stdout);
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.exitCode = answer.code ?? 0;
};
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write(scenario.version ?? "9.9.9 (stand-in)\\n"); process.exit(0); }
`;

/**
 * The \`claude\` program's stream-json protocol: it answers the initialize request, and on the first user message plays the
 * scenario's steps, each one a line to send, a permission or MCP request to wait on, a file to write, or how to end.
 */
const claudeProgram = (folder) => `${preamble(folder)}
if (args[0] === "auth") {
  finish(args[1] === "logout" ? scenario.logout ?? {} : scenario.status ?? { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) + "\\n" });
} else {
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  const waiting = new Map();
  let serial = 0;
  const ask = (request) => new Promise((resolve) => {
    const id = "req_" + (serial += 1);
    waiting.set(id, resolve);
    send({ type: "control_request", request_id: id, request });
  });
  const play = async () => {
    for (const step of scenario.steps ?? []) {
      if (step.send) send(step.send);
      if (step.permission) {
        const response = await ask({ subtype: "can_use_tool", tool_name: step.permission.tool, input: step.permission.input, tool_use_id: step.permission.id });
        note({ permission: step.permission.id, response });
        if (response.behavior === "allow" && step.permission.write) fs.writeFileSync(step.permission.write.path, step.permission.write.content);
      }
      if (step.mcp) note({ mcp: step.mcp.method, response: await ask({ subtype: "mcp_message", server_name: step.mcp.server ?? "saturn", message: { jsonrpc: "2.0", ...(step.mcp.notification ? {} : { id: step.mcp.id ?? 1 }), method: step.mcp.method, ...(step.mcp.params ? { params: step.mcp.params } : {}) } }) });
      if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
      if (step.hang) await new Promise(() => setInterval(() => undefined, 1000));
      if (step.exit !== undefined) { if (step.stderr) process.stderr.write(step.stderr); process.exit(step.exit); }
    }
  };
  let buffered = "";
  let played = false;
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === "control_response") {
        const answer = waiting.get(message.response.request_id);
        waiting.delete(message.response.request_id);
        answer?.(message.response.subtype === "error" ? { error: message.response.error } : message.response.response);
        continue;
      }
      note({ received: message });
      if (message.type === "control_request" && message.request.subtype === "initialize") {
        send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: [], account: {}, output_style: "default", available_output_styles: ["default"] } } });
      } else if (message.type === "user" && !played) {
        played = true;
        play().catch((error) => note({ failed: String(error) }));
      }
    }
  });
  process.stdin.on("end", () => { note({ stdin: "closed" }); process.exit(0); });
}
`;

/**
 * The \`codex\` program: \`login\` and \`logout\` as scenario says, and \`exec\` reads its prompt from stdin, then plays the steps.
 * It reaches the skills server over HTTP, at the address and with the token Saturn gave it, as the real one does.
 */
const codexProgram = (folder) => `${preamble(folder)}
if (args[0] === "login" && args[1] === "status") {
  finish(scenario.status ?? { code: 1, stderr: "Not logged in\\n" });
} else if (args[0] === "logout") {
  finish(scenario.logout ?? {});
} else if (args[0] === "login") {
  const sign = scenario.signIn ?? {};
  if (sign.stdout) process.stdout.write(sign.stdout);
  if (sign.stderr) process.stderr.write(sign.stderr);
  if (sign.exit !== undefined) process.exit(sign.exit);
  setInterval(() => undefined, 1000);
} else {
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  const setting = (name) => {
    const found = args.find((item) => item.startsWith("mcp_servers.saturn." + name + "="));
    return found ? JSON.parse(found.slice(found.indexOf("=") + 1)) : undefined;
  };
  const skills = async (step) => {
    const response = await fetch(step.url ?? setting("url"), {
      method: step.method ?? "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(step.token === false ? {} : { authorization: "Bearer " + process.env[setting("bearer_token_env_var")] }) },
      ...((step.method ?? "POST") === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: step.id ?? 1, method: step.rpc, ...(step.params ? { params: step.params } : {}) }) } : {}),
    });
    const text = await response.text();
    note({ skills: step.rpc ?? step.method, status: response.status, body: text ? JSON.parse(text) : null });
  };
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", async () => {
    note({ prompt: input });
    for (const step of scenario.steps ?? []) {
      if (step.send) send(step.send);
      if (step.skills) await skills(step.skills);
      if (step.write) fs.writeFileSync(step.write.path, step.write.content);
      if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
      if (step.hang) await new Promise(() => setInterval(() => undefined, 1000));
      if (step.exit !== undefined) { if (step.stderr) process.stderr.write(step.stderr); process.exit(step.exit); }
    }
  });
}
`;

/** Starts a runtime that finds only stand-ins: `install` lists the programs placed in its data folder. */
export async function startWithPrograms({ install = ["claude-code", "codex"], packages, env = {} } = {}) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-programs-")));
  const dataDir = path.join(folder, "data");
  const bin = path.join(folder, "bin");
  await mkdir(bin, { recursive: true });
  // No browser ever opens: a stand-in `open` writes down what it was asked to show.
  const opened = path.join(folder, "opened.txt");
  await writeFile(path.join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o755 });
  await writeFile(path.join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o755 });
  await writeFile(path.join(folder, "scenario.json"), "{}");

  const placed = {};
  for (const id of install) {
    const inner = id === "claude-code" ? "" : path.join("vendor", "target", "bin");
    const directory = path.join(dataDir, "tools", id, VERSION, "package", inner);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, id === "claude-code" ? "claude" : "codex");
    await writeFile(file, id === "claude-code" ? claudeProgram(folder) : codexProgram(folder));
    await chmod(file, 0o755);
    placed[id] = file;
  }

  const manifestFile = path.join(folder, "packages.json");
  const pinned = { version: VERSION, url: "http://127.0.0.1:9/never.tgz", integrity: "sha512-AAAA", size: 123 };
  await writeFile(manifestFile, JSON.stringify(packages ?? { "claude-code": { [PLATFORM]: pinned }, codex: { [PLATFORM]: pinned } }));
  const runtime = await startRuntime({
    dataDir,
    env: { PATH: `${bin}:/usr/bin:/bin`, SATURN_PROGRAM_PACKAGES: manifestFile, ...env },
  });
  const token = (await readFile(path.join(dataDir, "runtime-token"), "utf8")).trim();

  const call = async (method, route, body) => {
    const response = await fetch(`${runtime.origin}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const api = async (method, route, body) => {
    const answer = await call(method, route, body);
    if (answer.status >= 300) throw new Error(`${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };

  return {
    folder,
    dataDir,
    bin,
    placed,
    manifestFile,
    origin: runtime.origin,
    call,
    api,
    /** What the stand-in does next time it runs. */
    scenario: (value) => writeFile(path.join(folder, "scenario.json"), JSON.stringify(value)),
    /** Everything the stand-ins wrote down so far, oldest first. */
    journal: async () => {
      const text = await readFile(path.join(folder, "journal.jsonl"), "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    forget: () => rm(path.join(folder, "journal.jsonl"), { force: true }),
    opened: async () => (await readFile(opened, "utf8").catch(() => "")).split("\n").filter(Boolean),
    /** Polls until `done(value)` holds, and answers the value. */
    until: async (what, read, done, ms = 20_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await read();
        if (done(value)) return value;
        if (Date.now() > deadline) throw new Error(`${what} did not happen: ${JSON.stringify(value)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    stop: async () => {
      await runtime.stop();
      await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

const finished = (run) => !["queued", "running", "waiting_approval"].includes(run.status);

/** Starts a run and waits for it to end. */
export async function runToEnd(saturn, agentId, body) {
  const started = await saturn.api("POST", `/agents/${agentId}/runs`, body);
  return await saturn.until("the run", () => saturn.api("GET", `/runs/${started.id}`), finished);
}

/** Waits for a run to show an approval card, and answers the run and the action waiting on it. */
export async function untilCard(saturn, runId) {
  const run = await saturn.until("the card", () => saturn.api("GET", `/runs/${runId}`), (item) => item.status === "waiting_approval" || finished(item));
  if (run.status !== "waiting_approval") throw new Error(`The run ended without a card: ${JSON.stringify(run)}`);
  return { run, action: run.actions.find((item) => item.status === "waiting_approval") };
}

export const untilFinished = (saturn, runId) => saturn.until("the run", () => saturn.api("GET", `/runs/${runId}`), finished);
