// What Settings → Logs shows: the level the user chose, and each configuration change with what changed, never a key or private text.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startRuntime } from "./runtime.mjs";

async function client(runtime) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const api = async (method, route, body) => {
    const response = await fetch(`${runtime.origin}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.ok(response.status < 300, `${method} ${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const lines = async () => {
    const answer = await api("GET", "/logs");
    return (Array.isArray(answer) ? answer : answer.lines ?? answer.logs ?? answer.entries).map((line) => `${line.level} ${line.service} ${line.message}`);
  };
  return { api, lines };
}

test("the logging level decides what is recorded, and changing it is on record both ways", async () => {
  const runtime = await startRuntime();
  try {
    const { api, lines } = await client(runtime);
    await api("PATCH", "/settings", { logging: "debug" });
    await api("PATCH", "/settings", { logging: "error" });
    assert.ok((await lines()).some((line) => line.includes("Logging level changed from debug to error")), "lowering it is still recorded");
    await api("POST", "/connections/models", { provider: "claude", model: "claude-sonnet-5-5" });
    assert.ok(!(await lines()).some((line) => line.includes("has no Claude API key")), "a warning is below the error floor");
    await api("PATCH", "/settings", { logging: "info" });
    assert.ok((await lines()).some((line) => line.includes("Logging level changed from error to info")), "raising it is recorded too");
  } finally {
    await runtime.stop();
  }
});

test("configuration changes are logged with what changed, and never the key or the instructions", async () => {
  const runtime = await startRuntime();
  try {
    const { api, lines } = await client(runtime);
    const model = await api("POST", "/connections/models", { provider: "claude", model: "claude-sonnet-5-5" });
    assert.ok((await lines()).some((line) => line.includes(`Model ${model.name} connected (Claude, no key)`)));
    assert.ok((await lines()).some((line) => line.startsWith(`warning catalog ${model.name} has no Claude API key`)));

    await api("PATCH", `/connections/models/${model.id}`, { secret: "sk-very-secret" });
    assert.ok((await lines()).some((line) => line.includes(`Model ${model.name} updated: API key (now the saved claude key)`)));
    const other = await api("POST", "/connections/models", { provider: "claude", model: "claude-haiku-4-5" });
    assert.ok((await lines()).some((line) => line.includes(`Model ${other.name} connected (Claude, using the saved Claude key)`)));
    const entered = await api("POST", "/connections/models", { provider: "openai", model: "x", secret: "sk-entered-secret" });
    assert.ok((await lines()).some((line) => line.includes(`Model ${entered.name} connected (OpenAI, key entered)`)));

    const agent = await api("POST", "/agents", { name: "Writer", modelConnectionId: model.id });
    await api("PATCH", `/agents/${agent.id}`, { autonomy: "fully_autonomous", instructions: "private text", name: "Writer" });
    assert.ok((await lines()).some((line) => line.includes('Agent "Writer" updated: instructions, autonomy')), "only what changed, in the agent's own order");
    const before = (await lines()).filter((line) => line.includes('Agent "Writer" updated')).length;
    await api("PATCH", `/agents/${agent.id}`, { name: "Writer" });
    assert.equal((await lines()).filter((line) => line.includes('Agent "Writer" updated')).length, before, "no change, no line");

    const automation = await api("POST", "/automations", { name: "Digest", agentId: agent.id, prompt: "Summarize", trigger: { frequency: "daily", time: "09:00", weekday: 1 }, timeZone: "UTC" });
    await api("PATCH", `/automations/${automation.id}`, { enabled: false });
    assert.ok((await lines()).some((line) => line.includes("Automation Digest paused")));

    await api("DELETE", `/agents/${agent.id}`);
    assert.ok((await lines()).some((line) => line.includes('Agent "Writer" deleted with 0 runs and 1 automations')));
    const all = JSON.stringify(await lines());
    for (const secret of ["sk-very-secret", "sk-entered-secret", "private text"]) assert.ok(!all.includes(secret), `${secret} stays out of the log`);
  } finally {
    await runtime.stop();
  }
});

test("an unreadable state file is kept aside, and Settings → Logs says so", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "saturn-contract-broken-"));
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "state.json"), "{ not json");
  const runtime = await startRuntime({ dataDir });
  try {
    const { api, lines } = await client(runtime);
    assert.deepEqual(await api("GET", "/agents"), []);
    assert.ok((await readdir(dataDir)).some((name) => name.startsWith("state.json.unreadable-")));
    assert.ok((await lines()).some((line) => line.startsWith("error store state.json is not valid JSON")));
  } finally {
    await runtime.stop();
  }
});
