import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { toolSteps } from "./tool-steps.js";

const COMMAND = "printf 'v2\\n' > tracked.txt && printf 'more\\n' >> edited.txt && printf 'new\\n' > added.txt && rm gone.txt && mkdir -p build && printf 'x' > build/out.js";

let nextCall: Record<string, unknown> = { command: COMMAND };

async function shellModel() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const ran = toolSteps(messages).length > 0;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: ran ? { content: "done" } : { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "code", arguments: JSON.stringify(nextCall) } }] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

/** The scripted commands are POSIX shell; Windows runs the code tool's commands in PowerShell. */
const posixOnly = { skip: process.platform === "win32" && "the scripted commands are POSIX shell" };

test("files a shell command changes in a git project join the run's changes, and revert undoes them", posixOnly, async () => {
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

async function setUp(folder: string) {
  const model = await shellModel();
  const store = new FileStore(mkdtempSync(path.join(os.tmpdir(), "saturn-shell-changes-data-")));
  await store.load();
  const { services } = createApp(store);
  const connection = await services.createModel({ name: "M", provider: "openai", baseUrl: model.url });
  const agent = await services.createAgent({ name: "A", modelConnectionId: connection.id, autonomy: "bypass" });
  const project = await services.createProject({ path: folder });
  await services.setProjectAccess(project.id, true);
  const thread = await services.kernel.runs.createThread(agent.id, "Shell", project.id);
  const run = async (input: string) => {
    const started = await services.kernel.runs.startRun(agent.id, input, thread.id);
    for (let i = 0; i < 400 && store.state.runs.find((item) => item.id === started.id)?.status !== "completed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    return started.id;
  };
  return { model, services, run };
}

test("outside git, a private snapshot of the folder tracks the same changes, and revert undoes them", posixOnly, async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "saturn-shell-nogit-"));
  writeFileSync(path.join(folder, "tracked.txt"), "v1\n");
  writeFileSync(path.join(folder, "edited.txt"), "base\nmine\n");
  writeFileSync(path.join(folder, "gone.txt"), "bye\n");
  nextCall = { command: COMMAND };
  const { model, services, run } = await setUp(folder);
  try {
    const id = await run("change things");
    const changes = await services.kernel.checkpoints.changes(id);
    assert.deepEqual(Object.fromEntries(changes.files.map((file) => [file.path, file.status])), { "added.txt": "added", "edited.txt": "modified", "gone.txt": "deleted", "tracked.txt": "modified" }, "build/ is left out by default");
    assert.equal(existsSync(path.join(folder, ".git")), false, "nothing is written into the folder");
    // Settings → Storage lists the snapshot with its folder and size; deleting it keeps the run revertible.
    const listed = await services.kernel.checkpoints.snapshotFolders();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.folder, folder);
    assert.ok(listed[0]!.bytes > 0);
    await services.kernel.checkpoints.deleteSnapshotFolders(listed[0]!.id);
    assert.deepEqual(await services.kernel.checkpoints.snapshotFolders(), []);
    await assert.rejects(services.kernel.checkpoints.deleteSnapshotFolders("../../etc"), /No such snapshot folder/);
    await services.kernel.checkpoints.revert(id);
    assert.equal(readFileSync(path.join(folder, "tracked.txt"), "utf8"), "v1\n");
    assert.equal(readFileSync(path.join(folder, "edited.txt"), "utf8"), "base\nmine\n");
    assert.equal(readFileSync(path.join(folder, "gone.txt"), "utf8"), "bye\n");
    assert.equal(existsSync(path.join(folder, "added.txt")), false);
  } finally {
    model.server.close();
  }
});

test("a background command's changes are recorded under the step that started it, once it ends", posixOnly, async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "saturn-shell-bg-"));
  git(folder, "init", "-q");
  writeFileSync(path.join(folder, "server.log.txt"), "start\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "init");
  nextCall = { command: "sleep 0.5 && printf 'later\\n' > made-later.txt && printf 'more\\n' >> server.log.txt", background: true };
  const { model, services, run } = await setUp(folder);
  try {
    const id = await run("start it");
    const action = services.kernel.getRun(id).actions[0]!;
    assert.equal(action.status, "completed");
    for (let i = 0; i < 100 && !existsSync(path.join(folder, "made-later.txt")); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    let paths: string[] = [];
    for (let i = 0; i < 100 && paths.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      paths = (await services.kernel.checkpoints.changes(id)).files.map((file) => file.path).sort();
    }
    assert.deepEqual(paths, ["made-later.txt", "server.log.txt"]);
    assert.ok(services.kernel.getRun(id).checkpoint?.steps?.every((step) => step.actionId === action.id));
    await services.kernel.checkpoints.revert(id);
    assert.equal(readFileSync(path.join(folder, "server.log.txt"), "utf8"), "start\n");
    assert.equal(existsSync(path.join(folder, "made-later.txt")), false);
  } finally {
    model.server.close();
  }
});
