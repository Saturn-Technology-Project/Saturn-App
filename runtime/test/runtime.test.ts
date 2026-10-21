import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { deepseek } from "../src/infrastructure/llm/deepseek.js";
import { geminiContents } from "../src/infrastructure/llm.js";
import { McpClient } from "../src/infrastructure/mcp.js";
import { runGeneralSkill } from "../src/infrastructure/skills.js";
import { createApp } from "../src/presentation/app.js";
import { realFetch, useRuntimeAuth } from "./runtime-token.js";
import { FileStore } from "../src/infrastructure/store.js";

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function boot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { app } = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  useRuntimeAuth(base);
  return { server, base };
}

test("gemini tool results end on a user turn", () => {
  const contents = geminiContents([
    { role: "user", content: "how many customers" },
    {
      role: "assistant",
      content: JSON.stringify([{
        id: "act_1",
        toolId: "crm.list_customers",
        arguments: {},
        status: "completed",
        result: { content: [{ type: "text", text: "[]" }] },
        thoughtSignature: "sig_crm",
      }]),
    },
  ]);
  assert.equal(contents.at(-1)?.role, "user");
  assert.equal(contents[0]?.role, "user");
  const call = contents[1]?.parts.find((part) => "functionCall" in part);
  assert.equal(call && "thoughtSignature" in call ? call.thoughtSignature : "", "sig_crm");
  assert.ok(contents.at(-1)?.parts.some((part) => "functionResponse" in part));
});

