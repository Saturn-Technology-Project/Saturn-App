// What the contract/model-*.test.mjs files share: API calls with the token, waiting with a deadline, and fake model
// servers on this computer. Nothing here reaches a real provider, the developer's Saturn or GitHub.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

/** One tool call in a model's turn. */
export const call = (name, args, id = `call_${name}`) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/** An API call that gives back the status and the parsed body. */
export async function request(target, method, route, body, headers = {}) {
  const token = (await readFile(path.join(target.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${target.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** An API call that must succeed, so a test reads as the flow it checks. */
export async function api(target, method, route, body) {
  const answer = await request(target, method, route, body);
  assert.ok(answer.status < 300, `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** Reads until `done` says so, or fails after half a minute. */
export async function until(what, read, done = Boolean) {
  const deadline = Date.now() + 30_000;
  let value;
  for (;;) {
    value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`never happened: ${what}; last ${JSON.stringify(value)?.slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Whether a run has ended. */
export const settled = (run) => !["queued", "running", "waiting_approval"].includes(run.status);

/** A run, once it has ended. */
export const finished = (target, id) => until(`run ${id} ends`, () => api(target, "GET", `/runs/${id}`), settled);

/** Starts a server that collects each request's body, closed by `stop`. `answer` gets the body and the raw exchange. */
export async function fakeServer(answer) {
  const requests = [];
  const server = createServer((incoming, response) => {
    let raw = "";
    incoming.on("data", (chunk) => { raw += chunk; });
    incoming.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      requests.push({ ...body, __url: incoming.url });
      await answer(body, response, incoming);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/**
 * A fake OpenAI-compatible model. `reply(body)` answers with text, a list of tool calls, or { status, body } for an error;
 * nothing returned means "done".
 */
export function fakeModel(reply = () => undefined) {
  return fakeServer(async (body, response) => {
    const answer = (await reply(body)) ?? "done";
    if (answer.status) {
      response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body ?? { error: { message: "scripted failure" } }));
      return;
    }
    const toolCalls = Array.isArray(answer);
    const message = toolCalls ? { role: "assistant", content: "", tool_calls: answer } : { role: "assistant", content: answer };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: "reply",
      object: "chat.completion",
      model: "scripted",
      choices: [{ index: 0, finish_reason: toolCalls ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
    }));
  });
}

/** Whether the model already acted since the user's last message. */
export function actedSinceAsking(messages = []) {
  const asked = messages.findLastIndex((item) => item.role === "user");
  return messages.slice(asked + 1).some((item) => item.role === "tool" || item.tool_calls?.length);
}

/** The system prompt a request carried. */
export const systemOf = (body) => body.messages?.find((item) => item.role === "system")?.content ?? "";

/** The names of the tools a request offered. */
export const offeredBy = (body) => (body.tools ?? []).map((tool) => tool.function?.name);

/** A connection to `model`, an agent on it, and a chat for that agent, optionally in a project folder. */
export async function agentOn(target, model, { autonomy = "bypass", folder, mcpConnectionIds, connection = {}, title = "Contract" } = {}) {
  const made = await api(target, "POST", "/connections/models", { name: "Scripted", provider: "openai", model: "scripted", baseUrl: model.url, apiKey: "scripted-test-value", ...connection });
  const agent = await api(target, "POST", "/agents", { name: "Builder", modelConnectionId: made.id, autonomy, ...(mcpConnectionIds ? { mcpConnectionIds } : {}) });
  const project = folder ? await api(target, "POST", "/projects", { path: folder, grant: true }) : undefined;
  const thread = await api(target, "POST", `/agents/${agent.id}/threads`, { title, ...(project ? { projectId: project.id } : {}) });
  return { connection: made, agent, project, thread };
}

/** One message in a chat, up to the end of its run. */
export async function turn(target, setup, input = "go") {
  const started = await api(target, "POST", `/agents/${setup.agent.id}/runs`, { input, threadId: setup.thread.id });
  return finished(target, started.id);
}
