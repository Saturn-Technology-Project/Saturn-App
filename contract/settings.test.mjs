// Settings, connections, projects and the workspace views, whichever language runs them: the routes the apps' settings pages use.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { posixOnly } from "./files-support.mjs";
import { startRuntime } from "./runtime.mjs";

let runtime;
let folder;
let outside;

before(async () => {
  runtime = await startRuntime();
  folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-settings-")));
  outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-outside-")));
});
after(async () => {
  await runtime?.stop();
  await rm(folder, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** An API call with the token. Gives the status and the answer. */
async function call(method, route, body) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
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
}

/** The same, refusing any status but the expected one. */
async function api(method, route, body, expected = 200) {
  const { status, body: answer } = await call(method, route, body);
  assert.equal(status, expected, `${method} ${route}: ${JSON.stringify(answer)}`);
  return answer;
}

test("a model's key is saved, serves its provider and is never returned", async () => {
  const secret = "contract-secret-value";
  const model = await api("POST", "/connections/models", { provider: "openai", model: "gpt-6-astra", secret }, 201);
  assert.equal(model.name, "GPT-6 Astra", "the provider's own name for it");
  assert.equal(model.hasSecret, true);
  const other = await api("POST", "/connections/models", { provider: "openai", model: "gpt-6-luna" }, 201);
  assert.equal(other.hasSecret, true, "the provider's saved key");
  const listed = await api("GET", "/connections/models");
  assert.ok(!JSON.stringify(listed).includes(secret));
  const updated = await api("PATCH", `/connections/models/${model.id}`, { name: "Renamed", effort: "high" });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.effort, "high");
  assert.equal((await api("PATCH", `/connections/models/${model.id}`, { effort: null })).effort, undefined);
  assert.ok(!(await readFile(path.join(runtime.dataDir, "state.json"), "utf8")).includes(secret));
  assert.equal((await call("POST", "/connections/models", { provider: "nobody", model: "x" })).status, 400);
  assert.equal((await call("POST", "/connections/models", { provider: "claude-code", model: "x", secret: "y" })).status, 400);
});

test("a connection an agent uses cannot be removed, and removing a model turns off what points at it", async () => {
  const model = await api("POST", "/connections/models", { provider: "lmstudio", model: "local" }, 201);
  const agent = await api("POST", "/agents", { name: "User", modelConnectionId: model.id }, 201);
  assert.equal((await call("DELETE", `/connections/models/${model.id}`)).status, 409);
  await api("PATCH", "/settings", { completionModelId: model.id });
  assert.equal((await api("PATCH", `/agents/${agent.id}`, { name: "Renamed", modelConnectionId: null })).name, "Renamed");
  await api("DELETE", `/connections/models/${model.id}`, undefined, 204);
  assert.equal((await api("GET", "/settings")).completionModelId, null);
  await api("DELETE", `/agents/${agent.id}`, undefined, 204);
  assert.equal((await call("GET", `/agents/${agent.id}`)).status, 404);
});

test("providers are listed with their models", async () => {
  const providers = await api("GET", "/llm/providers");
  assert.deepEqual(providers.map((item) => item.id), ["openai", "claude", "claude-code", "codex", "gemini", "deepseek", "lmstudio"]);
  assert.ok(providers[0].models.length > 0);
  // Mythos 5.1 is Fable 5.1 for verified organizations: offered on the API and through Claude Code, beside Fable.
  for (const id of ["claude", "claude-code"]) {
    const models = providers.find((item) => item.id === id).models.map((item) => item.id);
    assert.ok(models.includes("claude-fable-5-1") && models.includes("claude-mythos-5-1"), `${id}: ${models}`);
  }
  // One provider for every model server on this computer, under the id it had when it only meant LM Studio.
  assert.deepEqual(providers.at(-1), { id: "lmstudio", label: "Local server", needsKey: false, baseUrl: "http://127.0.0.1:1234", models: [] });
  assert.equal((await call("GET", "/llm/mlx/models")).status, 404, "MLX is no longer a provider of its own");
});

test("a cloud provider's models are listed for its saved key, the key goes only where a connection sends it, and the built-in list stands in", async () => {
  // Without a key: the built-in list, said to be one, and nothing sent anywhere.
  const bare = await api("GET", "/llm/providers/claude/models");
  assert.equal(bare.source, "built-in");
  assert.ok(bare.models.some((item) => item.id === "claude-mythos-5-1"));
  assert.match(bare.note, /No Claude API key is saved/);
  const plan = await api("GET", "/llm/providers/claude-code/models");
  assert.equal(plan.source, "built-in");
  assert.match(plan.note, /can be typed in/);
  assert.equal((await call("GET", "/llm/providers/lmstudio/models")).status, 404, "a local server lists at its own route");

  // A stand-in for Anthropic's model list: one built-in model, one Saturn does not know, and it records the headers.
  const asked = [];
  const server = createServer((request, response) => {
    asked.push({ url: request.url, key: request.headers["x-api-key"], version: request.headers["anthropic-version"] });
    if (request.headers["x-api-key"] !== "made-up-list-key") {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid x-api-key made-up-list-key" } }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "claude-next-6", display_name: "Claude Next 6", type: "model" },
      { id: "claude-fable-5-1", display_name: "Claude Fable 5.1 (listed)", type: "model" },
    ], has_more: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const query = `?baseUrl=${encodeURIComponent(url)}`;
    const refused = await call("GET", `/llm/providers/claude/models${query}`);
    assert.equal(refused.status, 400, "an address no connection uses gets no key");
    assert.equal(asked.length, 0);

    await api("POST", "/connections/models", { provider: "claude", model: "claude-fable-5-1", baseUrl: url, secret: "made-up-list-key" }, 201);
    const listed = await api("GET", `/llm/providers/claude/models${query}`);
    assert.equal(listed.source, "provider");
    assert.deepEqual(listed.models, [
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-next-6", label: "Claude Next 6" },
    ], "Saturn's names first, a new model after, a built-in one the key cannot use left out");
    assert.deepEqual(asked.at(-1), { url: "/v1/models?limit=1000", key: "made-up-list-key", version: "2023-06-01" });

    // A refused key: the built-in list again, and the provider's body (which can quote the key) is not passed on.
    // A model connected with another key replaces the provider's saved one.
    await api("POST", "/connections/models", { provider: "claude", model: "claude-opus-5-5", baseUrl: url, secret: "made-up-wrong-key" }, 201);
    const failed = await api("GET", `/llm/providers/claude/models${query}`);
    assert.equal(failed.source, "built-in");
    assert.match(failed.note, /did not list its models \(401\)/);
    assert.doesNotMatch(JSON.stringify(failed), /made-up/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a local server's model is connected without a key, from the models any OpenAI-compatible server lists", async () => {
  // A stand-in for a server that is not LM Studio (mlx_lm.server, Ollama, vLLM): no /api/v0/models, and /v1/models lists
  // embedding models among the chat models.
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(request.url);
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "mlx-community/Qwen3-8B-4bit", object: "model", created: 1 }, { id: "mlx-community/bge-embed", object: "model", created: 1 }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const listed = await api("GET", `/llm/lmstudio/models?baseUrl=${encodeURIComponent(url)}`);
    assert.deepEqual(listed, [{ id: "mlx-community/Qwen3-8B-4bit", label: "mlx-community/Qwen3-8B-4bit" }], "embedding models are left out");
    assert.deepEqual(asked, ["/api/v0/models", "/v1/models"]);
    const model = await api("POST", "/connections/models", { provider: "lmstudio", model: listed[0].id, baseUrl: url }, 201);
    assert.deepEqual([model.provider, model.model, model.baseUrl, model.hasSecret], ["lmstudio", "mlx-community/Qwen3-8B-4bit", url, false]);
    await api("DELETE", `/connections/models/${model.id}`, undefined, 204);
    assert.equal((await call("POST", "/connections/models", { provider: "mlx", model: "x", baseUrl: url })).status, 400, "mlx is not a provider to connect");
  } finally {
    server.close();
  }
  const stopped = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  assert.deepEqual(await api("GET", `/llm/lmstudio/models?baseUrl=${encodeURIComponent(stopped)}`), [], "none while it is not running");
});

test("a model saved as MLX by an earlier version is a local-server model at the same address", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "saturn-contract-mlx-"));
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
    models: [{ id: "mdl_mlx", name: "Qwen on MLX", provider: "mlx", model: "mlx-community/Qwen3-8B-4bit", baseUrl: "http://127.0.0.1:8080" }],
    agents: [{ id: "agt_1", name: "Local", modelConnectionId: "mdl_mlx" }],
  }));
  const older = await startRuntime({ dataDir });
  try {
    const token = (await readFile(path.join(older.dataDir, "runtime-token"), "utf8")).trim();
    const response = await fetch(`${older.origin}/connections/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const [model] = await response.json();
    assert.deepEqual([model.id, model.provider, model.model, model.baseUrl, model.hasSecret], ["mdl_mlx", "lmstudio", "mlx-community/Qwen3-8B-4bit", "http://127.0.0.1:8080", false]);
  } finally {
    await older.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an MCP server is added by URL only, and a local one waits for its exact command to be allowed", async () => {
  assert.equal((await call("POST", "/connections/mcp", { name: "Bad", url: "stdio:rm" })).status, 400);
  const remote = await api("POST", "/connections/mcp", { name: "Remote", url: "https://mcp.example.com/x?token=1" }, 201);
  assert.equal(remote.url, "https://mcp.example.com/x?token=1");
  const local = await api("POST", "/connections/mcp", { name: "Local", command: { program: "npx", args: ["-y", "a server"], env: { API_TOKEN: "contract-env-secret" } } }, 201);
  assert.equal(local.approval, "needed");
  assert.equal(local.commandLine, "npx -y 'a server'");
  assert.deepEqual(local.command.env, ["API_TOKEN"], "names only");
  assert.equal((await call("POST", `/connections/mcp/${local.id}/approve`, { fingerprint: "other" })).status, 409);
  const approved = await api("POST", `/connections/mcp/${local.id}/approve`, { fingerprint: local.commandFingerprint });
  assert.equal(approved.approval, "approved");
  const changed = await api("PATCH", `/connections/mcp/${local.id}`, { command: { program: "npx", args: ["-y", "another"] } });
  assert.equal(changed.approval, "needed", "a new command asks again");
  assert.ok(!(await readFile(path.join(runtime.dataDir, "state.json"), "utf8")).includes("contract-env-secret"));
  assert.equal((await call("POST", "/connections/mcp", { name: "Bad", command: { program: "x", env: { "A-B": "1" } } })).status, 400);
  assert.equal((await call("DELETE", "/mcp/general-skills")).status, 403);
  await api("DELETE", `/mcp/${local.id}`, undefined, 204);
  await api("DELETE", `/mcp/${remote.id}`, undefined, 204);
  assert.ok((await api("GET", "/connections/mcp")).some((item) => item.id === "general-skills"));
});

test("knowledge sources are added, changed and removed", async () => {
  const source = await api("POST", "/connections/rag", { name: "Docs", url: "https://rag.example.com" }, 201);
  assert.equal((await api("PATCH", `/connections/rag/${source.id}`, { name: "Notes" })).name, "Notes");
  assert.ok((await api("GET", "/connections/rag")).some((item) => item.id === source.id));
  await api("DELETE", `/connections/rag/${source.id}`, undefined, 204);
});

test("settings check what they are given and keep the rest", async () => {
  assert.equal((await call("PATCH", "/settings", { logging: "loud" })).status, 400);
  assert.equal((await call("PATCH", "/settings", { completionModelId: "nobody" })).status, 400);
  assert.equal((await call("PATCH", "/settings", { sandbox: { mode: "wide" } })).status, 400);
  const saved = await api("PATCH", "/settings", { name: "  Mine ", memory: false, sandbox: { mode: "read-only" } });
  assert.equal(saved.name, "Mine");
  assert.equal(saved.memory, false);
  assert.deepEqual(saved.sandbox, { mode: "read-only", network: true });
  assert.equal((await api("PATCH", "/settings", { sandbox: null, memory: true })).sandbox, undefined);
  assert.equal((await api("GET", "/information")).name, "Mine");
  assert.equal((await api("PATCH", "/settings", { permissions: [{ tool: "code", pattern: "*", effect: "allow" }] })).permissions, undefined, "rules go through /permissions");
});

test("memory is plain text, read and written by scope", async () => {
  assert.equal((await api("PUT", "/memory/global", { content: "- a note  \n\n" })).content, "- a note\n");
  assert.equal((await api("GET", "/memory/global")).content, "- a note\n");
  assert.equal((await api("GET", "/memory/..%2F..%2Fsecrets")).content, "", "a scope cannot leave the memory folder");
});

test("usage is empty before any call, and a bad range is refused", async () => {
  const summary = await api("GET", "/usage/summary");
  assert.equal(summary.currency, "USD");
  assert.equal(summary.totals.calls, 0);
  assert.equal(summary.since, null);
  assert.equal((await call("GET", "/usage/summary?from=never")).status, 400);
  assert.equal((await call("GET", "/usage/summary?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z")).status, 400);
  assert.deepEqual((await api("GET", "/usage/summary?from=2026-01-01T00:00:00.000Z")).range, { from: "2026-01-01T00:00:00.000Z", to: null });
});

test("a project needs its folder to exist, and its access can be taken back", async () => {
  assert.equal((await call("POST", "/projects", { path: path.join(folder, "missing") })).status, 400);
  const project = await api("POST", "/projects", { path: folder }, 201);
  assert.equal(project.access, null);
  assert.equal((await call("GET", `/projects/${project.id}/files`)).status, 403, "no access yet");
  const granted = await api("POST", `/projects/${project.id}/access`, {});
  assert.ok(granted.access.grantedAt);
  assert.deepEqual(granted.folders, [folder]);
  assert.equal((await call("PATCH", `/projects/${project.id}`, { name: " " })).status, 400);
  const updated = await api("PATCH", `/projects/${project.id}`, { description: " about ", verifyCommand: "npm test", sandbox: { mode: "off", network: false } });
  assert.equal(updated.description, "about");
  assert.equal(updated.verifyCommand, "npm test");
  assert.deepEqual(updated.sandbox, { mode: "off", network: false });
  await api("POST", `/projects/${project.id}/active`);
  assert.equal((await api("GET", "/projects/active")).id, project.id);
  assert.ok((await api("GET", "/projects")).some((item) => item.id === project.id));
});

test("rules and skills come from the project's folder", async () => {
  const project = await api("POST", "/projects", { path: folder, grant: true }, 201);
  assert.equal((await api("GET", `/projects/${project.id}/rules`)).source, "none");
  await api("PUT", `/projects/${project.id}/rules`, { content: "Be careful.", targetFile: "agents" });
  const rules = await api("GET", `/projects/${project.id}/rules`);
  assert.equal(rules.source, "agents");
  assert.equal(rules.content, "Be careful.");
  await mkdir(path.join(folder, ".saturn/skills/deploy"), { recursive: true });
  await writeFile(path.join(folder, ".saturn/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nRun it.\n");
  const skills = await api("GET", `/skills?projectId=${project.id}`);
  assert.equal(skills.find((item) => item.name === "deploy").description, "Ship it");
  assert.equal((await api("GET", `/skills/deploy?projectId=${project.id}`)).instructions, "Run it.");
  assert.equal((await call("GET", `/skills/none?projectId=${project.id}`)).status, 404);
});

test("attachments and the file view stay inside the project, through symbolic links too", async () => {
  const project = await api("POST", "/projects", { path: folder, grant: true }, 201);
  await writeFile(path.join(folder, "note.txt"), "inside text");
  await writeFile(path.join(outside, "private.txt"), "outside text");
  await symlink(path.join(outside, "private.txt"), path.join(folder, "link.txt"));
  const expanded = await api("POST", `/projects/${project.id}/context`, { items: [{ kind: "file", path: "note.txt" }, { kind: "file", path: "link.txt" }, { kind: "file", path: "../escape.txt" }, { kind: "terminal" }] });
  assert.match(expanded.text, /inside text/);
  assert.doesNotMatch(expanded.text, /outside text/);
  assert.match(expanded.text, /<error/);
  assert.ok(expanded.sources.includes("note.txt"));
  assert.ok((await api("GET", `/projects/${project.id}/files?q=note`)).includes("note.txt"));
  await api("POST", `/projects/${project.id}/active`);
  assert.equal((await api("GET", "/workspace/files?path=note.txt")).content, "inside text");
  assert.equal((await api("GET", "/workspace/files?path=link.txt")).kind, "directory", "refused: the folder instead");
  assert.equal((await api("GET", "/workspace/files?path=../..")).kind, "directory");
  assert.ok((await api("GET", "/workspace/files")).entries.some((item) => item.name === "note.txt"));
});

test("the terminal panel runs a command in the folder and follows cd", async () => {
  const project = await api("POST", "/projects", { path: folder, grant: true }, 201);
  await api("POST", `/projects/${project.id}/active`);
  assert.equal((await api("GET", "/workspace/info")).cwd, folder);
  await mkdir(path.join(folder, "sub"), { recursive: true });
  const moved = await api("POST", "/workspace/terminal", { command: "cd sub; echo hello" });
  assert.equal(moved.stdout.trim(), "hello");
  assert.equal(moved.exitCode, 0);
  assert.equal(moved.cwd, path.join(folder, "sub"));
  assert.equal((await api("POST", "/workspace/terminal", { command: "exit 3" })).exitCode, 3);
});

test("the token a launcher gives the runtime reaches no command the terminal panel runs", posixOnly, async () => {
  const launcherToken = "0123456789abcdef".repeat(4);
  const launched = await startRuntime({ env: { SATURN_RUNTIME_TOKEN: launcherToken } });
  try {
    assert.equal((await readFile(path.join(launched.dataDir, "runtime-token"), "utf8")).trim(), launcherToken, "the launcher's token is the runtime's");
    const answer = await fetch(`${launched.origin}/workspace/terminal`, {
      method: "POST",
      headers: { authorization: `Bearer ${launcherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "printf '[%s]' \"$SATURN_RUNTIME_TOKEN\"; env | grep -c SATURN_RUNTIME_TOKEN || true", cwd: folder }),
    }).then((response) => response.json());
    assert.equal(answer.stdout.trim(), "[]0", JSON.stringify(answer));
  } finally {
    await launched.stop();
  }
});

