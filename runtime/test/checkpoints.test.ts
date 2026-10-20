import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unifiedDiff } from "../src/domain/diff.js";
import { Workspace } from "../src/domain/skills/workspace.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { FileSkill } from "../src/infrastructure/skills/file-skill.js";
import { createApp } from "../src/presentation/app.js";
import { useRuntimeAuth } from "./runtime-token.js";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** A runtime with a granted project, a chat in it, and `runs` finished turns the test drives by hand. */
async function setup(turns = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-checkpoints-"));
  const folder = path.join(directory, "site");
  await mkdir(folder);
  const store = new FileStore(path.join(directory, "data"));
  await store.load();
  const { app, services } = createApp(store);
  const project = await services.createProject({ path: folder });
  await services.setProjectAccess(project.id, true);
  const now = new Date().toISOString();
  const threadId = "thr_review";
  const runIds = Array.from({ length: turns }, (_, index) => `run_${index + 1}`);
  await store.update((state) => {
    state.threads = [...(state.threads ?? []), { id: threadId, agentId: "agt_x", projectId: project.id, title: "Review", createdAt: now, updatedAt: now }];
    for (const id of runIds) {
      // Newest first, like startRun's unshift.
      state.runs.unshift({ id, agentId: "agt_x", threadId, input: id, status: "completed", output: "", actions: [], generation: 0 } as Run);
    }
  });
  const kernel = services.kernel;
  const workdir = kernel.projects.workdir(project.id);
  /** The files skill as it runs for that turn, with the turn's checkpoint. */
  const files = (runId: string) => new FileSkill(new Workspace(workdir), kernel.checkpoints.forRun(runId, workdir));
  return { directory, folder, store, app, services, kernel, runIds, files };
}

test("the first write in a run keeps the original bytes and records before and after hashes", async () => {
  const { directory, folder, kernel, files } = await setup();
  const original = Buffer.from("line one\r\nline two\r\nno newline: café", "utf8");
  await writeFile(path.join(folder, "notes.md"), original);

  await files("run_1").run({ action: "write", path: "notes.md", content: "first edit\n" });
  await files("run_1").run({ action: "write", path: "notes.md", content: "second edit\n" });

  const change = kernel.getRun("run_1").checkpoint?.files;
  assert.deepEqual(change, [{ path: "notes.md", before: sha(original), after: sha("second edit\n") }], "one entry, the first original kept");
  const saved = await readFile(path.join(directory, "data", "checkpoints", "run_1", sha(original)));
  assert.ok(saved.equals(original), "the original is stored under the data dir by run id");
  // The project folder has no Saturn files in it, and no git state was created.
  await assert.rejects(() => stat(path.join(folder, ".git")));
});

test("changes list each file with a unified diff and +/- counts", async () => {
  const { folder, services, app, files } = await setup();
  await writeFile(path.join(folder, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await files("run_1").run({ action: "write", path: "app.ts", content: "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n" });
  await files("run_1").run({ action: "write", path: "src/new.ts", content: "export {};\n" });
  // Written back unchanged: not a change.
  await writeFile(path.join(folder, "same.txt"), "same\n");
  await files("run_1").run({ action: "write", path: "same.txt", content: "same\n" });

  const changes = await services.runChanges("run_1");
  assert.deepEqual(changes.files.map((item) => [item.path, item.status, item.additions, item.deletions]), [
    ["app.ts", "modified", 2, 1],
    ["src/new.ts", "added", 1, 0],
  ]);
  assert.equal(
    changes.files[0].diff,
    "--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 20;\n const c = 3;\n+const d = 4;\n",
  );
  assert.equal(changes.files[1].diff, "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export {};\n");
  assert.equal(changes.files[0].review, "pending");
  assert.equal(changes.files[0].modifiedSince, false);

  // The same list over HTTP.
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    useRuntimeAuth(`http://127.0.0.1:${address.port}`);
    const body = (await (await fetch(`http://127.0.0.1:${address.port}/runs/run_1/changes`)).json()) as { files: { path: string }[] };
    assert.deepEqual(body.files.map((item) => item.path), ["app.ts", "src/new.ts"]);
  } finally {
    server.close();
  }
});

test("a long file diffs only the edited region", () => {
  const before = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n") + "\n";
  const after = before.replace("line 250\n", "line 250 changed\n").replace("line 10\n", "");
  const result = unifiedDiff("big.txt", Buffer.from(before), Buffer.from(after));
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 2);
  assert.equal((result.diff.match(/^@@/gm) ?? []).length, 2, "two separate hunks");
});

