// What the contract/config-*.test.mjs share: one isolated runtime with its token, temporary folders, fake servers, and
// runs of agents on a scripted model. Nothing here reaches the developer's own Saturn, keys or any real provider.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { startRuntime } from "./runtime.mjs";

/** A run that has ended, whichever way. */
export const settled = (run) => !["queued", "running", "waiting_approval"].includes(run.status);

/** Starts a runtime on a temporary data folder, with a temporary folder for the test's own files. */
export async function open({ env = {} } = {}) {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-config-")));
  const dataDir = path.join(scratch, "data");
  await mkdir(dataDir);
  let runtime = await startRuntime({ dataDir, keepData: true, env });
  const servers = [];

  /** An API call with the token. Gives the status and the answer. */
  const call = async (method, route, body) => {
    const token = (await readFile(path.join(dataDir, "runtime-token"), "utf8")).trim();
    const response = await fetch(`${runtime.origin}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let answer = text;
    try {
      answer = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON: a page.
    }
    return { status: response.status, body: answer };
  };

  /** The same, refusing any status but the expected ones, so a test reads as the flow it checks. */
  const api = async (method, route, body, expected = [200, 201, 204]) => {
    const answer = await call(method, route, body);
    assert.ok(expected.includes(answer.status), `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };

  /** Checks that a call is refused with this status and says this. */
  const refused = async (method, route, body, status, says) => {
    const answer = await call(method, route, body);
    assert.equal(answer.status, status, `${method} ${route} ${JSON.stringify(body)}: ${JSON.stringify(answer.body)}`);
    if (says) assert.match(answer.body?.error ?? String(answer.body), says, `${method} ${route} ${JSON.stringify(body)}`);
  };

  /** Polls until `done(value)` holds, and answers the value. */
  const until = async (what, read, done, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`${what} did not happen: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  /** For `ms`, keeps checking that nothing more happens: `holds(value)` must stay true. */
  const stays = async (what, read, holds, ms = 1_200) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await read();
      assert.ok(holds(value), `${what}: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  /** A folder holding `files`, by path. Written over an earlier one of that name. */
  const folder = async (name, files = {}) => {
    const root = path.join(scratch, name);
    await mkdir(root, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
    }
    return root;
  };

  /** A server on a free port of this computer. `handle` gets the request, its body as text, and the response. */
  const serve = async (handle) => {
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => handle(request, raw, response));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };

  /**
   * A fake OpenAI-compatible model, saved as a connection. `steps` is its queue of [tool, arguments]: only a request with
   * `tools` takes one, since background work (a chat's title, memory) asks without tools. Then it answers `answer(body)`,
   * text or nothing ("finished"). Every request is kept. `hold`, when given, is awaited before each answer.
   */
  const model = async ({ steps = [], answer = () => "finished", hold } = {}) => {
    const requests = [];
    const queue = [...steps];
    let serial = 0;
    const url = await serve(async (_request, raw, response) => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      if (hold) await hold(body);
      const next = body.tools?.length ? queue.shift() : undefined;
      serial += 1;
      const message = next
        ? { role: "assistant", content: "", tool_calls: [{ id: `call_${serial}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] }
        : { role: "assistant", content: answer(body) };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: next ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    const connection = await api("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: url });
    return { requests, queue, url, connection };
  };

  /** An agent on a new scripted model, in a new chat in a project on `root` when given. */
  const chat = async ({ steps, answer, autonomy = "review", root, name = "Worker", ...extra } = {}) => {
    const scripted = await model({ steps, answer });
    const agent = await api("POST", "/agents", { name, modelConnectionId: scripted.connection.id, autonomy, ...extra });
    const project = root ? await api("POST", "/projects", { path: root, grant: true }) : undefined;
    const thread = await api("POST", `/agents/${agent.id}/threads`, { title: "Contract", ...(project ? { projectId: project.id } : {}) });
    return { model: scripted, agent, project, thread };
  };

  const getRun = (id) => api("GET", `/runs/${id}`);
  /** Starts a turn in the chat, and answers the run as started. */
  const start = (setup, input = "go") => api("POST", `/agents/${setup.agent.id}/runs`, { input, threadId: setup.thread.id });
  /** Waits for a run to end. */
  const finished = (id) => until(`run ${id} to end`, () => getRun(id), settled);
  /** Waits for a run to end or to show an approval card. */
  const stopped = (id) => until(`run ${id} to stop or ask`, () => getRun(id), (run) => run.status === "waiting_approval" || settled(run));
  /** Waits for a run to show an approval card, and answers the run and the action waiting. */
  const card = async (id) => {
    const run = await stopped(id);
    assert.equal(run.status, "waiting_approval", `expected a card: ${JSON.stringify(run)}`);
    return { run, action: run.actions.find((item) => item.status === "waiting_approval") };
  };

  /**
   * What happens to one shell command in this chat: "completed", "denied", or "asked" when it shows a card (the run is then
   * stopped, and the command never runs).
   */
  const verdict = async (setup, command) => {
    setup.model.queue.push(["code", { command }]);
    const run = await stopped((await start(setup, `run ${command}`)).id);
    const action = run.actions.find((item) => item.arguments?.command === command);
    if (run.status === "waiting_approval") {
      await api("POST", `/runs/${run.id}/stop`);
      await finished(run.id);
      return "asked";
    }
    assert.ok(action, `the command was never called: ${JSON.stringify(run)}`);
    return action.status;
  };

  /** Restarts the runtime on the same data. `change` may edit the state file while it is down. */
  const restart = async (change) => {
    await runtime.stop();
    if (change) {
      const file = path.join(dataDir, "state.json");
      const state = JSON.parse(await readFile(file, "utf8"));
      await change(state);
      await writeFile(file, JSON.stringify(state));
    }
    runtime = await startRuntime({ dataDir, keepData: true, env });
  };

  const close = async () => {
    await runtime.stop();
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  return { scratch, dataDir, call, api, refused, until, stays, folder, serve, model, chat, getRun, start, finished, stopped, card, verdict, restart, close };
}

/**
 * A hook as a command: a script run with node, so a test reads the same on every platform. `body` sees the hook's JSON as
 * `input`, and `note(text)` adds a line to the file at `log`.
 */
export async function hookCommand(directory, name, log, body) {
  const file = path.join(directory, `${name}.cjs`);
  await writeFile(file, `const fs = require("node:fs");
const note = (text) => fs.appendFileSync(${JSON.stringify(log)}, text + "\\n");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => { const input = JSON.parse(raw); ${body} });
`);
  return `"${process.execPath}" "${file}"`;
}

/** The lines a hook wrote so far. */
export async function logged(log) {
  return (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
}
