import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { geminiContents } from "../src/infrastructure/llm.js";
import { McpClient } from "../src/infrastructure/mcp.js";
import { runGeneralSkill } from "../src/infrastructure/skills.js";
import { createApp } from "../src/presentation/app.js";
import { FileStore } from "../src/infrastructure/store.js";
import { authorizeExecute } from "../src/domain/broker/policy.js";
import { CredentialDenied } from "../src/domain/errors.js";

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function boot(heartbeatMs = 25_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { app } = createApp(store, { heartbeatMs });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function bootSigned(heartbeatMs = 25_000, role: "admin" | "member" = "admin") {
  let agentCount = 0;
  const agents: { id: string; name: string; status: string }[] = [];
  const user = {
    id: "user_ada",
    email: "ada@acme.test",
    name: "Ada",
    role,
    permissions: role === "admin" ? { team: "write", agents: "write" } : { agents: "write" },
    organization: { id: "org_acme", name: "Acme", plan: "free", kind: "personal" },
    agents,
  };
  const cloud = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/auth/login") {
        res.end(JSON.stringify({ token: "token", user }));
        return;
      }
      if (req.method === "GET" && req.url === "/auth/me") {
        res.end(JSON.stringify(user));
        return;
      }
      if (req.method === "POST" && req.url === "/agents") {
        agentCount += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { name?: string };
        const agent = { id: `agent_${agentCount}`, name: body.name || "Agent", status: "active" };
        agents.push(agent);
        res.end(JSON.stringify(agent));
        return;
      }
      if (req.method === "PATCH" && String(req.url || "").startsWith("/agents/")) {
        res.end("{}");
        return;
      }
      if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  cloud.server.unref();
  const runtime = await boot(heartbeatMs);
  const signed = await fetch(`${runtime.base}/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "pw" }),
  });
  if (signed.status !== 200) {
    runtime.server.close();
    cloud.server.close();
    throw new Error(`sign in failed ${signed.status}`);
  }
  return { server: runtime.server, base: runtime.base, cloud };
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

test("loopback pages can call the runtime", async () => {
  const { server, base } = await boot();
  try {
    const allowed = await fetch(`${base}/health`, { headers: { origin: "http://127.0.0.1:5174" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:5174");
    assert.equal(allowed.headers.get("access-control-allow-private-network"), "true");
    const otherPort = await fetch(`${base}/health`, { headers: { origin: "http://127.0.0.1:4173" } });
    assert.equal(otherPort.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
    const blocked = await fetch(`${base}/health`, { headers: { origin: "https://example.com" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
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

test("broker rejects an absolute url and hides secrets", () => {
  assert.throws(
    () =>
      authorizeExecute(
        {
          id: "sec_1",
          name: "Agents",
          baseUrl: "http://model",
          secretName: "AGENTS_API_KEY",
          allowedCallers: ["runtime_operations"],
          allowedTools: [],
          allowedPaths: ["/chat/completions"],
          hasSecret: true,
        },
        { callerId: "runtime_operations", callerType: "runtime", admin: false },
        "",
        "https://evil.example/steal",
      ),
    CredentialDenied,
  );
});

test("unregistered run can call only the MCP attached to the agent", async () => {
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
  const runtime = await bootSigned();
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
  const runtime = await bootSigned();
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

test("login loads the account organization and its agents", async () => {
  const cloud = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/auth/login") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { email?: string; password?: string };
        if (body.email !== "ada@acme.test" || body.password !== "pw-1") {
          res.statusCode = 401;
          res.end(JSON.stringify({ detail: "Email or password is incorrect" }));
          return;
        }
        res.end(JSON.stringify({
          token: "secret-token",
          user: {
            email: "ada@acme.test",
            name: "Ada",
            role: "admin",
            organization: { id: "org_acme", name: "Acme" },
            agents: [{ id: "agent_cloud", name: "Research", description: "Org agent", status: "active" }],
            mcp_servers: [{ id: "mcp_cloud", name: "GitHub", endpoint: "http://127.0.0.1:9", tools: ["github.search"] }],
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const runtime = await boot();
  try {
    const denied = await fetch(`${runtime.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "nope" }),
    });
    assert.equal(denied.status, 401);
    const signedIn = await fetch(`${runtime.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "pw-1" }),
    });
    const session = await signedIn.json() as { loggedIn: boolean; organization: { name: string }; email: string };
    assert.equal(signedIn.status, 200);
    assert.equal(session.loggedIn, true);
    assert.equal(session.organization.name, "Acme");
    assert.equal(JSON.stringify(session).includes("secret-token"), false);
    assert.equal(JSON.stringify(session).includes("pw-1"), false);
    const agents = await fetch(`${runtime.base}/agents`);
    const listed = await agents.json() as { id: string; name: string; mcpConnectionIds: string[] }[];
    assert.deepEqual(listed.map((item) => item.name), ["Saturn Agents", "Research"]);
    assert.deepEqual(listed[0]?.mcpConnectionIds, ["general-skills"]);
    assert.deepEqual(listed[1]?.mcpConnectionIds, ["general-skills"]);
    const servers = (await (await fetch(`${runtime.base}/connections/mcp`)).json()) as { id: string }[];
    assert.equal(servers.some((item) => item.id === "mcp_cloud"), false);
  } finally {
    runtime.server.close();
    cloud.server.close();
  }
});

test("a signed-in agent can keep a directly connected MCP beside Saturn MCP", async () => {
  const user = {
    email: "ada@acme.test",
    name: "Ada",
    role: "member",
    permissions: { agents: "write" },
    organization: { id: "org_acme", name: "Acme" },
    agents: [{ id: "agent_cloud", name: "Research", status: "active", tool_set_id: "set_ops" }],
    mcp_servers: [{ id: "mcp_cloud", name: "GitHub", endpoint: "http://127.0.0.1:9", tools: ["github.search"] }],
    tool_sets: [{ id: "set_ops", name: "Ops", items: [{ name: "github.search", description: "Search" }] }],
  };
  const cloud = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/auth/login") {
        res.end(JSON.stringify({ token: "secret-token", user }));
        return;
      }
      if (req.method === "PATCH" && req.url === "/agents/agent_cloud") {
        res.end(JSON.stringify({ id: "agent_cloud" }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const runtime = await boot();
  try {
    const signedIn = await fetch(`${runtime.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "pw-1" }),
    });
    assert.equal(signedIn.status, 200);
    const created = await fetch(`${runtime.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mine", url: "http://127.0.0.1:9/mine" }),
    });
    const mine = (await created.json()) as { id: string; origin: string };
    assert.equal(created.status, 201);
    assert.equal(mine.origin, "local");
    const attached = await fetch(`${runtime.base}/agents/agent_cloud`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcpConnectionIds: [mine.id] }),
    });
    assert.equal(attached.status, 200);
    const again = await fetch(`${runtime.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "pw-1" }),
    });
    assert.equal(again.status, 200);
    const servers = (await (await fetch(`${runtime.base}/connections/mcp`)).json()) as { id: string; origin?: string }[];
    assert.equal(servers.some((item) => item.id === mine.id && item.origin === "local"), true);
    assert.equal(servers.some((item) => item.id === "mcp_cloud"), false);
    assert.equal(servers.some((item) => item.id === "saturn:agent_cloud" && item.origin === "saturn"), true);
    const agents = (await (await fetch(`${runtime.base}/agents`)).json()) as { id: string; mcpConnectionIds: string[] }[];
    const research = agents.find((item) => item.id === "agent_cloud");
    assert.equal(research?.mcpConnectionIds.includes(mine.id), true);
    assert.equal(research?.mcpConnectionIds.includes("saturn:agent_cloud"), false);
    assert.equal(research?.mcpConnectionIds.includes("general-skills"), true);
  } finally {
    runtime.server.close();
    cloud.server.close();
  }
});