test("reverting one file restores its exact bytes and leaves the others", async () => {
  const { folder, services, files } = await setup();
  const original = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0d, 0x0a, 0x09, 0x20]);
  await writeFile(path.join(folder, "a.txt"), original);
  await writeFile(path.join(folder, "b.txt"), "b\n");
  await files("run_1").run({ action: "write", path: "a.txt", content: "changed a\n" });
  await files("run_1").run({ action: "write", path: "b.txt", content: "changed b\n" });

  const after = await services.revertRunChanges("run_1", "a.txt");
  assert.ok((await readFile(path.join(folder, "a.txt"))).equals(original), "byte for byte");
  assert.equal(await readFile(path.join(folder, "b.txt"), "utf8"), "changed b\n");
  assert.deepEqual(after.files.map((item) => [item.path, item.review]), [["a.txt", "reverted"], ["b.txt", "pending"]]);
  await assert.rejects(() => services.revertRunChanges("run_1", "other.txt"), /did not change that file/);
});

test("revert all restores modified and deleted files and deletes the ones the run created", async () => {
  const { folder, services, files } = await setup();
  await writeFile(path.join(folder, "keep.md"), "# Title\n");
  await writeFile(path.join(folder, "old.md"), "old\n");
  await writeFile(path.join(folder, "moved.md"), "move me\n");
  await files("run_1").run({ action: "write", path: "keep.md", content: "# New title\n" });
  await files("run_1").run({
    action: "patch",
    patch: [
      "*** Begin Patch",
      "*** Add File: docs/added.md",
      "+added",
      "*** Delete File: old.md",
      "*** Update File: moved.md",
      "*** Move to: renamed.md",
      "@@",
      "-move me",
      "+moved",
      "*** End Patch",
    ].join("\n"),
  });
  const before = await services.runChanges("run_1");
  assert.deepEqual(
    before.files.map((item) => [item.path, item.status]).sort(),
    [["docs/added.md", "added"], ["keep.md", "modified"], ["moved.md", "deleted"], ["old.md", "deleted"], ["renamed.md", "added"]],
  );

  const reverted = await services.revertRunChanges("run_1");
  assert.ok(reverted.files.every((item) => item.review === "reverted"));
  assert.equal(await readFile(path.join(folder, "keep.md"), "utf8"), "# Title\n");
  assert.equal(await readFile(path.join(folder, "old.md"), "utf8"), "old\n");
  assert.equal(await readFile(path.join(folder, "moved.md"), "utf8"), "move me\n");
  await assert.rejects(() => stat(path.join(folder, "docs", "added.md")), "the created file is gone");
  await assert.rejects(() => stat(path.join(folder, "renamed.md")));
});

test("keep marks the edits accepted without touching the files", async () => {
  const { folder, services, files } = await setup();
  await files("run_1").run({ action: "write", path: "x.txt", content: "x\n" });
  const kept = await services.keepRunChanges("run_1");
  assert.deepEqual(kept.files.map((item) => item.review), ["kept"]);
  assert.equal(await readFile(path.join(folder, "x.txt"), "utf8"), "x\n");
});

test("restore to before a turn reverts that run and every later run in the chat", async () => {
  const { folder, services, files, kernel } = await setup(3);
  await writeFile(path.join(folder, "a.txt"), "v0\n");
  await files("run_1").run({ action: "write", path: "a.txt", content: "v1\n" });
  await files("run_2").run({ action: "write", path: "a.txt", content: "v2\n" });
  await files("run_2").run({ action: "write", path: "created.txt", content: "made by turn 2\n" });
  await files("run_3").run({ action: "write", path: "a.txt", content: "v3\n" });
  await files("run_3").run({ action: "write", path: "created.txt", content: "edited by turn 3\n" });

  const result = await services.restoreToRun("run_2");
  assert.deepEqual(result.reverted, ["run_3", "run_2"], "newest first");
  assert.deepEqual(result.files.sort(), ["a.txt", "created.txt"]);
  assert.equal(await readFile(path.join(folder, "a.txt"), "utf8"), "v1\n", "back to how turn 2 found it");
  await assert.rejects(() => stat(path.join(folder, "created.txt")), "the file turn 2 created is deleted");
  assert.equal(kernel.getRun("run_1").checkpoint?.files[0].review, undefined, "earlier turns are untouched");
  assert.equal(kernel.getRun("run_3").input, "run_3", "messages stay");

  // Restoring to the first turn brings back the file as it was before the chat touched it.
  await services.restoreToRun("run_1");
  assert.equal(await readFile(path.join(folder, "a.txt"), "utf8"), "v0\n");
});

