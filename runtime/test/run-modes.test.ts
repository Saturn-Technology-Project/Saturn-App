import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_IMAGES, parseImages } from "../src/application/run-images.js";
import { isReadOnlyCall } from "../src/domain/policies.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

// A 1×1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function recorder(answer: (body: Record<string, unknown>) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, bodies, url: `http://127.0.0.1:${address.port}` };
}

async function settle(services: ReturnType<typeof createApp>["services"], runId: string) {
  for (let attempt = 0; attempt < 200 && !["completed", "failed"].includes(services.kernel.getRun(runId).status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return services.kernel.getRun(runId);
}

test("attached images are checked: data URLs or parts, known types only, a size and count limit", () => {
  assert.deepEqual(parseImages([`data:image/png;base64,${PNG}`, { mimeType: "image/jpeg", base64: PNG }]).map((item) => item.mimeType), ["image/png", "image/jpeg"]);
  assert.deepEqual(parseImages(undefined), []);
  assert.throws(() => parseImages([`data:image/svg+xml;base64,${PNG}`]), /PNG, JPEG, WebP or GIF/);
  assert.throws(() => parseImages(["not an image"]), /not a base64 image/);
  assert.throws(() => parseImages(Array.from({ length: MAX_IMAGES + 1 }, () => `data:image/png;base64,${PNG}`)), /at most/);
  assert.throws(() => parseImages([{ mimeType: "image/png", base64: "A".repeat(8 * 1024 * 1024) }]), /larger than/);
});

test("a tool call is read-only by its declared category, the files action, or a reading name", () => {
  const cases: [string, Record<string, unknown>, "read" | "write" | undefined, boolean][] = [
    ["files", { action: "read" }, undefined, true],
    ["files", { action: "write" }, undefined, false],
    ["code", { command: "ls" }, undefined, false],
    ["web", {}, undefined, true],
    ["get_file_contents", {}, undefined, true],
    ["create_pull_request", {}, undefined, false],
    ["browser_click", {}, "write", false],
    ["browser_navigate", {}, "read", true],
  ];
  assert.deepEqual(cases.map(([tool, args, category]) => isReadOnlyCall(tool, args, category)), cases.map(([, , , expected]) => expected));
});

test("a message's images reach the model with it, are kept on disk, and later turns only mention them", async () => {
  const fake = await recorder(() => ({ choices: [{ message: { content: "a red square" } }] }));
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-images-")));
    await store.load();
    const { services } = createApp(store);
    const model = await services.createModel({ name: "Vision", provider: "openai", model: "local", baseUrl: fake.url });
    const agent = await services.createAgent({ name: "Looker", modelConnectionId: model.id, autonomy: "fully_autonomous" });
    const first = await services.startRun(agent.id, "what is this?", undefined, undefined, { images: parseImages([`data:image/png;base64,${PNG}`]) });
    assert.equal((await settle(services, first.id)).status, "completed");
    const user = (fake.bodies[0]!.messages as { role: string; content: unknown }[]).at(-1)!;
    assert.ok(Array.isArray(user.content), "the user turn is multimodal");
    assert.ok(JSON.stringify(user.content).includes(PNG), "the image's bytes went to the model");
    assert.deepEqual(await readdir(path.join(store.root, "run-images", first.id)), ["1.png"]);

    const second = await services.startRun(agent.id, "and now?", services.kernel.getRun(first.id).threadId);
    await settle(services, second.id);
    const history = JSON.stringify(fake.bodies[1]!.messages);
    assert.ok(!history.includes(PNG), "an earlier image is not sent again");
    assert.ok(history.includes("1 image was attached"), "the earlier turn says it had an image");
  } finally {
    fake.server.close();
  }
});

test("a model that cannot see refuses images up front", async () => {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-noimages-")));
  await store.load();
  const { services } = createApp(store);
  const model = await services.createModel({ name: "DS", provider: "deepseek", model: "deepseek-chat", secret: "test" });
  const agent = await services.createAgent({ name: "Blind", modelConnectionId: model.id });
  await assert.rejects(services.startRun(agent.id, "look", undefined, undefined, { images: parseImages([`data:image/png;base64,${PNG}`]) }), /cannot take images/);
});

test("an Ask turn is offered only reading tools, is told so, and a write it tries anyway is refused", async () => {
  const fake = await recorder((body) => {
    const messages = body.messages as { role: string; content?: string }[];
    const tried = messages.some((item) => item.role === "assistant" && String(item.content ?? "").includes("\"toolId\""));
    return {
      choices: [{
        message: tried
          ? { content: "It prints hi." }
          : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo hi > out.txt" }) } }] },
      }],
    };
  });
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-ask-")));
    await store.load();
    const { services } = createApp(store);
    const model = await services.createModel({ name: "Local", provider: "openai", model: "local", baseUrl: fake.url });
    const agent = await services.createAgent({ name: "Asker", modelConnectionId: model.id, autonomy: "fully_autonomous" });
    const run = await services.startRun(agent.id, "what does the script print?", undefined, undefined, { mode: "ask" });
    const done = await settle(services, run.id);
    assert.equal(done.status, "completed", "a refused write is expected in Ask mode, not a failure");
    const offered = (fake.bodies[0]!.tools as { function: { name: string } }[] | undefined ?? []).map((tool) => tool.function.name);
    assert.ok(offered.includes("files") && !offered.includes("code"), `offered: ${offered.join(", ")}`);
    assert.ok(String((fake.bodies[0]!.messages as { content: string }[])[0]!.content).includes("Ask mode"));
    assert.deepEqual(done.actions.map((action) => [action.toolId, action.status]), [["code", "denied"]]);
    assert.match(done.actions[0]!.reason ?? "", /Switch to Agent mode/);
  } finally {
    fake.server.close();
  }
});