test("app MCP syncs apart from Saturn Cloud connections", async () => {
  const saved: { servers?: { id: string }[]; attachments?: Record<string, string[]> }[] = [];
  const user = {
    email: "ada@acme.test",
    name: "Ada",
    role: "member",
    permissions: { agents: "write" },
    organization: { id: "org_acme", name: "Acme" },
    agents: [{ id: "agent_cloud", name: "Research", status: "active" }],
    mcp_servers: [{ id: "mcp_cloud", name: "GitHub", endpoint: "http://127.0.0.1:9", tools: ["github.search"] }],
    app_mcp: {
      servers: [{ id: "mcp_saved", name: "Mine", url: "http://127.0.0.1:9/mine", tools: [{ tool_id: "mine.search", description: "Search" }] }],
      attachments: { agent_cloud: ["mcp_saved"] },
    },
  };
  const cloud = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/auth/login") {
        res.end(JSON.stringify({ token: "secret-token", user }));
        return;
      }
      if (req.method === "PUT" && req.url === "/app-mcp") {
        saved.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        res.end(JSON.stringify({ servers: [], attachments: {} }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const runtime = await boot();
  try {
    const signedIn = await fetch(`${runtime.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "pw-1" }),
    });
    assert.equal(signedIn.status, 200);
    const servers = (await (await fetch(`${runtime.base}/connections/mcp`)).json()) as { id: string; origin?: string }[];
    assert.equal(servers.some((item) => item.id === "mcp_saved" && item.origin === "local"), true);
    assert.equal(servers.some((item) => item.id === "mcp_cloud"), false);
    const agents = (await (await fetch(`${runtime.base}/agents`)).json()) as { id: string; mcpConnectionIds: string[] }[];
    const research = agents.find((item) => item.id === "agent_cloud");
    assert.equal(research?.mcpConnectionIds.includes("mcp_saved"), true);
    assert.equal(research?.mcpConnectionIds.includes("mcp_cloud"), false);
    const created = await fetch(`${runtime.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Extra", url: "http://127.0.0.1:9/extra" }),
    });
    assert.equal(created.status, 201);
    assert.equal(saved.some((item) => (item.servers ?? []).some((server) => server.id === "mcp_saved")), true);
  } finally {
    runtime.server.close();
    cloud.server.close();
  }
});

test("agent messages stay with each user in the same organization", async () => {
  const users: Record<string, { id: string; email: string; name: string }> = {
    "ada@acme.test": { id: "user_ada", email: "ada@acme.test", name: "Ada" },
    "bea@acme.test": { id: "user_bea", email: "bea@acme.test", name: "Bea" },
  };
  const messages: Record<string, { id: string; input: string; output: string; status: string; actions: []; error: null }[]> = {
    user_ada: [{ id: "msg_ada", input: "Ada only", output: "hello ada", status: "completed", actions: [], error: null }],
    user_bea: [{ id: "msg_bea", input: "Bea only", output: "hello bea", status: "completed", actions: [], error: null }],
  };
  const cloud = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const token = String(req.headers.authorization || "").replace("Bearer ", "");
      const user = Object.values(users).find((item) => item.id === token);
      if (req.method === "POST" && req.url === "/auth/login") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { email?: string };
        const account = users[body.email || ""];
        if (!account) {
          res.statusCode = 401;
          res.end(JSON.stringify({ detail: "Email or password is incorrect" }));
          return;
        }
        res.end(JSON.stringify({
          token: account.id,
          user: {
            ...account,
            organization: { id: "org_acme", name: "Acme" },
            agents: [{ id: "agent_cloud", name: "Research", status: "active" }],
          },
        }));
        return;
      }
      if (req.method === "GET" && req.url === "/auth/me" && user) {
        res.end(JSON.stringify({
          ...user,
          organization: { id: "org_acme", name: "Acme" },
          agents: [{ id: "agent_cloud", name: "Research", status: "active" }],
        }));
        return;
      }
      if (req.method === "GET" && req.url === "/agents/agent_cloud/messages" && user) {
        res.end(JSON.stringify(messages[user.id]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not Found" }));
    });
  });
  const runtime = await boot();
  try {
    for (const email of ["ada@acme.test", "bea@acme.test"]) {
      const signedIn = await fetch(`${runtime.base}/session/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiBase: cloud.url, email, password: "pw" }),
      });
      assert.equal(signedIn.status, 200);
      const listed = await fetch(`${runtime.base}/agents/agent_cloud/messages`);
      const thread = (await listed.json()) as { input: string }[];
      assert.deepEqual(thread.map((item) => item.input), [email.startsWith("ada") ? "Ada only" : "Bea only"]);
      await fetch(`${runtime.base}/session`, { method: "DELETE" });
    }
    const again = await fetch(`${runtime.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "pw" }),
    });
    assert.equal(again.status, 200);
    const ada = await fetch(`${runtime.base}/agents/agent_cloud/messages`);
    const adaThread = (await ada.json()) as { input: string }[];
    assert.deepEqual(adaThread.map((item) => item.input), ["Ada only"]);
  } finally {
    runtime.server.close();
    cloud.server.close();
  }
});