test("a terminal panel keeps what activate and export set for its next command, and only that panel does", posixOnly, async () => {
  const project = await api("POST", "/projects", { path: folder, grant: true }, 201);
  await api("POST", `/projects/${project.id}/active`);
  // A stand-in for a virtual environment's activate script: like the real one, it keeps the old PATH in a variable it does
  // not export, exports its own, and defines deactivate to put the old PATH back.
  await mkdir(path.join(folder, "venv/bin"), { recursive: true });
  await writeFile(path.join(folder, "venv/bin/activate"), [
    `VIRTUAL_ENV="${path.join(folder, "venv")}"`,
    '_OLD_VIRTUAL_PATH="$PATH"',
    "export VIRTUAL_ENV",
    'PATH="$VIRTUAL_ENV/bin:$PATH"',
    "export PATH",
    'deactivate () { PATH="$_OLD_VIRTUAL_PATH"; export PATH; unset _OLD_VIRTUAL_PATH VIRTUAL_ENV; }',
    "",
  ].join("\n"));
  const run = (command, session = "panel-a") => api("POST", "/workspace/terminal", { command, cwd: folder, session });
  const before = (await run('printf "%s" "$PATH"', "panel-before")).stdout;

  assert.equal((await run(". venv/bin/activate")).exitCode, 0);
  assert.equal((await run('printf "%s" "$VIRTUAL_ENV"')).stdout, path.join(folder, "venv"), "activate holds for the next command");
  assert.match((await run('printf "%s" "$PATH"')).stdout, new RegExp(`^${path.join(folder, "venv/bin")}:`));
  await run("export SATURN_PANEL_NOTE=kept");
  assert.equal((await run('printf "%s" "$SATURN_PANEL_NOTE"')).stdout, "kept");
  const answer = await run("true");
  assert.deepEqual(Object.keys(answer).sort(), ["cwd", "exitCode", "stderr", "stdout"], "the environment is never returned");
  assert.doesNotMatch(answer.stdout, /SATURN_(DEFINITIONS|ENVIRONMENT)/);
  // Output that looks like the runtime's own markers is only output: the markers are made anew for every command.
  const spoofed = await run('printf "%s" "__SATURN_ENVIRONMENT__:SATURN_PANEL_NOTE=spoofed"');
  assert.equal(spoofed.stdout, "__SATURN_ENVIRONMENT__:SATURN_PANEL_NOTE=spoofed");
  assert.equal((await run('printf "%s" "$SATURN_PANEL_NOTE"')).stdout, "kept", "and changes nothing for the next command");

  assert.equal((await run('printf "%s" "$VIRTUAL_ENV"', "panel-b")).stdout, "", "another panel starts fresh");
  assert.equal((await api("POST", "/workspace/terminal", { command: 'printf "%s" "$VIRTUAL_ENV"' })).stdout, "", "so does a command with no panel");

  assert.equal((await run("deactivate")).exitCode, 0, "the function activate defined is still there");
  assert.equal((await run('printf "%s" "${VIRTUAL_ENV-unset}"')).stdout, "unset", "and an unset holds too");
  assert.equal((await run('printf "%s" "$PATH"')).stdout, before, "the PATH kept in a shell variable comes back");
});