test("CORS allows Saturn's loopback windows and rejects web pages, including sandboxed (null-origin) ones", async () => {
  const { server, base } = await boot();
  try {
    const allowed = await fetch(`${base}/health`, { headers: { origin: "http://127.0.0.1:5174" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:5174");
    const otherPort = await fetch(`${base}/health`, { headers: { origin: "http://127.0.0.1:4173" } });
    assert.equal(otherPort.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
    const blocked = await fetch(`${base}/health`, { headers: { origin: "https://example.com" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    // A sandboxed iframe / data:/file: document sends the literal "null"; it must not be echoed as allowed.
    const nullOrigin = await fetch(`${base}/health`, { headers: { origin: "null" } });
    assert.equal(nullOrigin.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("the runtime rejects requests without the session token, and a non-loopback Host", async () => {
  const { server, base } = await boot();
  try {
    // No Authorization header: refused (the fetch wrapper only tokens requests through useRuntimeAuth's base,
    // so a bare realFetch stands in for any other local process or a web page).
    const noToken = await realFetch(`${base}/settings`);
    assert.equal(noToken.status, 401);
    const wrongToken = await realFetch(`${base}/settings`, { headers: { authorization: "Bearer not-the-token" } });
    assert.equal(wrongToken.status, 401);
    // The health probe is reachable without a token.
    const health = await realFetch(`${base}/health`);
    assert.equal(health.status, 200);
    // A page using a hostname that resolves to loopback (DNS rebinding) sends a foreign Host: refused. fetch
    // forbids setting Host, so this goes through http.request, which allows it.
    const port = Number(new URL(base).port);
    const rebindStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/health", headers: { host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebindStatus, 403);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("an unreachable MCP reports the host instead of fetch failed", async () => {
  await assert.rejects(
    new McpClient().call("http://mcp:4100", "crm.list_customers", {}, undefined, {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Could not reach http:\/\/mcp:4100/);
      assert.match(error.message, /ENOTFOUND/);
      return true;
    },
  );
});


test("local run can call only the MCP attached to the agent", async () => {
  const mcp = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { method?: string };
      if (body.method === "tools/call") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
        return;
      }
      res.end("{}");
    });
  });
  let calls = 0;
  const model = await listen((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      calls += 1;
      res.setHeader("content-type", "application/json");
      if (calls === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    { type: "function", function: { name: "github.search", arguments: "{\"q\":\"saturn\"}" } },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    });
  });
  const runtime = await boot();
  try {
    const createdModel = await fetch(`${runtime.base}/connections/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", provider: "openai", baseUrl: model.url }),
    });
    const modelBody = (await createdModel.json()) as { id: string; hasSecret: boolean };
    assert.equal(modelBody.hasSecret, false);
    assert.equal("value" in modelBody, false);

    const createdMcp = await fetch(`${runtime.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "GitHub",
        url: mcp.url,
        tools: [{ toolId: "github.search", description: "Search" }],
      }),
    });
    const mcpBody = (await createdMcp.json()) as { id: string };
    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Research",
        instructions: "Be brief",
        modelConnectionId: modelBody.id,
        mcpConnectionIds: [mcpBody.id],
      }),
    });
    const agentBody = (await agent.json()) as { id: string };
    const runResponse = await fetch(`${runtime.base}/agents/${agentBody.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "search saturn" }),
    });
    assert.equal(runResponse.status, 201);
    const started = (await runResponse.json()) as { id: string };
    const finished = await waitFor(runtime.base, started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.output, "done");
    assert.equal(finished.actions[0]?.status, "completed");
  } finally {
    runtime.server.close();
    model.server.close();
    mcp.server.close();
  }
});

test("editing a message reruns that turn and drops the ones after it", async () => {
  const batches: { role?: string; content?: string }[][] = [];
  const model = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
        messages?: { role?: string; content?: string }[];
      };
      const messages = body.messages ?? [];
      batches.push(messages);
      const lastUser = [...messages].reverse().find((item) => item.role === "user");
      res.setHeader("content-type", "application/json");
      const said = lastUser?.content ?? "";
      res.end(JSON.stringify({ choices: [{ message: { content: `echo ${said}`, thinking: `consider ${said}` } }] }));
    });
  });
  const runtime = await boot();
  try {
    const createdModel = await fetch(`${runtime.base}/connections/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", provider: "openai", baseUrl: model.url }),
    });
    const modelBody = (await createdModel.json()) as { id: string };
    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research", modelConnectionId: modelBody.id }),
    });
    const agentBody = (await agent.json()) as { id: string };
    const firstResponse = await fetch(`${runtime.base}/agents/${agentBody.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "alpha" }),
    });
    const first = (await firstResponse.json()) as { id: string };
    const alpha = await waitFor(runtime.base, first.id);
    assert.equal(alpha.output, "echo alpha");
    assert.equal((alpha as { thinking?: string }).thinking, "consider alpha");
    const secondResponse = await fetch(`${runtime.base}/agents/${agentBody.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "beta" }),
    });
    const second = (await secondResponse.json()) as { id: string };
    assert.equal((await waitFor(runtime.base, second.id)).output, "echo beta");
    const thirdResponse = await fetch(`${runtime.base}/agents/${agentBody.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "delta" }),
    });
    const third = (await thirdResponse.json()) as { id: string };
    assert.equal((await waitFor(runtime.base, third.id)).output, "echo delta");

    const revisedResponse = await fetch(`${runtime.base}/runs/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "gamma" }),
    });
    assert.equal(revisedResponse.status, 200);
    const revised = (await revisedResponse.json()) as { run: { id: string; input: string }; removed: string[] };
    assert.equal(revised.run.input, "gamma");
    assert.deepEqual(revised.removed, [third.id]);
    const finished = await waitFor(runtime.base, second.id);
    assert.equal(finished.output, "echo gamma");
    assert.equal(finished.actions.length, 0);
    const kept = await fetch(`${runtime.base}/runs/${first.id}`);
    assert.equal(kept.status, 200);
    const gone = await fetch(`${runtime.base}/runs/${third.id}`);
    assert.equal(gone.status, 404);

    const replay = batches.filter((messages) => messages.some((item) => item.role === "user" && item.content === "gamma"));
    assert.ok(replay.length >= 1);
    assert.ok(replay[0]?.some((item) => item.role === "user" && item.content === "alpha"));
    assert.ok(replay[0]?.some((item) => item.role === "assistant" && item.content === "echo alpha"));
    assert.equal(replay[0]?.some((item) => item.content === "beta" || item.content === "delta"), false);

    const listed = await fetch(`${runtime.base}/agents/${agentBody.id}/messages`);
    assert.equal(listed.status, 200);
    const messages = (await listed.json()) as { input: string }[];
    assert.deepEqual(messages.map((item) => item.input), ["alpha", "gamma"]);

    const empty = await fetch(`${runtime.base}/runs/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "   " }),
    });
    assert.equal(empty.status, 400);
  } finally {
    runtime.server.close();
    model.server.close();
  }
});

test("default agents list is empty, general skills stay on, and custom agents can be deleted", async () => {
  const runtime = await boot();
  try {
    const mcp = await fetch(`${runtime.base}/connections/mcp`);
    const servers = (await mcp.json()) as { id: string; name: string; url: string; tools: { toolId: string }[] }[];
    const skills = servers.find((item) => item.id === "general-skills");
    assert.equal(skills?.name, "General Skills");
    assert.equal(skills?.url, "builtin://general-skills");
    assert.deepEqual(skills?.tools.map((item) => item.toolId), ["files", "code", "code_output", "code_stop", "skill", "delegate", "mcp", "web", "multi_step"]);
    const agents = await fetch(`${runtime.base}/agents`);
    const listed = (await agents.json()) as { id: string; name: string; mcpConnectionIds: string[] }[];
    assert.equal(listed.length, 0);
    const created = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research" }),
    });
    const body = (await created.json()) as { id: string; mcpConnectionIds: string[] };
    assert.equal(body.mcpConnectionIds.includes("general-skills"), true);
    const cleared = await fetch(`${runtime.base}/agents/${body.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcpConnectionIds: [] }),
    });
    const saved = (await cleared.json()) as { mcpConnectionIds: string[] };
    assert.equal(cleared.status, 200);
    assert.deepEqual(saved.mcpConnectionIds, ["general-skills"]);
    assert.equal((await fetch(`${runtime.base}/agents/${body.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${runtime.base}/mcp/general-skills`, { method: "DELETE" })).status, 403);
    const workspace = await mkdtemp(path.join(os.tmpdir(), "saturn-skills-"));
    await runGeneralSkill(workspace, "files", { action: "write", path: "note.txt", content: "hi" });
    const read = (await runGeneralSkill(workspace, "files", { action: "read", path: "note.txt" })) as { content: string };
    assert.equal(read.content, "hi");
    await assert.rejects(() => runGeneralSkill(workspace, "files", { action: "read", path: "../secrets" }));
    const ran = (await runGeneralSkill(workspace, "code", { command: "echo ok" })) as { stdout: string };
    assert.match(ran.stdout, /ok/);
    await runGeneralSkill(workspace, "files", {
      action: "patch",
      patch: "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n+world\n*** End Patch\n",
    });
    const patched = (await runGeneralSkill(workspace, "files", {
      action: "patch",
      patch: "*** Begin Patch\n*** Update File: hello.txt\n@@\n Hello\n-world\n+there\n*** End Patch\n",
    })) as { applied: { action: string }[] };
    assert.equal(patched.applied[0]?.action, "update");
    const slice = (await runGeneralSkill(workspace, "files", { action: "read", path: "hello.txt", offset: 2, limit: 1 })) as { content: string };
    assert.equal(slice.content, "there");
    await assert.rejects(() => runGeneralSkill(workspace, "files", { action: "patch", patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+no\n*** End Patch\n" }));
    await assert.rejects(() => runGeneralSkill(workspace, "code", { command: "pwd", cwd: ".." }));
    const planned = (await runGeneralSkill(workspace, "multi_step", {
      steps: [
        { step: "Read the file", status: "completed" },
        { step: "Edit the file", status: "in_progress" },
      ],
    })) as { steps: { status: string }[] };
    assert.equal(planned.steps.filter((item) => item.status === "in_progress").length, 1);
    await assert.rejects(() => runGeneralSkill(workspace, "multi_step", {
      steps: [
        { step: "One", status: "in_progress" },
        { step: "Two", status: "in_progress" },
      ],
    }));
    await assert.rejects(() => runGeneralSkill(workspace, "web", { url: "http://10.1.2.3/secret" }));
    await assert.rejects(() => runGeneralSkill(workspace, "web", { url: "http://127.0.0.1/" }));
  } finally {
    runtime.server.close();
  }
});

