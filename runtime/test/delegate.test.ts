import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_DELEGATION_DEPTH } from "../src/application/runs.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { toolRounds, toolSteps } from "./tool-steps.js";

type Message = { role: string; content: string };

/**
 * One model for the whole family: the chat's own turn delegates two tasks, a sub-agent answers its task (after
 * one read, to show tools work), and a sub-agent asked to delegate again tries to. Records every request.
 */
async function familyModel() {
  const requests: { input: string; tools: string[]; history: number }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: Message[]; tools?: { function?: { name?: string } }[] };
      const messages = body.messages ?? [];
      const users = messages.filter((item) => item.role === "user");
      // The request's own message: the last one that is a task or a question (not the "continue" after tool results).
      const input = users.filter((item) => /^(hello|look into|CHILD)/.test(item.content)).at(-1)?.content ?? "";
      const tools = (body.tools ?? []).map((item) => item.function?.name ?? "");
      const results = toolRounds(messages);
      requests.push({ input, tools, history: users.length });
      const call = (name: string, args: unknown) => ({ content: "", tool_calls: [{ id: `c${results}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      let message: unknown;
      if (input.startsWith("look into")) {
        // The parent: delegate two tasks, then answer from the results.
        message = results === 0
          ? call("delegate", { tasks: ["CHILD: count the files", "CHILD: name the newest file"], tools: "read-only" })
          : { content: `parent done: ${JSON.stringify(toolSteps(messages)).includes("answer for") ? "both answered" : "no answers"}` };
      } else if (input.startsWith("CHILD: nest")) {
        // Delegates the same task again, as deep as it is allowed to.
        message = results === 0 ? call("delegate", { task: "CHILD: nest" }) : { content: `nested: ${JSON.stringify(toolSteps(messages)).includes("may not delegate") ? "refused" : "ok"}` };
      } else if (input.startsWith("CHILD:")) {
        message = results === 0 ? call("files", { action: "list", path: "." }) : { content: `answer for ${input.slice(7)}` };
      } else {
        message = { content: "ok" };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { requests, server, url: `http://127.0.0.1:${address.port}` };
}

async function until(read: () => Run, done: (run: Run) => boolean): Promise<Run> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = read();
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run stuck at ${read().status}`);
}
const settled = (run: Run) => run.status !== "running" && run.status !== "queued" && run.status !== "waiting_approval";

test("delegate runs sub-agents in parallel with fresh contexts, nests them under the step, and hands back only their answers", async () => {
  const model = await familyModel();
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-delegate-"));
  const folder = path.join(directory, "site");
  await mkdir(folder);
  try {
    const store = new FileStore(path.join(directory, "data"));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Family", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "Lead", modelConnectionId: connection.id, autonomy: "default" });
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const thread = await services.kernel.runs.createThread(agent.id, "Investigation", project.id);
    // An earlier turn, so the fresh context of a sub-agent can be told from the chat's history.
    const first = await services.startRun(agent.id, "hello there", thread.id);
    await until(() => services.kernel.getRun(first.id), settled);

    const run = await services.startRun(agent.id, "look into the folder", thread.id);
    const done = await until(() => services.kernel.getRun(run.id), settled);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.output, "parent done: both answered");

    const step = done.actions.find((item) => item.toolId === "delegate");
    assert.equal(step?.status, "completed");
    const result = step?.result as { results: { task: string; status: string; answer: string; runId: string }[] };
    assert.deepEqual(result.results.map((item) => [item.task, item.status, item.answer]), [
      ["CHILD: count the files", "completed", "answer for count the files"],
      ["CHILD: name the newest file", "completed", "answer for name the newest file"],
    ]);

    // The sub-agent runs: in the chat, tied to the parent, in Ask mode (read-only), with a fresh context.
    const children = store.state.runs.filter((item) => item.parentRunId === run.id);
    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.threadId === thread.id && child.mode === "ask" && child.delegated?.tools === "read-only"));
    assert.ok(children.every((child) => child.actions.some((item) => item.toolId === "files" && item.status === "completed")), "the read tool ran");
    const childRequests = model.requests.filter((item) => item.input.startsWith("CHILD:"));
    assert.ok(childRequests.length >= 2);
    assert.ok(childRequests.every((item) => item.history === 1 || item.history === 2), "no earlier turns of the chat reach a sub-agent");
    assert.ok(childRequests.every((item) => !item.tools.includes("code")), "a read-only sub-agent is not offered the shell");
    const parentRequests = model.requests.filter((item) => item.input.startsWith("hello") || item.input.startsWith("look into"));
    assert.ok(parentRequests.some((item) => item.history >= 2), "the parent keeps the chat's history");

    // The chat lists the parent with its children attached, never the children as turns.
    const listed = await services.messagesFor(agent.id, thread.id);
    assert.deepEqual(listed.map((item) => item.id), [first.id, run.id]);
    assert.equal(listed[1]?.children?.length, 2);
    assert.ok(!services.kernel.runs.recentRuns(project.id).some((item) => children.some((child) => child.id === item.id)), "the Agents board leaves them out");
    assert.equal(services.kernel.runs.contextUsage(thread.id).turns, 2, "the context counts the chat's turns only");

    // Depth: the chat's run delegates, its sub-agent delegates once more, and the one below that is refused.
    const nested = await services.startRun(agent.id, "CHILD: nest", thread.id);
    const nestedDone = await until(() => services.kernel.getRun(nested.id), settled);
    assert.equal(nestedDone.output, "nested: ok");
    const depthOf = (run: Run): number => (run.parentRunId ? 1 + depthOf(store.state.runs.find((item) => item.id === run.parentRunId)!) : 0);
    const deepest = store.state.runs.filter((item) => item.input === "CHILD: nest").sort((a, b) => depthOf(b) - depthOf(a))[0]!;
    assert.equal(depthOf(deepest), MAX_DELEGATION_DEPTH);
    assert.match(deepest.actions.find((item) => item.toolId === "delegate")?.reason ?? "", /may not delegate further/);
    assert.equal(deepest.output, "nested: refused");
  } finally {
    model.server.close();
  }
});

test("stopping the delegating run stops its sub-agents", async () => {
  // A model that delegates a task whose sub-agent waits on a long command.
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: Message[] }).messages ?? [];
      const input = messages.find((item) => item.role === "user")?.content ?? "";
      const results = toolRounds(messages);
      const call = (name: string, args: unknown) => ({ content: "", tool_calls: [{ id: `c${results}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      const message = results > 0 ? { content: "done" } : input.startsWith("CHILD") ? call("code", { command: "sleep 20", timeout: 25_000 }) : call("delegate", { task: "CHILD wait", tools: "all" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-delegate-stop-"));
  try {
    const store = new FileStore(directory);
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Slow", provider: "openai", baseUrl: `http://127.0.0.1:${address.port}` });
    const agent = await services.createAgent({ name: "Lead", modelConnectionId: connection.id, autonomy: "bypass" });
    const run = await services.startRun(agent.id, "go");
    const child = await until(() => store.state.runs.find((item) => item.parentRunId === run.id) ?? ({ status: "queued" } as Run), (item) => item.status === "running" && item.actions.length === 0 && Boolean(item.id));
    assert.equal(child.delegated?.tools, "all");
    assert.equal(child.mode, undefined, "all tools: the sub-agent inherits the agent mode");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await services.kernel.runs.stopRun(run.id);
    const parent = await until(() => services.kernel.getRun(run.id), settled);
    assert.equal(parent.status, "cancelled");
    const stopped = await until(() => services.kernel.getRun(child.id), settled);
    assert.equal(stopped.status, "cancelled");
  } finally {
    server.close();
  }
});