test("saturn agents is first and general skills stay on", async () => {
  const runtime = await bootSigned();
  try {
    const mcp = await fetch(`${runtime.base}/connections/mcp`);
    const servers = (await mcp.json()) as { id: string; name: string; url: string; tools: { toolId: string }[] }[];
    const skills = servers.find((item) => item.id === "general-skills");
    assert.equal(skills?.name, "General Skills");
    assert.equal(skills?.url, "builtin://general-skills");
    assert.deepEqual(skills?.tools.map((item) => item.toolId), ["chat", "files", "code", "mcp", "web", "multi_step"]);
    const agents = await fetch(`${runtime.base}/agents`);
    const listed = (await agents.json()) as { id: string; name: string; mcpConnectionIds: string[] }[];
    assert.equal(listed[0]?.id, "saturn-agent");
    assert.equal(listed[0]?.name, "Saturn Agents");
    assert.deepEqual(listed[0]?.mcpConnectionIds, ["general-skills"]);
    const created = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research" }),
    });
    const body = (await created.json()) as { mcpConnectionIds: string[] };
    assert.equal(body.mcpConnectionIds.includes("general-skills"), true);
    const cleared = await fetch(`${runtime.base}/agents/saturn-agent`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcpConnectionIds: [] }),
    });
    const saved = (await cleared.json()) as { mcpConnectionIds: string[] };
    assert.equal(cleared.status, 200);
    assert.deepEqual(saved.mcpConnectionIds, ["general-skills"]);
    assert.equal((await fetch(`${runtime.base}/agents/saturn-agent`, { method: "DELETE" })).status, 403);
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
  const runtime = await bootSigned();
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

