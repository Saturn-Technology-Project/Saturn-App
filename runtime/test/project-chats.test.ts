import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A model that writes notes.md with the files skill once, then answers. */
async function writingModel() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const wrote = messages.some((item) => typeof item.content === "string" && item.content.includes("notes.md") && item.role !== "user");
      const system = messages.find((item) => item.role === "system")?.content ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: wrote
            ? { content: `done; ${system.match(/Working directory: (.*)/)?.[1] ?? "no project"}` }
            : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "files", arguments: JSON.stringify({ action: "write", path: "notes.md", content: "hello" }) } }] },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function finished(read: () => Run): Promise<Run> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = read();
    if (run.status !== "running" && run.status !== "queued") return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("run did not finish");
}

test("a project chat works in its folder, only after the user grants access", async () => {
  const model = await writingModel();
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-project-chat-"));
  const folder = path.join(directory, "site");
  await mkdir(folder);
  try {
    const store = new FileStore(path.join(directory, "data"));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "Builder", modelConnectionId: connection.id, autonomy: "fully_autonomous" });

    // Added without the grant (like the auto-created default project): chats there are refused.
    const project = await services.createProject({ path: folder });
    assert.equal(project.access, null);
    await assert.rejects(() => services.startRun(agent.id, "write notes", undefined, project.id), /doesn't have access/);

    await services.setProjectAccess(project.id, true);
    const run = await services.startRun(agent.id, "write notes", undefined, project.id);
    const thread = (await services.listThreads(agent.id)).find((item) => item.id === run.threadId);
    assert.equal(thread?.projectId, project.id, "the chat belongs to the project");
    const done = await finished(() => services.kernel.getRun(run.id));
    assert.equal(done.status, "completed", done.error);
    assert.equal(await readFile(path.join(folder, "notes.md"), "utf8"), "hello", "written in the project folder");
    assert.match(done.output, new RegExp(`done; ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the model is told its working directory");

    // A chat outside any project keeps the private sandbox.
    const sandboxRun = await services.startRun(agent.id, "write notes");
    await finished(() => services.kernel.getRun(sandboxRun.id));
    assert.ok(await stat(path.join(directory, "data", "workspace", "notes.md")));

    // Revoking access stops further runs; removing the project removes its chats, never its files.
    await services.setProjectAccess(project.id, false);
    await assert.rejects(() => services.startRun(agent.id, "again", run.threadId), /doesn't have access/);
    await services.deleteProject(project.id);
    assert.equal((await services.listThreads(agent.id)).some((item) => item.projectId === project.id), false);
    assert.equal(store.state.runs.some((item) => item.id === run.id), false);
    assert.equal(await readFile(path.join(folder, "notes.md"), "utf8"), "hello");
  } finally {
    model.server.close();
  }
});
