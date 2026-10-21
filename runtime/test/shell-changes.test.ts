import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

const COMMAND = "printf 'v2\\n' > tracked.txt && printf 'more\\n' >> edited.txt && printf 'new\\n' > added.txt && rm gone.txt && mkdir -p build && printf 'x' > build/out.js";

async function shellModel() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const ran = messages.some((item) => item.role === "assistant" && item.content?.includes('"toolId"'));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: ran ? { content: "done" } : { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "code", arguments: JSON.stringify({ command: COMMAND }) } }] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("files a shell command changes in a git project join the run's changes, and revert undoes them", async () => {
  const model = await shellModel();
  try {
    const folder = mkdtempSync(path.join(os.tmpdir(), "saturn-shell-changes-"));
    git(folder, "init", "-q");
    writeFileSync(path.join(folder, "tracked.txt"), "v1\n");
    writeFileSync(path.join(folder, "edited.txt"), "base\n");
    writeFileSync(path.join(folder, "gone.txt"), "bye\n");
    writeFileSync(path.join(folder, ".gitignore"), "build/\n");
    git(folder, "add", ".");
    git(folder, "commit", "-q", "-m", "init");
    // A change of the user's own, before the run: the run's revert must bring back this, not git's version.
    writeFileSync(path.join(folder, "edited.txt"), "base\nmine\n");

    const store = new FileStore(mkdtempSync(path.join(os.tmpdir(), "saturn-shell-changes-data-")));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "M", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "A", modelConnectionId: connection.id, autonomy: "bypass" });
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const thread = await services.kernel.runs.createThread(agent.id, "Shell", project.id);
    const run = await services.kernel.runs.startRun(agent.id, "change things", thread.id);
    for (let i = 0; i < 400 && store.state.runs.find((item) => item.id === run.id)?.status !== "completed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(store.state.runs.find((item) => item.id === run.id)?.actions[0]?.status, "completed");

    const changes = await services.kernel.checkpoints.changes(run.id);
    const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file.status]));
    assert.deepEqual(byPath, { "added.txt": "added", "edited.txt": "modified", "gone.txt": "deleted", "tracked.txt": "modified" }, "ignored build output is left out");
    assert.match(changes.files.find((file) => file.path === "tracked.txt")!.diff, /-v1\n\+v2/);
    assert.match(changes.files.find((file) => file.path === "edited.txt")!.diff, /\+more/);

    await services.kernel.checkpoints.revert(run.id);
    assert.equal(readFileSync(path.join(folder, "tracked.txt"), "utf8"), "v1\n");
    assert.equal(readFileSync(path.join(folder, "edited.txt"), "utf8"), "base\nmine\n", "the user's own edit survives the revert");
    assert.equal(readFileSync(path.join(folder, "gone.txt"), "utf8"), "bye\n");
    assert.equal(existsSync(path.join(folder, "added.txt")), false);
  } finally {
    model.server.close();
  }
});
