import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { INSTALL_RECIPES } from "../src/domain/marketplace.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A real MCP server (official SDK, Streamable HTTP, stateless) with one tool. */
async function mcpServer(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const mcp = new McpServer({ name: "wiki", version: "1.0.0" });
    mcp.registerTool("ask_question", { description: "Answer a question about a repo", inputSchema: { question: z.string() } }, async ({ question }) => {
      calls.push(question);
      return { content: [{ type: "text", text: `answer to ${question}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

test("one-click install connects to a real MCP server, namespaces its tools and attaches them", async () => {
  const wiki = await mcpServer();
  const recipe = INSTALL_RECIPES.find((item) => item.id === "deepwiki")!;
  const original = recipe.url;
  recipe.url = wiki.url;
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  try {
    const agent = await services.createAgent({ name: "Coder" });
    const entry = await services.kernel.marketplace.install("deepwiki", { name: "DeepWiki" });
    assert.equal(entry.installed?.status, "ready");
    assert.equal(entry.installed?.tools, 1);
    assert.equal(entry.installed?.agents, 1);

    const connection = store.state.mcp.find((item) => item.id === "mkt-deepwiki")!;
    assert.equal(connection.name, "DeepWiki");
    assert.deepEqual(connection.tools.map((tool) => [tool.toolId, tool.remoteName]), [["deepwiki__ask_question", "ask_question"]]);
    assert.ok(store.state.agents.find((item) => item.id === agent.id)?.mcpConnectionIds.includes("mkt-deepwiki"));

    // The run side calls it by its prefixed id; the server receives its own name.
    const action = await services.executeTool({
      agentId: agent.id,
      toolId: "deepwiki__ask_question",
      arguments: { question: "what is saturn" },
      runId: "run_x",
      actionId: "act_x",
    });
    assert.equal(action.status, "completed");
    assert.deepEqual(wiki.calls, ["what is saturn"]);
    assert.match(JSON.stringify(action.result), /answer to what is saturn/);

    await services.kernel.marketplace.uninstall("deepwiki");
    assert.equal(store.state.mcp.some((item) => item.id === "mkt-deepwiki"), false);
    assert.equal(store.state.agents.find((item) => item.id === agent.id)?.mcpConnectionIds.includes("mkt-deepwiki"), false);
  } finally {
    recipe.url = original;
    wiki.server.close();
  }
});

test("integrations without an official server, or missing a credential, are refused with the reason", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  await assert.rejects(() => services.kernel.marketplace.install("seeking-alpha"), /no official MCP server/);
  await assert.rejects(() => services.kernel.marketplace.install("github"), /Paste a token/);
  await assert.rejects(() => services.kernel.marketplace.install("slack"), /OAuth client ID/);
  const list = services.kernel.marketplace.list();
  assert.equal(list.find((item) => item.id === "booking")?.available, false);
  assert.equal(list.find((item) => item.id === "notion")?.auth, "oauth");
  assert.equal(list.find((item) => item.id === "notion")?.installed, null);
});