test("stopping a run aborts a stuck model call", async () => {
  const model = await listen((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => undefined);
    res.writeHead(200, { "content-type": "application/json" });
  });
  const runtime = await boot();
  try {
    const createdModel = await fetch(`${runtime.base}/connections/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", provider: "openai", baseUrl: model.url, model: "slow" }),
    });
    const modelBody = (await createdModel.json()) as { id: string };
    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research", modelConnectionId: modelBody.id, mcpConnectionIds: [] }),
    });
    const agentBody = (await agent.json()) as { id: string };
    const started = await fetch(`${runtime.base}/agents/${agentBody.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "think for a long time" }),
    });
    const run = (await started.json()) as { id: string };
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopped = await fetch(`${runtime.base}/runs/${run.id}/stop`, { method: "POST" });
    const body = (await stopped.json()) as { status: string };
    assert.equal(stopped.status, 200);
    assert.equal(body.status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await fetch(`${runtime.base}/runs/${run.id}`);
    assert.equal(((await again.json()) as { status: string }).status, "cancelled");
  } finally {
    runtime.server.close();
    model.server.close();
  }
});

test("model api keys are stored securely and sent directly with requests", async () => {
  let receivedAuth = "";
  const model = await listen((req, res) => {
    receivedAuth = req.headers.authorization ?? "";
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello from direct model!" } }],
      }));
    });
  });
  const runtime = await boot();
  try {
    const created = await fetch(`${runtime.base}/connections/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "My Model",
        provider: "openai",
        model: "gpt-4o",
        baseUrl: model.url,
        secret: "super-secret-key-123",
      }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { id: string; hasSecret: boolean };
    assert.equal(body.hasSecret, true);
    assert.equal(JSON.stringify(body).includes("super-secret-key-123"), false);

    const listed = await fetch(`${runtime.base}/connections/models`);
    const listedText = await listed.text();
    assert.equal(listedText.includes("super-secret-key-123"), false);

    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Assistant", modelConnectionId: body.id, mcpConnectionIds: [] }),
    });
    const agentBody = (await agent.json()) as { id: string };

    const run = await fetch(`${runtime.base}/agents/${agentBody.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hi!" }),
    });
    const runBody = (await run.json()) as { id: string };
    const finished = await waitFor(runtime.base, runBody.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.output, "Hello from direct model!");
    assert.equal(receivedAuth, "Bearer super-secret-key-123");

    const settings = await fetch(`${runtime.base}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    assert.equal(((await settings.json()) as { name: string }).name, "Acme");
  } finally {
    runtime.server.close();
    model.server.close();
  }
});

test("custom agents and MCP connections can be created and removed locally without sign-in", async () => {
  const runtime = await boot();
  try {
    const createdMcp = await fetch(`${runtime.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitHub", url: "http://127.0.0.1:9/mcp" }),
    });
    assert.equal(createdMcp.status, 201);
    const mcpBody = (await createdMcp.json()) as { id: string; origin: string };
    assert.equal(mcpBody.origin, "local");
    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research", mcpConnectionIds: [mcpBody.id] }),
    });
    assert.equal(agent.status, 201);
    const agentBody = (await agent.json()) as { id: string; mcpConnectionIds: string[] };
    assert.equal(agentBody.mcpConnectionIds.includes(mcpBody.id), true);
    assert.equal(agentBody.mcpConnectionIds.includes("general-skills"), true);

    const removedMcp = await fetch(`${runtime.base}/mcp/${mcpBody.id}`, { method: "DELETE" });
    assert.equal(removedMcp.status, 204);
    const servers = await fetch(`${runtime.base}/connections/mcp`);
    const listed = (await servers.json()) as { id: string }[];
    assert.equal(listed.some((item) => item.id === mcpBody.id), false);

    const removedAgent = await fetch(`${runtime.base}/agents/${agentBody.id}`, { method: "DELETE" });
    assert.equal(removedAgent.status, 204);
    const gone = await fetch(`${runtime.base}/agents/${agentBody.id}`);
    assert.equal(gone.status, 404);
  } finally {
    runtime.server.close();
  }
});

