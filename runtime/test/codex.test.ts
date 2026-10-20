import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSignIn } from "../src/application/codex.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-codex-"));
  const store = new FileStore(directory);
  await store.load();
  return { directory, store, ...createApp(store) };
}

async function settle(services: Awaited<ReturnType<typeof setup>>["services"], runId: string): Promise<Run> {
  let current: Run = services.kernel.getRun(runId);
  for (let attempt = 0; attempt < 300 && (current.status === "running" || current.status === "queued"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = services.kernel.getRun(runId);
  }
  return current;
}

test("Codex runs with no credential that could outrank the user's own login, in Saturn's own CODEX_HOME", async () => {
  const { directory, services } = await setup();
  const saved = { ...process.env };
  process.env.OPENAI_API_KEY = "sk-should-not-leak";
  process.env.CODEX_API_KEY = "should-not-leak";
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const env = services.kernel.codex.environment();
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.CODEX_HOME, path.join(directory, "codex"));
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    process.env = saved;
  }
});

test("login status comes from the official codex program", async () => {
  const { services } = await setup();
  const status = await services.kernel.codex.status();
  assert.equal(status.loggedIn, false);
  assert.equal(status.authMethod, "none");
  assert.equal(status.error, undefined, "a signed-out answer is not an error");
  assert.equal(status.signIn, undefined);
});

test("the device link and one-time code are read from what codex login prints", () => {
  const printed = [
    "Welcome to Codex [v0.163.0]",
    "1. Open this link in your browser and sign in to your account",
    "   https://auth.openai.com/codex/device",
    "2. Enter this one-time code (expires in 15 minutes)",
    "   6JMY-KP8EO",
  ].join("\n");
  assert.deepEqual(parseSignIn(printed, "device"), { url: "https://auth.openai.com/codex/device", code: "6JMY-KP8EO" });
  assert.deepEqual(
    parseSignIn("Starting local login server on http://localhost:1455.\nnavigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=x", "browser"),
    { url: "https://auth.openai.com/oauth/authorize?response_type=code&client_id=x" },
  );
  assert.deepEqual(parseSignIn("Welcome to Codex", "device"), {});
});

