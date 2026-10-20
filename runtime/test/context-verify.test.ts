import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

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
  return { server, bodies, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function settle(services: ReturnType<typeof createApp>["services"], runId: string) {
  for (let attempt = 0; attempt < 300 && !["completed", "failed"].includes(services.kernel.getRun(runId).status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return services.kernel.getRun(runId);
}

async function project() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "saturn-context-project-"));
  execFileSync("git", ["init", "-q", folder]);
  await mkdir(path.join(folder, "src"));
  await writeFile(path.join(folder, "src", "add.ts"), "export const add = (a: number, b: number) => a + b;\n");
  await writeFile(path.join(folder, "README.md"), "# Demo\n");
  execFileSync("git", ["-C", folder, "add", "-A"]);
  execFileSync("git", ["-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  await writeFile(path.join(folder, "README.md"), "# Demo\nchanged\n");
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-context-data-")));
  await store.load();
  const { services } = createApp(store);
  const created = await services.createProject({ path: folder });
  await services.setProjectAccess(created.id, true);
  return { folder, store, services, id: created.id };
}

test("@ attachments expand to the file, folder listing, git changes and terminal history; paths stay in the project", async () => {
  const { folder, services, id } = await project();
  const { text, sources } = await services.kernel.context.expand(id, [
    { kind: "file", path: "src/add.ts" },
    { kind: "folder", path: "." },
    { kind: "git" },
    { kind: "file", path: "../outside.txt" },
    { kind: "terminal" },
  ]);
  assert.match(text, /<file path="src\/add.ts">\nexport const add/);
  assert.match(text, /<folder path=".">\n(README.md\nsrc\/add.ts|src\/add.ts\nREADME.md)\n<\/folder>/);
  assert.match(text, /<git_changes>\n M README.md[\s\S]*\+changed/);
  assert.match(text, /<error item="file">\.\.\/outside.txt is outside the project folder<\/error>/);
  assert.match(text, /<terminal>\nNo commands have run/);
  assert.deepEqual(sources, ["src/add.ts", "./", "git changes", "terminal"]);
  assert.deepEqual(await services.kernel.context.files(id, "add"), ["src/add.ts"]);
  assert.equal((await services.kernel.context.files(id, "")).length, 2);
  void folder;
});

test("after a turn changes files, the project's check command runs; a failure goes back to the agent at most twice", async () => {
  const { folder, services, id } = await project();
  // Every turn writes a file (so every verification runs again) and then answers.
  const fake = await recorder((body) => {
    const messages = body.messages as { role: string; content?: string }[];
    const wrote = messages.some((item) => item.role === "assistant" && String(item.content ?? "").includes("\"toolId\""));
    return {
      choices: [{
        message: wrote
          ? { content: "done" }
          : { content: "", tool_calls: [{ id: "w", type: "function", function: { name: "files", arguments: JSON.stringify({ action: "write", path: "src/new.ts", content: `// ${Date.now()}\n` }) } }] },
      }],
    };
  });
  try {
    const model = await services.createModel({ name: "Local", provider: "openai", model: "local", baseUrl: fake.url });
    const agent = await services.createAgent({ name: "Fixer", modelConnectionId: model.id, autonomy: "fully_autonomous" });
    await services.updateProject(id, { verifyCommand: "echo 'src/new.ts: type error' && exit 1" });
    const run = await services.startRun(agent.id, "add a file", undefined, id);
    const first = await settle(services, run.id);
    assert.equal(first.status, "completed", first.error);
    // The automatic rounds follow on their own; wait for the chat to go quiet.
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const turns = services.kernel.store.state.runs.filter((item) => item.threadId === first.threadId);
      if (turns.length === 3 && turns.every((item) => item.status === "completed" && item.verification)) break;
    }
    const turns = services.kernel.store.state.runs.filter((item) => item.threadId === first.threadId).reverse();
    assert.deepEqual(turns.map((item) => [Boolean(item.automatic), item.verification?.ok]), [[false, false], [true, false], [true, false]], "one user turn, then two automatic rounds, then it stops");
    assert.match(turns[1]!.input, /`echo 'src\/new.ts: type error' && exit 1` failed \(exit 1\)[\s\S]*src\/new.ts: type error[\s\S]*Fix these, then check again\./);

    // A passing command: recorded, no follow-up.
    await services.updateProject(id, { verifyCommand: "true" });
    const again = await services.startRun(agent.id, "add another file", first.threadId);
    const done = await settle(services, again.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(services.kernel.getRun(done.id).verification?.ok, true);
    assert.equal(services.kernel.store.state.runs.filter((item) => item.threadId === first.threadId).length, 4, "no automatic round after a pass");
  } finally {
    fake.server.close();
  }
  void folder;
});

test("verification is off without a check command, and \"auto\" picks package.json's typecheck script", async () => {
  const { folder, services, id } = await project();
  assert.equal(await services.kernel.verify.commandFor(id, folder), undefined);
  await services.updateProject(id, { verifyCommand: "auto" });
  assert.equal(await services.kernel.verify.commandFor(id, folder), undefined, "no package.json: nothing to run");
  await writeFile(path.join(folder, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit" } }));
  assert.equal(await services.kernel.verify.commandFor(id, folder), "npm run typecheck");
});