test("the in-app browser refuses private addresses, and answers with a page saying so", async () => {
  const { status, body } = await call("GET", `/workspace/browser/proxy?url=${encodeURIComponent(runtime.origin)}`);
  assert.equal(status, 200);
  assert.match(body, /Could not load page/);
});

test("hooks: the user's are saved, a project file's wait for that exact set", async () => {
  assert.equal((await call("PUT", "/hooks", { hooks: [{ event: "never", command: "x" }] })).status, 400);
  const saved = await api("PUT", "/hooks", { hooks: [{ event: "pre_tool", matcher: " code ", command: " echo hi " }] });
  assert.deepEqual(saved[0].hooks, [{ event: "pre_tool", matcher: "code", command: "echo hi" }]);
  await api("PUT", "/hooks", { hooks: [] });
  const project = await api("POST", "/projects", { path: folder, grant: true }, 201);
  await writeFile(path.join(folder, ".saturn/hooks.json"), JSON.stringify({ hooks: [{ event: "stop", command: "true" }] }));
  const held = (await api("GET", `/hooks?projectId=${project.id}`)).find((item) => item.source === "project-file");
  assert.equal(held.approved, false);
  assert.equal((await call("POST", `/projects/${project.id}/hooks/approve`, { file: ".saturn/hooks.json", fingerprint: "other" })).status, 409);
  const allowed = await api("POST", `/projects/${project.id}/hooks/approve`, { file: ".saturn/hooks.json", fingerprint: held.fingerprint });
  assert.equal(allowed.find((item) => item.source === "project-file").approved, true);
  const revoked = await api("DELETE", `/projects/${project.id}/hooks/approve`, { file: ".saturn/hooks.json" });
  assert.equal(revoked.find((item) => item.source === "project-file").approved, false);
});