test("a Codex model keeps its effort, cannot serve completions, and the sign-in routes need the runtime token", async () => {
  const { app, services } = await setup();
  const model = await services.createModel({ provider: "codex", model: "default", effort: "xhigh" });
  assert.equal(model.effort, "xhigh");
  assert.equal(model.name, "Codex default model");
  assert.throws(() => services.kernel.completions.model(model.id), /runs through Codex/);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const response = await fetch(`http://127.0.0.1:${address.port}/codex/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401, "starting a sign-in is not open to other local programs");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

/** A stand-in `codex` that answers `codex exec --experimental-json` with a scripted turn, recording its arguments. */
async function fakeCodex(directory: string, events: unknown[]): Promise<{ bin: string; argsFile: string }> {
  const bin = path.join(directory, "fake-codex.cjs");
  const argsFile = path.join(directory, "fake-codex-args.json");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME, key: process.env.OPENAI_API_KEY ?? null }));
process.stdin.resume();
process.stdin.on("end", () => {
  for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");
});
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { bin, argsFile };
}

test("a Codex turn shows its reply, reasoning, commands and edits, and records usage, with no API key and the chosen model, sandbox and effort", async () => {
  const { directory, services } = await setup();
  const { bin, argsFile } = await fakeCodex(directory, [
    { type: "thread.started", thread_id: "thr_1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Look at the files first." } },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a.ts\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "completed" } },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Updated a.ts." } },
    { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 10 } },
  ]);
  services.kernel.codex.cliPath = () => bin;
  const model = await services.createModel({ provider: "codex", model: "gpt-6-luna", effort: "high" });
  const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id, instructions: "Be brief." });
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-ignored";
  try {
    const run = await services.startRun(agent.id, "update a.ts");
    const done = await settle(services, run.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.output, "Updated a.ts.");
    assert.deepEqual(done.thoughts?.map((item) => item.text), ["Look at the files first."]);
    assert.deepEqual(done.actions.map((item) => [item.toolId, item.status]), [["Bash", "completed"], ["Edit", "completed"]]);
    assert.deepEqual(done.actions[0]!.arguments, { command: "ls" });
    const usage = services.kernel.store.state.usage.find((item) => item.runId === run.id);
    assert.equal(usage?.inputTokens, 120);
    assert.equal(usage?.pricing, "ChatGPT plan");

    const call = JSON.parse(await readFile(argsFile, "utf8")) as { args: string[]; home: string; key: string | null };
    assert.equal(call.key, null, "no API key reaches Codex");
    assert.equal(call.home, path.join(directory, "codex"));
    const args = call.args.join(" ");
    assert.match(args, /--model gpt-6-luna/);
    assert.match(args, /--sandbox workspace-write/);
    assert.match(args, /model_reasoning_effort="high"/);
    assert.match(args, /approval_policy="never"/);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("a Codex turn that fails for want of a login says how to sign in", async () => {
  const { directory, services } = await setup();
  const { bin } = await fakeCodex(directory, [{ type: "turn.failed", error: { message: "401 Unauthorized: not logged in" } }]);
  services.kernel.codex.cliPath = () => bin;
  const model = await services.createModel({ provider: "codex", model: "default" });
  const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id });
  const run = await services.startRun(agent.id, "hi");
  const done = await settle(services, run.id);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /Codex isn't signed in for Saturn/);
});

test("in a group, a Codex member resumes one thread for all its turns and gets only what is new", async () => {
  const { directory, services } = await setup();
  const { bin, argsFile } = await fakeCodex(directory, [
    { type: "thread.started", thread_id: "thr_group" },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ]);
  services.kernel.codex.cliPath = () => bin;
  const model = await services.createModel({ provider: "codex", model: "default" });
  const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id });
  const group = await services.createGroup({ name: "Team", agentIds: [agent.id] });
  const settleGroup = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await services.kernel.groups.check();
      if (services.groupTranscript(group.id).runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("group did not settle");
  };

  await services.postGroupMessage(group.id, "first task");
  await settleGroup();
  const first = JSON.parse(await readFile(argsFile, "utf8")) as { args: string[] };
  assert.equal(first.args.includes("resume"), false, "the first turn starts the thread");
  assert.equal(services.kernel.store.state.groups?.[0]?.sessions?.[agent.id]?.codexThreadId, "thr_group");

  await services.postGroupMessage(group.id, "second task");
  await settleGroup();
  const second = JSON.parse(await readFile(argsFile, "utf8")) as { args: string[] };
  assert.ok(second.args.includes("resume") && second.args.includes("thr_group"), `resumes the same thread: ${second.args.join(" ")}`);
  const turn = services.groupTranscript(group.id).runs.find((run) => run.input.endsWith("second task"));
  assert.match(turn?.input ?? "", /^New in the group "Team" since your last turn/);
  assert.doesNotMatch(turn?.input ?? "", /first task/, "what the session already saw is not sent again");
});

test("a Codex thread opens with Saturn's memory and the agent's instructions, and every message carries what the knowledge sources return", async () => {
  const { directory, services } = await setup();
  const bin = path.join(directory, "fake-codex.cjs");
  const promptFile = path.join(directory, "prompts.jsonl");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(promptFile)}, JSON.stringify({ resume: process.argv.includes("resume"), input }) + "\\n");
  for (const event of [
    { type: "thread.started", thread_id: "thr_memory" },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ]) process.stdout.write(JSON.stringify(event) + "\\n");
});
`);
  await chmod(bin, 0o755);
  services.kernel.codex.cliPath = () => bin;
  await services.kernel.memory.write("global", "- Prefers tabs over spaces.");

  const queries: string[] = [];
  const rag = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      queries.push((JSON.parse(body) as { query: string }).query);
      res.end("The deploy script is scripts/ship.sh.");
    });
  });
  await new Promise<void>((resolve) => rag.listen(0, "127.0.0.1", () => resolve()));
  try {
    const source = await services.createRag({ name: "Docs", url: `http://127.0.0.1:${(rag.address() as AddressInfo).port}/` });
    const model = await services.createModel({ provider: "codex", model: "default" });
    const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id, instructions: "Be brief.", ragConnectionIds: [source.id] });
    const first = await services.startRun(agent.id, "how do I deploy?");
    assert.equal((await settle(services, first.id)).status, "completed");
    const second = await services.startRun(agent.id, "and roll back?", services.kernel.getRun(first.id).threadId);
    assert.equal((await settle(services, second.id)).status, "completed");

    const [opening, resumed] = (await readFile(promptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { resume: boolean; input: string });
    assert.equal(opening!.resume, false);
    assert.match(opening!.input, /<memory>[\s\S]*Prefers tabs over spaces[\s\S]*<\/memory>/);
    assert.match(opening!.input, /<instructions>\nBe brief.\n<\/instructions>/);
    assert.match(opening!.input, /<knowledge>[\s\S]*scripts\/ship\.sh[\s\S]*<\/knowledge>\n\nhow do I deploy\?$/);
    assert.equal(resumed!.resume, true);
    assert.doesNotMatch(resumed!.input, /<memory>|<instructions>/, "a resumed thread already has them");
    assert.match(resumed!.input, /<knowledge>[\s\S]*<\/knowledge>\n\nand roll back\?$/);
    assert.deepEqual(queries, ["how do I deploy?", "and roll back?"]);
  } finally {
    await new Promise((resolve) => rag.close(() => resolve(undefined)));
  }
});