test("a running turn cannot be reverted, and writes outside the project are not tracked", async () => {
  const { directory, store, services, kernel } = await setup();
  await store.update((state) => {
    const run = state.runs.find((item) => item.id === "run_1");
    if (run) run.status = "running";
  });
  const checkpoint = kernel.checkpoints.forRun("run_1", (kernel.store.state.projects ?? [])[0]!.path);
  const outside = path.join(directory, "outside.txt");
  await checkpoint.before(outside);
  await writeFile(outside, "x");
  await checkpoint.after(outside);
  assert.equal(kernel.getRun("run_1").checkpoint, undefined);
  await assert.rejects(() => services.revertRunChanges("run_1"), /Wait for the run to finish/);
});

/** A model that edits notes.md once with the files skill, then answers. */
async function editingModel() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string }[] }).messages ?? [];
      const edited = messages.some((item) => item.role === "tool");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: edited
            ? { content: "done" }
            : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "files", arguments: JSON.stringify({ action: "write", path: "notes.md", content: "edited by the agent\n" }) } }] },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("an agent's edit in a granted project shows up as a diff and reverts to the exact bytes", async () => {
  const model = await editingModel();
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-checkpoints-run-"));
  const folder = path.join(directory, "site");
  await mkdir(folder);
  try {
    const original = Buffer.from("written by the user\n");
    await writeFile(path.join(folder, "notes.md"), original);
    const store = new FileStore(path.join(directory, "data"));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "Builder", modelConnectionId: connection.id, autonomy: "fully_autonomous" });
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);

    const run = await services.startRun(agent.id, "edit notes", undefined, project.id);
    for (let attempt = 0; attempt < 120 && ["running", "queued"].includes(services.kernel.getRun(run.id).status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(services.kernel.getRun(run.id).status, "completed", services.kernel.getRun(run.id).error);
    const changes = await services.runChanges(run.id);
    assert.equal(changes.files.length, 1);
    assert.match(changes.files[0].diff, /-written by the user\n\+edited by the agent\n/);

    await services.revertRunChanges(run.id);
    assert.ok((await readFile(path.join(folder, "notes.md"))).equals(original));

    // A chat outside any project keeps no checkpoint.
    const sandbox = await services.startRun(agent.id, "edit notes");
    for (let attempt = 0; attempt < 120 && ["running", "queued"].includes(services.kernel.getRun(sandbox.id).status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(services.kernel.getRun(sandbox.id).checkpoint, undefined);
  } finally {
    model.server.close();
  }
});

test("restoring to a step puts each file back to just before that step, and deletes what it or later steps created", async () => {
  const { folder, kernel, store } = await setup();
  const workdir = kernel.projects.workdir(kernel.store.state.projects![0]!.id);
  await writeFile(path.join(folder, "notes.md"), "original\n");
  const step = (actionId: string) => {
    const checkpoint = kernel.checkpoints.forRun("run_1", workdir);
    return new FileSkill(new Workspace(workdir), { before: (target) => checkpoint.before(target, actionId), after: (target) => checkpoint.after(target) });
  };
  await step("act_a").run({ action: "write", path: "notes.md", content: "v1\n" });
  await step("act_b").run({ action: "write", path: "notes.md", content: "v2\n" });
  await step("act_b").run({ action: "write", path: "src/new.ts", content: "export {};\n" });
  await step("act_c").run({ action: "write", path: "notes.md", content: "v3\n" });
  await store.update((state) => {
    state.runs.find((item) => item.id === "run_1")!.actions = ["act_a", "act_b", "act_c"].map((id) => ({ id, toolId: "files", arguments: {}, status: "completed" as const }));
  });

  const result = await kernel.checkpoints.restoreToStep("run_1", "act_b");
  assert.deepEqual(result.files.sort(), ["notes.md", "src/new.ts"]);
  assert.equal(await readFile(path.join(folder, "notes.md"), "utf8"), "v1\n", "act_a's edit stays; act_b's and act_c's are undone");
  await assert.rejects(() => stat(path.join(folder, "src", "new.ts")), "the file act_b created is gone");
  const entry = kernel.getRun("run_1").checkpoint!.files.find((item) => item.path === "notes.md")!;
  assert.deepEqual([entry.before, entry.after], [sha("original\n"), sha("v1\n")], "the run's change now ends at act_a's result");
  assert.deepEqual(kernel.getRun("run_1").checkpoint!.steps!.map((item) => item.actionId), ["act_a"]);
});