test("DeepSeek provider calls native SDK client with reasoning_content and temperature pruning", async () => {
  let receivedAuth = "";
  let receivedBody: Record<string, unknown> = {};

  const model = await listen((req, res) => {
    receivedAuth = req.headers.authorization ?? "";
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      receivedBody = JSON.parse(data || "{}") as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "DeepSeek final result.",
                reasoning_content: "Thinking step 1: analyze query\nThinking step 2: formulate answer",
              },
            },
          ],
        }),
      );
    });
  });

  const runtime = await boot();
  try {
    const providersRes = await fetch(`${runtime.base}/llm/providers`);
    const providers = (await providersRes.json()) as { id: string; models: { id: string }[] }[];
    const dsProvider = providers.find((p) => p.id === "deepseek");
    assert.ok(dsProvider);
    assert.ok(dsProvider.models.some((m) => m.id === "deepseek-flash"));
    assert.ok(dsProvider.models.some((m) => m.id === "deepseek-v4-pro"));

    const createdModel = await fetch(`${runtime.base}/connections/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "DeepSeek R1",
        provider: "deepseek",
        model: "deepseek-reasoner",
        baseUrl: model.url,
        secret: "sk-deepseek-test-key",
      }),
    });
    assert.equal(createdModel.status, 201);
    const modelBody = (await createdModel.json()) as { id: string };

    const agentRes = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "DeepSeek Assistant",
        instructions: "You are a helpful reasoning assistant",
        temperature: 0.7,
        modelConnectionId: modelBody.id,
      }),
    });
    assert.equal(agentRes.status, 201);
    const agent = (await agentRes.json()) as { id: string };

    const runRes = await fetch(`${runtime.base}/agents/${agent.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Solve this problem" }),
    });
    assert.equal(runRes.status, 201);
    const started = (await runRes.json()) as { id: string };

    const finished = await waitFor(runtime.base, started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.output, "DeepSeek final result.");
    assert.equal(
      finished.thinking,
      "Thinking step 1: analyze query\nThinking step 2: formulate answer",
    );

    assert.equal(receivedAuth, "Bearer sk-deepseek-test-key");
    assert.equal(receivedBody.model, "deepseek-reasoner");
    assert.equal(receivedBody.temperature, undefined);
  } finally {
    runtime.server.close();
    model.server.close();
  }
});