test("api keys are stored by the broker and never returned", async () => {
  const runtime = await bootSigned();
  try {
    const created = await fetch(`${runtime.base}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ERP",
        secretName: "ERP_API_KEY",
        baseUrl: "https://erp.example",
        allowedPaths: "/v1/*",
        value: "super-secret",
      }),
    });
    const body = await created.json();
    assert.equal(created.status, 201);
    assert.equal(JSON.stringify(body).includes("super-secret"), false);
    assert.equal(body.status, "configured");
    const listed = await fetch(`${runtime.base}/keys`);
    assert.equal((await listed.text()).includes("super-secret"), false);
    const settings = await fetch(`${runtime.base}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme", heartbeatSeconds: 30 }),
    });
    assert.equal(((await settings.json()) as { name: string }).name, "Acme");
  } finally {
    runtime.server.close();
  }
});

test("registered app announces itself and pauses when the cloud drops", async () => {
  const cloud = await fakeCloud(() => "allow");
  const runtime = await bootSigned(20);
  try {
    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research" }),
    });
    const agentBody = (await agent.json()) as { id: string };
    const mcp = await fetch(`${runtime.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitHub", url: "http://127.0.0.1:9", tools: [{ toolId: "github.search" }] }),
    });
    assert.equal(mcp.status, 201);
    const paired = await fetch(`${runtime.base}/session/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.apiBase, token: "user-token" }),
    });
    assert.equal(paired.status, 200);
    await waitUntil(() => cloud.messages.some((item) => item.type === "connector.heartbeat"));
    const types = cloud.messages.map((item) => item.type);
    assert.ok(types.includes("connection.init"));
    assert.ok(types.includes("runtime.register"));
    assert.equal(types.includes("mcp.register"), false);
    cloud.client?.close();
    await waitUntil(async () => {
      const current = await fetch(`${runtime.base}/agents/${agentBody.id}`);
      const body = (await current.json()) as { status: string };
      return body.status === "paused";
    });
  } finally {
    await cloud.close();
    runtime.server.close();
  }
});

