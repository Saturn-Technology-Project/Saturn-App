import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

async function body(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** A model that loads the GitHub toolkit on its first step, then answers; it records what each request offered. */
async function loadingModel() {
  const requests: { tools: string[]; system: string }[] = [];
  const server = createServer(async (req, res) => {
    const sent = JSON.parse((await body(req)) || "{}") as { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: string }[] };
    const tools = (sent.tools ?? []).map((tool) => tool.function?.name ?? "");
    requests.push({ tools, system: sent.messages?.find((item) => item.role === "system")?.content ?? "" });
    const acted = sent.messages?.some((item) => item.role === "assistant" && item.content?.includes('"load_tools"'));
    const ask = sent.messages?.filter((item) => item.role === "user").at(-1)?.content ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: !acted && /pull request/.test(ask) && tools.includes("load_tools")
      ? { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ toolkits: ["github"] }) } }] }
      : { content: "done" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function until(read: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("heavy toolkits load on demand: named in the prompt, offered after load_tools, and kept for the rest of the chat", async () => {
  const model = await loadingModel();
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-toolkits-")));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "M", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "A", modelConnectionId: connection.id, mcpConnectionIds: ["general-skills", "origin", "browser", "computer-use"] });
    const runs = services.kernel.runs;
    const done = (id: string) => () => store.state.runs.find((run) => run.id === id)?.status === "completed";

    // A turn that needs no toolkit: none of their tools are sent, and the prompt says how to load each.
    const first = await runs.startRun(agent.id, "hello");
    await until(done(first.id), "the first turn");
    const plain = model.requests[0]!;
    assert.ok(plain.tools.includes("files") && plain.tools.includes("load_tools"));
    assert.ok(!plain.tools.some((name) => name.startsWith("browser_") || name.startsWith("computer_") || name === "create_pull_request"));
    assert.match(plain.system, /load_tools` with toolkits: \["github"\]/);
    assert.match(plain.system, /load_tools` with toolkits: \["browser"\]/);

    // A turn that loads GitHub: its tools arrive on the next step, and the prompt no longer asks to load it.
    const second = await runs.startRun(agent.id, "open a pull request", first.threadId);
    await until(done(second.id), "the loading turn");
    const after = model.requests.at(-1)!;
    assert.ok(after.tools.includes("create_pull_request"));
    assert.ok(!after.tools.some((name) => name.startsWith("browser_")), "only the toolkit asked for");
    assert.doesNotMatch(after.system, /toolkits: \["github"\]/);
    assert.deepEqual(store.state.runs.find((run) => run.id === second.id)?.toolkits, ["origin"]);

    // Later turns in the same chat keep it; a new chat starts without it.
    const third = await runs.startRun(agent.id, "thanks", first.threadId);
    await until(done(third.id), "the next turn");
    assert.ok(model.requests.at(-1)!.tools.includes("create_pull_request"));
    const fresh = await runs.createThread(agent.id, "Another chat");
    const elsewhere = await runs.startRun(agent.id, "hi again", fresh.id);
    await until(done(elsewhere.id), "a new chat");
    assert.ok(!model.requests.at(-1)!.tools.includes("create_pull_request"));

    // An unknown toolkit is refused with the list.
    const refused = await runs.executeTool({ agentId: agent.id, toolId: "load_tools", arguments: { toolkits: ["spreadsheets"] }, runId: elsewhere.id, actionId: "a1" });
    assert.equal(refused.status, "failed");
    assert.match(refused.reason ?? "", /Available: github, browser, computer/);
  } finally {
    model.server.close();
  }
});
