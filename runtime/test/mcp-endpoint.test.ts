import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mcpEndpoint } from "../src/application/catalog.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

test("an MCP server is an HTTP(S) endpoint: adding one never makes Saturn start a local program", async () => {
  assert.equal(mcpEndpoint(" https://mcp.example.com/mcp "), "https://mcp.example.com/mcp");
  assert.equal(mcpEndpoint("http://127.0.0.1:3845/mcp"), "http://127.0.0.1:3845/mcp");
  for (const attempt of ["npx -y @evil/mcp-server", "node server.js", "stdio:node server.js", "file:///usr/bin/python3", "javascript:alert(1)", "/usr/local/bin/mcp"]) {
    assert.throws(() => mcpEndpoint(attempt), /Saturn does not start local programs/, attempt);
  }

  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-mcp-endpoint-")));
  await store.load();
  const { services } = createApp(store);
  await assert.rejects(services.createMcp({ name: "Local", url: "npx -y some-mcp" }), /does not start local programs/);
  const added = await services.createMcp({ name: "Remote", url: "https://mcp.example.com/mcp" });
  await assert.rejects(services.updateMcp(added.id, { url: "stdio:./run.sh" }), /not stdio/);
  assert.equal(store.state.mcp.find((item) => item.id === added.id)?.url, "https://mcp.example.com/mcp", "a refused change leaves the server as it was");
});