test("approval holds the MCP call until Saturn resumes it", async () => {
  let mcpCalls = 0;
  const mcp = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { method?: string };
      if (body.method !== "tools/call") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
        return;
      }
      mcpCalls += 1;
      if (mcpCalls === 1) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "approval_required" } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
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
            choices: [{ message: { tool_calls: [{ type: "function", function: { name: "github.search", arguments: "{}" } }] } }],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    });
  });
    const cloud = await fakeCloud(() => "allow");
  const runtime = await bootSigned(25_000);
  try {
    const createdModel = await fetch(`${runtime.base}/connections/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", provider: "openai", baseUrl: model.url, secret: "sk-test" }),
    });
    const modelBody = (await createdModel.json()) as { id: string };
    assert.equal(JSON.stringify(modelBody).includes("sk-test"), false);
    const createdMcp = await fetch(`${runtime.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitHub", url: mcp.url, tools: [{ toolId: "github.search" }] }),
    });
    const mcpBody = (await createdMcp.json()) as { id: string };
    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Research",
        modelConnectionId: modelBody.id,
        mcpConnectionIds: [mcpBody.id],
      }),
    });
    const agentBody = (await agent.json()) as { id: string };
    const paired = await fetch(`${runtime.base}/session/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.apiBase, token: "user-token" }),
    });
    assert.equal(paired.status, 200);
    const started = await fetch(`${runtime.base}/agents/${agentBody.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "search" }),
    });
    const run = (await started.json()) as { id: string };
    const waiting = await waitFor(runtime.base, run.id, ["waiting_approval", "failed"]);
    assert.equal(waiting.status, "waiting_approval");
    assert.equal(mcpCalls, 1);
    const tasks = await fetch(`${runtime.base}/tasks`);
    const listed = (await tasks.json()) as { input: string; toolId: string; agentName: string }[];
    assert.equal(tasks.status, 200);
    assert.deepEqual(listed.map((item) => item.input), ["search"]);
    assert.equal(listed[0]?.toolId, "github.search");
    assert.equal(listed[0]?.agentName, "Research");
    cloud.client?.send(
      JSON.stringify({
        type: "command.resume",
        run_id: run.id,
        action_id: waiting.actions[0]?.id,
      }),
    );
    const finished = await waitFor(runtime.base, run.id, ["completed", "failed"]);
    assert.equal(finished.status, "completed");
    assert.equal(finished.output, "done");
    assert.equal(mcpCalls, 2);
    const remaining = await fetch(`${runtime.base}/tasks`);
    assert.deepEqual(await remaining.json(), []);
  } finally {
    await cloud.close();
    runtime.server.close();
    model.server.close();
    mcp.server.close();
  }
});

