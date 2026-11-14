// Plugins and what a project's files may bring into a prompt, whichever language runs them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

let runtime;
let scratch;
const servers = [];

before(async () => {
  runtime = await startRuntime();
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-plugins-")));
});
after(async () => {
  await runtime?.stop();
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(scratch, { recursive: true, force: true });
});

async function call(method, route, body) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  return fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function api(method, route, body, expected = [200, 201, 204]) {
  const response = await call(method, route, body);
  const text = await response.text();
  assert.ok(expected.includes(response.status), `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** A folder holding `files`, by path. */
async function folder(name, files) {
  const root = path.join(scratch, name);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

/** A scripted model: `chat` answers each chat request. */
async function model(chat) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text);
      requests.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: chat(body) } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

test("a plugin installs from a folder and brings its skills, hooks and servers, running nothing", async () => {
  const source = await folder("good-plugin", {
    "plugin.json": JSON.stringify({ name: "Good-Plugin", description: "It helps", version: "1.2.0" }),
    "skills/review/SKILL.md": "---\nname: review\ndescription: Reviews\n---\nLook closely.\n",
    "commands/ship.md": "Ship $ARGUMENTS.\n",
    "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/check.sh" }] }] } }),
    ".mcp.json": JSON.stringify({ mcpServers: { local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/s.js"], env: { A: "1" } }, remote: { url: "https://mcp.example.com/" } } }),
    ".git/config": "not copied",
    "node_modules/x/index.js": "not copied",
  });
  const plugin = await api("POST", "/plugins", { source });
  assert.equal(plugin.name, "good-plugin");
  assert.equal(plugin.version, "1.2.0");
  assert.equal(plugin.description, "It helps");
  assert.equal(plugin.enabled, true);
  assert.deepEqual(plugin.skills, ["review"]);
  assert.equal(plugin.hooksApproved, false);
  assert.equal(plugin.hooks[0].matcher, "code");
  // The plugin's folder as this system writes it, then what the plugin wrote after it.
  assert.equal(plugin.hooks[0].command, `${path.join(runtime.dataDir, "plugins/good-plugin")}/check.sh`);
  assert.deepEqual(plugin.mcpServers.map((item) => [item.name, item.kind]), [["local", "command"], ["remote", "url"]]);
  assert.ok(plugin.mcpServers.every((item) => item.id));
  await assert.rejects(readFile(path.join(plugin.path, ".git/config")));
  await assert.rejects(readFile(path.join(plugin.path, "node_modules/x/index.js")));

  const connections = await api("GET", "/connections/mcp");
  const local = connections.find((item) => item.name === "good-plugin: local");
  assert.equal(local.approval, "needed", "a plugin's program waits for the usual approval");
  assert.ok((await api("GET", "/skills")).some((item) => item.name === "review" && item.source === "plugin"));

  const held = (await api("GET", "/hooks")).find((item) => item.source === "plugin");
  assert.equal(held.approved, false);
  await api("POST", "/plugins/good-plugin/hooks/approve", { fingerprint: "other" }, [409]);
  assert.equal((await api("POST", "/plugins/good-plugin/hooks/approve", { fingerprint: plugin.hooksFingerprint })).hooksApproved, true);
  assert.equal((await api("GET", "/hooks")).find((item) => item.source === "plugin").approved, true);

  const off = await api("PATCH", "/plugins/good-plugin", { enabled: false });
  assert.equal(off.enabled, false);
  assert.ok(!(await api("GET", "/connections/mcp")).some((item) => item.pluginName === "good-plugin"), "off takes its servers away");
  assert.ok(!(await api("GET", "/skills")).some((item) => item.name === "review"));
  assert.equal((await api("PATCH", "/plugins/good-plugin", {})).enabled, true);
  assert.ok((await api("GET", "/connections/mcp")).some((item) => item.pluginName === "good-plugin"));
  await api("POST", "/plugins", { source }, [409]);
  await api("DELETE", "/plugins/good-plugin");
  await assert.rejects(readFile(path.join(plugin.path, "plugin.json")));
  assert.deepEqual(await api("GET", "/plugins"), []);
  await api("DELETE", "/plugins/good-plugin", undefined, [404]);
});

test("what cannot be a plugin is refused", async () => {
  await api("POST", "/plugins", { source: " " }, [400]);
  await api("POST", "/plugins", { source: "relative/folder" }, [400]);
  await api("POST", "/plugins", { source: "http://example.com/plain.git" }, [400]);
  await api("POST", "/plugins", { source: await folder("no-manifest", { "README.md": "x" }) }, [400]);
  await api("POST", "/plugins", { source: await folder("bad-name", { "plugin.json": JSON.stringify({ name: "../../evil" }) }) }, [400]);
  assert.deepEqual(await api("GET", "/plugins"), []);
});

test("a link in a plugin cannot carry a file from elsewhere on the computer into it", async () => {
  const outside = await folder("outside-plugin", { "private.txt": "plugin-outside-secret" });
  const source = await folder("linking-plugin", { "plugin.json": JSON.stringify({ name: "linking" }), "skills/fine/SKILL.md": "Fine.\n" });
  await mkdir(path.join(source, "skills/leak"), { recursive: true });
  await symlink(path.join(outside, "private.txt"), path.join(source, "skills/leak/SKILL.md"));
  await api("POST", "/plugins", { source });
  const skills = await api("GET", "/skills");
  assert.ok(skills.some((item) => item.name === "fine"));
  assert.ok(!skills.some((item) => item.name === "leak"));
  await api("GET", "/skills/leak", undefined, [404]);
  await api("DELETE", "/plugins/linking");
});

test("a project's links cannot bring a file from elsewhere on the computer into a prompt", async () => {
  const outside = await folder("outside-project", { "private.txt": "project-outside-secret" });
  const root = await folder("linking-project", { "real.md": "inside rule" });
  await symlink(path.join(outside, "private.txt"), path.join(root, "AGENTS.md"));
  await symlink(path.join(root, "real.md"), path.join(root, "CLAUDE.md"));
  await mkdir(path.join(root, ".saturn/skills/leak"), { recursive: true });
  await symlink(path.join(outside, "private.txt"), path.join(root, ".saturn/skills/leak/SKILL.md"));
  const { requests, url } = await model(() => "done");
  const connection = await api("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: url });
  const agent = await api("POST", "/agents", { name: "Reader", modelConnectionId: connection.id, autonomy: "bypass" });
  const project = await api("POST", "/projects", { path: root, grant: true });
  const instructions = await api("GET", `/projects/${project.id}/instructions`);
  assert.doesNotMatch(JSON.stringify(instructions), /project-outside-secret/, "not even in what the user is asked to allow");
  await api("POST", `/projects/${project.id}/instructions/approve`, { fingerprint: instructions.fingerprint });
  const created = await api("POST", `/agents/${agent.id}/runs`, { input: "go", projectId: project.id });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await api("GET", `/runs/${created.id}`)).status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const sent = JSON.stringify(requests[0].body.messages);
  assert.match(sent, /inside rule/, "a link that stays inside still works");
  assert.doesNotMatch(sent, /project-outside-secret/);
  await api("GET", `/skills/leak?projectId=${project.id}`, undefined, [404]);
  const rules = await api("GET", `/projects/${project.id}/rules`);
  assert.doesNotMatch(JSON.stringify(rules), /project-outside-secret/);
});
