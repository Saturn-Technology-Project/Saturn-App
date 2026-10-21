import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A real stdio MCP server: one tool that reports its greeting variable and whether a Saturn secret leaked in. */
async function writeServer(dir: string): Promise<string> {
  const sdk = (file: string) => pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server", file)).href;
  const zod = pathToFileURL(path.resolve("node_modules/zod/index.js")).href;
  const file = path.join(dir, "server.mjs");
  await writeFile(file, `
import { McpServer } from ${JSON.stringify(sdk("mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdk("stdio.js"))};
import { z } from ${JSON.stringify(zod)};
const server = new McpServer({ name: "probe", version: "1.0.0" });
server.tool("probe", "Reports the server's environment", { word: z.string() }, async ({ word }) => ({
  content: [{ type: "text", text: JSON.stringify({ word, greeting: process.env.GREETING ?? null, leaked: process.env.ANTHROPIC_API_KEY ?? null, cwd: process.cwd() }) }],
}));
await server.connect(new StdioServerTransport());
`);
  return file;
}

test("a local (stdio) MCP server starts only after its exact command is allowed, with a trimmed environment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "saturn-mcp-stdio-"));
  const script = await writeServer(dir);
  const store = new FileStore(dir);
  await store.load();
  const { services } = createApp(store);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-must-not-reach-the-server";
  try {
    const created = (await services.createMcp({ name: "Probe", command: { program: process.execPath, args: [script], env: { GREETING: "hello-from-settings" } } })) as unknown as {
      id: string; approval: string; commandLine: string; commandFingerprint: string;
    };
    assert.equal(created.approval, "needed", "nothing runs before the user allows it");
    assert.ok(created.commandLine.includes("server.mjs"));
    assert.ok(!(await readFile(path.join(dir, "state.json"), "utf8")).includes("hello-from-settings"), "variable values stay out of state.json");

    await assert.rejects(services.discoverMcp(created.id), /runs a program on this computer/);
    await assert.rejects(services.approveMcp(created.id, "0".repeat(64)), /command changed/);

    const approved = (await services.approveMcp(created.id, created.commandFingerprint)) as { approval: string };
    assert.equal(approved.approval, "approved");
    const discovered = await services.discoverMcp(created.id);
    assert.deepEqual(discovered?.tools.map((tool) => tool.toolId), ["probe"]);

    const server = store.state.mcp.find((item) => item.id === created.id)!;
    const result = (await services.kernel.mcp.call(services.kernel.catalog.targetFor(server), "probe", { word: "ping" }, undefined, {})) as { content: { text: string }[] };
    const seen = JSON.parse(result.content[0]!.text) as { word: string; greeting: string; leaked: string | null; cwd: string };
    assert.equal(seen.word, "ping");
    assert.equal(seen.greeting, "hello-from-settings", "the server gets the variables the user set");
    assert.equal(seen.leaked, null, "the runtime's own environment (API keys included) does not reach it");
    assert.equal(await import("node:fs").then((fs) => fs.realpathSync(seen.cwd)), await import("node:fs").then((fs) => fs.realpathSync(path.join(dir, "workspace"))));

    // Changing the command (or a variable) needs a new approval and stops the running server.
    const changed = (await services.updateMcp(created.id, { command: { program: process.execPath, args: [script, "--other"], env: { GREETING: "hello-from-settings" } } })) as unknown as { approval: string };
    assert.equal(changed.approval, "needed");
    assert.throws(() => services.kernel.catalog.targetFor(store.state.mcp.find((item) => item.id === created.id)!), /Allow it in Saturn Settings/);

    await services.deleteMcpServer(created.id);
    assert.equal(store.secret(`mcp:${created.id}:env`), undefined, "its variables are deleted with it");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("a local server's command is checked: a program is required and variable names must be valid", async () => {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-mcp-stdio-")));
  await store.load();
  const { services } = createApp(store);
  await assert.rejects(services.createMcp({ name: "x", command: { program: "  ", args: [] } }), /needs the program/);
  await assert.rejects(services.createMcp({ name: "x", command: { program: "npx", args: [1] } }), /Arguments must be text/);
  await assert.rejects(services.createMcp({ name: "x", command: { program: "npx", args: [], env: { "BAD NAME": "1" } } }), /not a valid environment variable/);
  // A URL server still cannot smuggle a command in.
  await assert.rejects(services.createMcp({ name: "x", url: "npx -y something" }), /does not start local programs/);
});