test("a project file's allow rules wait for that exact set, and one that allows everything never applies", async () => {
  const project = await api("POST", "/projects", { path: folder, grant: true }, 201);
  await writeFile(path.join(folder, ".saturn/settings.json"), JSON.stringify({ permissions: { rules: [{ tool: "code", pattern: "npm *", effect: "allow" }, { tool: "code", pattern: "*", effect: "allow" }, { tool: "code", pattern: "rm *", effect: "deny" }] } }));
  const layers = await api("GET", `/permissions?projectId=${project.id}`);
  const file = layers.find((item) => item.scope === "project-file");
  assert.deepEqual(file.rules.map((rule) => rule.effect), ["deny"]);
  assert.equal(file.held.length, 1);
  assert.equal(file.refused.length, 1);
  const allowed = await api("POST", `/projects/${project.id}/permissions/approve`, { file: ".saturn/settings.json", fingerprint: file.fingerprint });
  assert.equal(allowed.find((item) => item.scope === "project-file").approved, true);
  const revoked = await api("DELETE", `/projects/${project.id}/permissions/approve`, { file: ".saturn/settings.json" });
  assert.equal(revoked.find((item) => item.scope === "project-file").approved, false);
  assert.equal((await call("POST", "/permissions/rules", { scope: "user", rule: { tool: "code", pattern: "*", effect: "allow" } })).status, 400);
});

test("the private snapshots can be listed, and only by their own names deleted", async () => {
  assert.deepEqual(await api("GET", "/storage/snapshots"), { folders: [], bytes: 0 });
  assert.equal((await call("DELETE", "/storage/snapshots/..%2F..")).status, 404);
  assert.deepEqual(await api("DELETE", "/storage/snapshots"), { deleted: true });
});
