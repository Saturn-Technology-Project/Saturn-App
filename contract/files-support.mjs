// What the files-* contract tests share: a runtime with no view of the developer's git settings, temporary folders, and
// agents on a fake model that follows a script. Everything else goes over HTTP.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { startRuntime } from "./runtime.mjs";

/** Git settings that keep the developer's own out of a test, for the runtime and the test's own git calls. */
export const GIT_ALONE = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull };

export const posixOnly = { skip: process.platform === "win32" && "the scripted commands are POSIX shell" };

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Runs git in `cwd` as a throwaway identity, and gives back what it printed. */
export const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: { ...process.env, ...GIT_ALONE, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
}).trim();

/** A new repository on branch main in `folder`, with what is there committed. */
export function commitAll(folder) {
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "init");
}

/** A tool call in a step of the script: `[tool, arguments]`. */
export const write = (file, content) => ["files", { action: "write", path: file, content }];
export const command = (text, options = {}) => ["code", { command: text, ...options }];

/** Reads until `done` says so, for up to `seconds`. */
export async function until(what, read, done = Boolean, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  let value;
  for (;;) {
    value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`never happened: ${what}; last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settled = (run) => !["queued", "running", "waiting_approval"].includes(run.status);

/**
 * A fake OpenAI-compatible model. A request with `tools` takes the next step of `queue`: one call, a list of calls, or a
 * function answering the request itself. No step left means "done". Requests without tools (a chat's title, memory) just
 * get an answer and leave the queue alone.
 */
async function scriptedModel() {
  const queue = [];
  const requests = [];
  let calls = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const step = body.tools?.length ? queue.shift() : undefined;
      if (body.tools?.length) requests.push(body);
      if (typeof step === "function") return step(request, response);
      const list = step === undefined ? [] : typeof step[0] === "string" ? [step] : step;
      const toolCalls = list.map(([name, args]) => ({ id: `call_${calls += 1}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
      const message = toolCalls.length ? { role: "assistant", content: "", tool_calls: toolCalls } : { role: "assistant", content: "done" };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "reply",
        object: "chat.completion",
        model: "scripted",
        choices: [{ index: 0, finish_reason: toolCalls.length ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    queue,
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** Starts a runtime; `stop()` ends it with every fake model and temporary folder the bench made. */
export async function bench({ env = {}, dataDir, keepData, cwd } = {}) {
  const runtime = await startRuntime({ env: { ...GIT_ALONE, ...env }, ...(dataDir ? { dataDir } : {}), ...(keepData ? { keepData } : {}), ...(cwd ? { cwd } : {}) });
  const models = [];
  const folders = [];
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();

  const call = async (method, route, body) => {
    const response = await fetch(`${runtime.origin}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* Not JSON: left as text. */ }
    return { status: response.status, body: parsed };
  };
  const api = async (method, route, body) => {
    const answer = await call(method, route, body);
    assert.ok(answer.status < 300, `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };

  /** A new empty folder, by its real path: on macOS the temporary folder is reached through a link. */
  const folder = async () => {
    const made = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-files-")));
    folders.push(made);
    return made;
  };

  const finished = (runId) => until(`run ${runId} to end`, () => api("GET", `/runs/${runId}`), settled);

  /**
   * An agent on a new scripted model, and a chat. `projectFolder` makes it a project chat with access granted; without one
   * the chat is outside any project.
   */
  const chat = async (projectFolder, { autonomy = "bypass", ...agentFields } = {}) => {
    const model = await scriptedModel();
    models.push(model);
    const connection = await api("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "scripted", baseUrl: model.url });
    const agent = await api("POST", "/agents", { name: "Builder", modelConnectionId: connection.id, autonomy, ...agentFields });
    const project = projectFolder ? await api("POST", "/projects", { path: projectFolder, grant: true }) : undefined;
    const newThread = (title = "Files") => api("POST", `/agents/${agent.id}/threads`, { title, ...(project ? { projectId: project.id } : {}) });
    const thread = await newThread();
    /** Queues `steps` and starts a turn, without waiting for it. */
    const start = (steps = [], input = "go", threadId = thread.id) => {
      model.queue.push(...steps);
      return api("POST", `/agents/${agent.id}/runs`, { input, threadId });
    };
    /** One whole turn; it has to complete. */
    const turn = async (steps = [], input = "go", threadId = thread.id) => {
      const run = await finished((await start(steps, input, threadId)).id);
      assert.equal(run.status, "completed", run.error);
      return run;
    };
    return { model, agent, project, thread, newThread, start, turn };
  };

  const stop = async () => {
    await Promise.all(models.map((model) => model.stop()));
    await runtime.stop();
    await Promise.all(folders.map((item) => rm(item, { recursive: true, force: true })));
  };

  return { runtime, call, api, folder, finished, chat, stop };
}