test("the app requires sign-in and only an admin can remove an agent", async () => {
  const locked = await boot();
  try {
    assert.equal((await fetch(`${locked.base}/agents`)).status, 401);
    const denied = await fetch(`${locked.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitHub", url: "http://127.0.0.1:9/mcp" }),
    });
    assert.equal(denied.status, 401);
  } finally {
    locked.server.close();
  }
  const runtime = await bootSigned(25_000, "member");
  try {
    const createdMcp = await fetch(`${runtime.base}/connections/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitHub", url: "http://127.0.0.1:9/mcp" }),
    });
    const mcpBody = (await createdMcp.json()) as { id: string };
    const agent = await fetch(`${runtime.base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research" }),
    });
    const agentBody = (await agent.json()) as { id: string };
    const deniedAgent = await fetch(`${runtime.base}/agents/${agentBody.id}`, { method: "DELETE" });
    assert.equal(deniedAgent.status, 403);
    const removedMcp = await fetch(`${runtime.base}/mcp/${mcpBody.id}`, { method: "DELETE" });
    assert.equal(removedMcp.status, 204);
    const still = await fetch(`${runtime.base}/agents/${agentBody.id}`);
    assert.equal(still.status, 200);
    const servers = await fetch(`${runtime.base}/connections/mcp`);
    const listed = (await servers.json()) as { id: string }[];
    assert.equal(listed.some((item) => item.id === mcpBody.id), false);
  } finally {
    runtime.cloud.server.close();
    runtime.server.close();
  }
});

async function fakeCloud(decide: () => string) {
  const messages: Record<string, unknown>[] = [];
  let client: WebSocket | null = null;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("no port");
  wss.on("connection", (socket) => {
    client = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      messages.push(message);
      if (message.type !== "policy.evaluate") return;
      socket.send(
        JSON.stringify({
          type: "policy.decision",
          request_id: message.request_id,
          payload: { status: decide() },
        }),
      );
    });
  });
  const http = await listen((req, res) => {
    if (req.method === "POST" && req.url === "/session/pair") {
      res.end(
        JSON.stringify({
          sessionId: "sess_test",
          wsUrl: `ws://127.0.0.1:${address.port}`,
          token: "session-token",
          organizationId: "org_test",
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return {
    messages,
    apiBase: http.url,
    get client() {
      return client;
    },
    close: async () => {
      client?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.server.close();
    },
  };
}

test("organization credentials sync to every signed-in runtime and stay off the desktop", async () => {
  const credentials = new Map<string, { kind: string; name: string; provider: string; model: string; base_url: string; secret_name: string; broker_id: string; allowed_paths: string[]; secret: string }>();
  credentials.set("mdl_shared", {
    kind: "model",
    name: "Gemini 3.8 Flash",
    provider: "gemini",
    model: "gemini-3.8-flash",
    base_url: "https://generativelanguage.googleapis.com",
    secret_name: "AGENTS_API_KEY",
    broker_id: "sec_shared",
    allowed_paths: ["/chat/completions"],
    secret: "org-model-secret",
  });
  const user = {
    email: "ada@acme.test",
    name: "Ada",
    role: "admin",
    permissions: { team: "write", agents: "write" },
    organization: { id: "org_acme", name: "Acme" },
    agents: [{
      id: "agent_cloud",
      name: "Research",
      description: "Org agent",
      status: "active",
      settings: {
        provider: "google",
        model: "gemini-3.8-flash",
        model_connection_id: "mdl_shared",
      },
    }],
    mcp_servers: [],
  };
  const cloud = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      if (req.method === "POST" && req.url === "/auth/login") {
        res.end(JSON.stringify({ token: "secret-token", user }));
        return;
      }
      if (req.method === "GET" && req.url === "/auth/me") {
        res.end(JSON.stringify(user));
        return;
      }
      if (req.method === "GET" && req.url === "/org/credentials") {
        res.end(JSON.stringify([...credentials.entries()].map(([id, item]) => ({
          id,
          kind: item.kind,
          name: item.name,
          provider: item.provider,
          model: item.model,
          base_url: item.base_url,
          secret_name: item.secret_name,
          broker_id: item.broker_id,
          allowed_paths: item.allowed_paths,
          has_secret: Boolean(item.secret),
        }))));
        return;
      }
      if (req.method === "GET" && req.url === "/org/credentials/secrets") {
        res.end(JSON.stringify([...credentials.entries()].filter(([, item]) => item.secret).map(([id, item]) => ({ id, secret: item.secret }))));
        return;
      }
      if (req.method === "POST" && req.url === "/org/credentials") {
        const id = String(body.id || "");
        credentials.set(id, {
          kind: String(body.kind || "key"),
          name: String(body.name || ""),
          provider: String(body.provider || ""),
          model: String(body.model || ""),
          base_url: String(body.base_url || ""),
          secret_name: String(body.secret_name || ""),
          broker_id: String(body.broker_id || id),
          allowed_paths: Array.isArray(body.allowed_paths) ? body.allowed_paths.map(String) : [],
          secret: typeof body.secret === "string" ? body.secret : credentials.get(id)?.secret || "",
        });
        const saved = credentials.get(id);
        res.end(JSON.stringify({ id, ...saved, has_secret: Boolean(saved?.secret), secret: undefined }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const runtime = await boot();
  try {
    const signedIn = await fetch(`${runtime.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiBase: cloud.url, email: "ada@acme.test", password: "pw-1" }),
    });
    assert.equal(signedIn.status, 200);
    const models = await fetch(`${runtime.base}/connections/models`);
    const modelText = await models.text();
    assert.equal(modelText.includes("org-model-secret"), false);
    const listed = JSON.parse(modelText) as { id: string; hasSecret: boolean }[];
    assert.equal(listed.some((item) => item.id === "mdl_shared" && item.hasSecret), true);
    const agents = await fetch(`${runtime.base}/agents`);
    const agentList = await agents.json() as { modelConnectionId: string | null }[];
    assert.equal(agentList[0]?.modelConnectionId, "mdl_shared");
    const created = await fetch(`${runtime.base}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ERP", secretName: "ERP_API_KEY", baseUrl: "https://erp.example", value: "org-key-secret" }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201);
    assert.equal(createdText.includes("org-key-secret"), false);
    assert.equal(credentials.get([...credentials.keys()].find((id) => credentials.get(id)?.secret_name === "ERP_API_KEY") || "")?.secret, "org-key-secret");
    credentials.set("sec_billing", {
      kind: "key",
      name: "Billing",
      provider: "",
      model: "",
      base_url: "https://billing.example",
      secret_name: "BILLING_API_KEY",
      broker_id: "sec_billing",
      allowed_paths: ["/"],
      secret: "billing-secret",
    });
    const refreshed = await fetch(`${runtime.base}/session/refresh`, { method: "POST" });
    assert.equal(refreshed.status, 200);
    const keys = await fetch(`${runtime.base}/keys`);
    const keyText = await keys.text();
    assert.equal(keyText.includes("billing-secret"), false);
    assert.equal(keyText.includes("org-key-secret"), false);
    const keyList = JSON.parse(keyText) as { secretName: string; hasSecret: boolean }[];
    assert.equal(keyList.some((item) => item.secretName === "BILLING_API_KEY" && item.hasSecret), true);
  } finally {
    runtime.server.close();
    cloud.server.close();
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

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met");
}