test("a project's rule files reach the agent's prompt in order, within a budget, minus what the agent reads itself", async () => {
  const { projectRules, RULES_BUDGET } = await import("../src/application/rules.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const folder = await mkdtemp(path.join(os.tmpdir(), "saturn-rules-"));
  await writeFile(path.join(folder, "AGENTS.md"), "Use pnpm.");
  await mkdir(path.join(folder, ".saturn", "rules"), { recursive: true });
  await writeFile(path.join(folder, ".saturn", "rules", "b-style.md"), "Tabs, not spaces.");
  await writeFile(path.join(folder, ".saturn", "rules", "a-tests.md"), "Every fix gets a test.");
  await writeFile(path.join(folder, ".cursorrules"), "x".repeat(RULES_BUDGET * 2));
  const all = await projectRules(folder, "Reply in Chinese.");
  assert.deepEqual(all.sources.map((item) => item.path), ["AGENTS.md", ".saturn/rules/a-tests.md", ".saturn/rules/b-style.md", ".cursorrules", "Saturn project settings"]);
  assert.ok(all.text.length < RULES_BUDGET + 500, "the long file is clipped to the budget");
  assert.ok(!(await projectRules(folder, "", ["AGENTS.md"])).text.includes("pnpm"), "Codex's own AGENTS.md is skipped");

  const fake = await recorder(() => ({ choices: [{ message: { content: "ok" } }] }));
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-rules-data-")));
    await store.load();
    const { services } = createApp(store);
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const model = await services.createModel({ name: "Local", provider: "openai", model: "local", baseUrl: fake.url });
    const agent = await services.createAgent({ name: "Ruled", modelConnectionId: model.id });
    const run = await services.startRun(agent.id, "hi", undefined, project.id);
    await settle(services, run.id);
    const system = String((fake.bodies[0]!.messages as { content: string }[])[0]!.content);
    assert.ok(system.includes("# Project rules") && system.includes("Use pnpm.") && system.includes("Every fix gets a test."));
  } finally {
    fake.server.close();
  }
});

test("GET /runs lists the runs still going first, then the latest finished, per project", async () => {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-recent-")));
  await store.load();
  const { services } = createApp(store);
  const now = new Date().toISOString();
  await store.update((state) => {
    state.agents.push({ id: "agt_r", name: "Runner", modelConnectionId: "", mcpConnectionIds: [], ragConnectionIds: [], instructions: "" } as never);
    state.threads = [
      { id: "thr_a", agentId: "agt_r", projectId: "proj_a", title: "In A", createdAt: now, updatedAt: now, worktree: { branch: "saturn/abc", base: "main" } },
      { id: "thr_b", agentId: "agt_r", projectId: "proj_b", title: "In B", createdAt: now, updatedAt: now },
    ];
    // Newest first, as startRun keeps them.
    state.runs.unshift(
      { id: "run_live", agentId: "agt_r", threadId: "thr_a", input: "live", status: "waiting_approval", output: "", actions: [], generation: 0 },
      { id: "run_b", agentId: "agt_r", threadId: "thr_b", input: "b", status: "completed", output: "", actions: [], generation: 0 },
      { id: "run_old", agentId: "agt_r", threadId: "thr_a", input: "old\n<saturn_context sources=\"x\">hidden</saturn_context>", status: "completed", output: "", actions: [], generation: 0 },
    );
  });
  const all = services.recentRuns();
  assert.deepEqual(all.map((run) => run.id), ["run_live", "run_b", "run_old"]);
  const inA = services.recentRuns("proj_a");
  assert.deepEqual(inA.map((run) => [run.id, run.branch, run.input]), [["run_live", "saturn/abc", "live"], ["run_old", "saturn/abc", "old"]]);
});
