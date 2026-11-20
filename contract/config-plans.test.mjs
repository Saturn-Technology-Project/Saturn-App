// Models on the user's own plan (Claude Code, Codex), a saved key serving its provider, and the state file kept as it
// is by reads, whichever language runs them. No real provider is ever reached.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { open } from "./config-harness.mjs";

let workbench;

before(async () => {
  workbench = await open();
});
after(async () => {
  await workbench?.close();
});

test("plan models take no API key, and the provider is named Claude (via Claude Code)", async () => {
  for (const [provider, name] of [["claude-code", "claude-sonnet-5-5"], ["codex", "gpt-5.5"]]) {
    await workbench.refused("POST", "/connections/models", { provider, model: name, secret: "contract-value" }, 400, /takes no API key/);
    const model = await workbench.api("POST", "/connections/models", { provider, model: name });
    assert.equal(model.hasSecret, false);
    await workbench.refused("PATCH", `/connections/models/${model.id}`, { secret: "contract-value" }, 400, /takes no API key/);
    await workbench.api("DELETE", `/connections/models/${model.id}`);
  }
  const providers = await workbench.api("GET", "/llm/providers");
  assert.equal(providers.find((item) => item.id === "claude-code").label, "Claude (via Claude Code)");
});

test("a provider's saved API key serves its other models, and a model without one says so before any request", async () => {
  const first = await workbench.api("POST", "/connections/models", { provider: "gemini", model: "gemini-flash", secret: "contract-gemini-value" });
  assert.equal(first.hasSecret, true);
  const second = await workbench.api("POST", "/connections/models", { provider: "gemini", model: "gemini-pro" });
  assert.equal(second.hasSecret, true);

  const keyless = await workbench.api("POST", "/connections/models", { provider: "claude", model: "claude-sonnet-5-5" });
  assert.equal(keyless.hasSecret, false);
  const agent = await workbench.api("POST", "/agents", { name: "Writer", modelConnectionId: keyless.id });
  await workbench.refused("POST", `/agents/${agent.id}/runs`, { input: "hi" }, 409, /no Claude API key/);

  assert.equal((await workbench.api("PATCH", `/connections/models/${keyless.id}`, { secret: "contract-claude-value" })).hasSecret, true);
  const listed = await workbench.api("GET", "/connections/models");
  assert.ok(listed.filter((item) => ["gemini", "claude"].includes(item.provider)).every((item) => item.hasSecret));
  assert.doesNotMatch(JSON.stringify(listed), /contract-gemini-value|contract-claude-value/);
});

test("polling reads do not rewrite the state file, and a state missing the built-ins is repaired at the next start", async () => {
  const fresh = await open();
  try {
    const file = path.join(fresh.dataDir, "state.json");
    const agent = await fresh.api("POST", "/agents", { name: "Reader" });
    assert.ok(agent.mcpConnectionIds.includes("general-skills"));
    // Whatever settling a new agent still writes is done before the reads below.
    const written = async () => { const info = await stat(file); return `${info.mtimeMs} ${info.size} ${await readFile(file, "utf8")}`; };
    await fresh.api("GET", "/agents");
    await fresh.api("GET", "/connections/mcp");
    const first = await written();
    await fresh.stays("reads leaving the state file alone", async () => {
      await fresh.api("GET", "/agents");
      await fresh.api("GET", "/connections/mcp");
      return await written();
    }, (now) => now === first, 500);

    await fresh.restart((state) => { state.agents.find((item) => item.id === agent.id).mcpConnectionIds = []; });
    const repaired = (await fresh.api("GET", "/agents")).find((item) => item.id === agent.id);
    assert.ok(repaired.mcpConnectionIds.includes("general-skills"), JSON.stringify(repaired.mcpConnectionIds));
  } finally {
    await fresh.close();
  }
});
