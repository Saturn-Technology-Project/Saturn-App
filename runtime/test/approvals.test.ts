import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseNextEdit } from "../src/application/completions.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A model that asks to delete a folder (a sensitive command), then answers once it sees the tool result. */
async function deletingModel() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const sawResult = messages.some((item) => item.role === "assistant" && typeof item.content === "string" && item.content.includes("\"toolId\""));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: sawResult
            ? { content: "finished" }
            : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "rm -rf scratch" }) } }] },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function until(read: () => Run, done: (run: Run) => boolean): Promise<Run> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = read();
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run stuck at ${read().status}`);
}

test("a local agent's approval card can be approved or denied, and the run continues", async () => {
  const model = await deletingModel();
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-approvals-"));
  try {
    const store = new FileStore(directory);
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "Cleaner", modelConnectionId: connection.id, autonomy: "default" });
    const sandbox = path.join(directory, "workspace", "scratch");

    // Approve: the command runs and the model finishes the turn.
    await mkdir(sandbox, { recursive: true });
    const approved = await services.startRun(agent.id, "clean up");
    const waiting = await until(() => services.kernel.getRun(approved.id), (run) => run.status === "waiting_approval");
    const card = waiting.actions.find((item) => item.status === "waiting_approval");
    assert.ok(card, "the sensitive command waits for the user");
    await services.kernel.runs.decide(approved.id, card.id, true);
    const done = await until(() => services.kernel.getRun(approved.id), (run) => run.status !== "running" && run.status !== "waiting_approval");
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.output, "finished");
    assert.equal(done.actions.find((item) => item.toolId === "code")?.status, "completed");
    await assert.rejects(() => stat(sandbox), "the approved command ran");

    // Deny: the command is skipped, the model is told, and the run is not counted as failed.
    await mkdir(sandbox, { recursive: true });
    const denied = await services.startRun(agent.id, "clean up again");
    const waitingAgain = await until(() => services.kernel.getRun(denied.id), (run) => run.status === "waiting_approval");
    const cardAgain = waitingAgain.actions.find((item) => item.status === "waiting_approval")!;
    await services.kernel.runs.decide(denied.id, cardAgain.id, false);
    const after = await until(() => services.kernel.getRun(denied.id), (run) => run.status !== "running" && run.status !== "waiting_approval");
    assert.equal(after.status, "completed");
    assert.equal(after.actions.find((item) => item.toolId === "code")?.status, "denied");
    assert.ok(await stat(sandbox), "the denied command did not run");

    // A card that is no longer waiting cannot be answered twice.
    await assert.rejects(() => services.kernel.runs.decide(denied.id, cardAgain.id, true), /no longer waiting/);
  } finally {
    model.server.close();
  }
});

test("next-edit answers are parsed strictly", () => {
  assert.deepEqual(parseNextEdit('{"line": 12, "find": "oldName", "replace": "newName"}'), { line: 12, find: "oldName", replace: "newName" });
  assert.deepEqual(parseNextEdit('```json\n{"line": 3, "find": "a", "replace": "b"}\n```'), { line: 3, find: "a", replace: "b" });
  assert.deepEqual(parseNextEdit("{}"), {});
  assert.deepEqual(parseNextEdit("no edit"), {});
  assert.deepEqual(parseNextEdit('{"line": 0, "find": "a", "replace": "b"}'), {});
  assert.deepEqual(parseNextEdit('{"line": 4, "find": "same", "replace": "same"}'), {});
});