test("the DeepSeek module handles reasoning_content and tool calls directly", async () => {
  let receivedBody: Record<string, unknown> = {};
  const server = await listen((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      receivedBody = JSON.parse(data || "{}") as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Calling tool",
                reasoning_content: "Need to check file",
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "/tmp/test.txt" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
  });

  try {
    const res = await deepseek.complete({
      model: "deepseek-reasoner",
      baseUrl: server.url,
      apiKey: "test-key",
      messages: [{ role: "user", content: "read file" }],
      tools: [],
      temperature: 0.8,
    });
    const message = (res.choices as { message: { content: string; thinking: string; tool_calls: { function: { name: string; arguments: string } }[] } }[])[0].message;

    assert.equal(message.content, "Calling tool");
    assert.equal(message.thinking, "Need to check file");
    assert.deepEqual(message.tool_calls, [{ function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/test.txt" }) } }]);
    assert.equal(receivedBody.temperature, undefined);
  } finally {
    server.server.close();
  }
});

test("an agent can have multiple conversations and each conversation is stored and isolated individually", async () => {
  const runtime = await boot();
  try {
    const agentRes = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MultiThreadAgent", modelConnectionId: null }),
    });
    const agent = (await agentRes.json()) as { id: string };

    // Create thread 1
    const t1Res = await fetch(`${runtime.base}/agents/${agent.id}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Conversation One" }),
    });
    assert.equal(t1Res.status, 201);
    const thread1 = (await t1Res.json()) as { id: string; title: string };
    assert.equal(thread1.title, "Conversation One");

    // Create thread 2
    const t2Res = await fetch(`${runtime.base}/agents/${agent.id}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Conversation Two" }),
    });
    assert.equal(t2Res.status, 201);
    const thread2 = (await t2Res.json()) as { id: string; title: string };

    // List threads
    const listRes = await fetch(`${runtime.base}/agents/${agent.id}/threads`);
    const threads = (await listRes.json()) as { id: string; title: string }[];
    assert.equal(threads.length, 2);
    assert.ok(threads.some((t) => t.id === thread1.id));
    assert.ok(threads.some((t) => t.id === thread2.id));

    // Rename thread
    const renameRes = await fetch(`${runtime.base}/threads/${thread1.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Thread 1" }),
    });
    assert.equal(renameRes.status, 200);
    const renamed = (await renameRes.json()) as { title: string };
    assert.equal(renamed.title, "Renamed Thread 1");

    // Delete thread 2
    const delRes = await fetch(`${runtime.base}/threads/${thread2.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 204);

    const afterDelRes = await fetch(`${runtime.base}/agents/${agent.id}/threads`);
    const afterDel = (await afterDelRes.json()) as { id: string }[];
    assert.equal(afterDel.length, 1);
    assert.equal(afterDel[0]?.id, thread1.id);
  } finally {
    runtime.server.close();
  }
});

async function waitFor(base: string, id: string, done = ["completed", "failed"]) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${base}/runs/${id}`);
    const run = (await response.json()) as {
      status: string;
      output: string;
      thinking?: string;
      actions: { id: string; status: string }[];
      error?: string;
    };
    if (done.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("run did not finish");
}

test("the in-app browser proxy refuses local and private addresses, and the file list stays inside the workspace", async () => {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-proxy-")));
  await store.load();
  const { app } = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    useRuntimeAuth(base);
    // The runtime's own API through its own proxy: refused instead of relayed.
    for (const target of [`${base}/agents`, "http://localhost:4700/settings", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/"]) {
      const response = await fetch(`${base}/workspace/browser/proxy?url=${encodeURIComponent(target)}`);
      const page = await response.text();
      assert.match(page, /Could not load page/, target);
      assert.match(page, /not allowed/, target);
      assert.doesNotMatch(page, /"id":/, "nothing from the target leaks");
    }
    // A sibling folder that shares the workspace's name as a prefix is outside it.
    const root = path.join(store.root, "workspace");
    const listed = (await (await fetch(`${base}/workspace/files?path=${encodeURIComponent(`${root}-other`)}`)).json()) as { path: string };
    assert.equal(listed.path, ".", "falls back to the workspace root");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("a public name that resolves to a private address is refused (DNS rebinding)", async () => {
  const { assertPublicHost } = await import("../src/infrastructure/public-host.js");
  const { isPrivateHost } = await import("../src/domain/skills/public-address.js");
  const resolver = (answers: string[]) => (async () => answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))) as never;
  await assert.rejects(() => assertPublicHost(new URL("https://rebind.example/"), resolver(["127.0.0.1"])), /not allowed/);
  await assert.rejects(() => assertPublicHost(new URL("https://mixed.example/"), resolver(["93.184.216.34", "10.0.0.5"])), /not allowed/, "one private answer is enough");
  await assert.rejects(() => assertPublicHost(new URL("https://v6.example/"), resolver(["fd12::1"])), /not allowed/);
  await assert.rejects(() => assertPublicHost(new URL("https://none.example/"), resolver([])), /not allowed/);
  await assertPublicHost(new URL("https://public.example/"), resolver(["93.184.216.34", "2606:2800:220:1::1"]));
  assert.deepEqual(
    ["::ffff:127.0.0.1", "fe80::1", "fc00::1", "::1", "169.254.169.254", "8.8.8.8", "2001:4860:4860::8888"].map(isPrivateHost),
    [true, true, true, true, true, false, false],
  );
});
