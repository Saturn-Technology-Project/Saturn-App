import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-expect-error: the eval harness is plain JavaScript.
import { startRuntime } from "../../../scripts/eval/run.mjs";
import { Saturn, SaturnError, type RunAction } from "../src/index.ts";

/** A model that writes a file with the shell, then answers. */
async function scriptedModel() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const ran = messages.some((item) => item.role === "assistant" && item.content?.includes('"toolId"'));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: ran ? { content: "wrote it" } : { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo hello > note.txt" }) } }] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test("the SDK starts runs, follows their steps, answers approvals, and refuses plan models", { timeout: 120_000 }, async () => {
  const model = await scriptedModel();
  const runtime = await startRuntime();
  try {
    const connection = await runtime.api("POST", "/connections/models", { name: "Scripted", provider: "openai", baseUrl: model.url, secret: "k" });
    await runtime.api("POST", "/agents", { name: "Doer", modelConnectionId: connection.id, autonomy: "bypass" });
    await runtime.api("POST", "/agents", { name: "Careful", modelConnectionId: connection.id, autonomy: "review" });
    const plan = await runtime.api("POST", "/connections/models", { provider: "claude-code", model: "claude-sonnet-5-5" });
    await runtime.api("POST", "/agents", { name: "Planner", modelConnectionId: plan.id });
    const folder = mkdtempSync(path.join(os.tmpdir(), "saturn-sdk-project-"));
    writeFileSync(path.join(folder, "README.md"), "demo\n");
    execFileSync("git", ["init", "-q"], { cwd: folder });
    const project = await runtime.api("POST", "/projects", { path: folder, grant: true });
    await runtime.api("POST", `/projects/${project.id}/access`, { granted: true });

    const saturn = new Saturn({ baseUrl: runtime.base, token: runtime.token });
    assert.deepEqual((await saturn.agents()).map((agent) => agent.name).sort(), ["Careful", "Doer", "Planner"]);

    // One call: the run's steps as they happen, then the finished run, and the file it changed.
    const steps: RunAction[] = [];
    const done = await saturn.run("write a note", { agent: "Doer", project: folder, onStep: (action) => steps.push(action) });
    assert.equal(done.status, "completed");
    assert.equal(done.output, "wrote it");
    assert.deepEqual(steps.map((step) => step.toolId), ["code"]);
    assert.equal(readFileSync(path.join(folder, "note.txt"), "utf8"), "hello\n", "it ran in the project folder");
    assert.deepEqual((await saturn.changes(done.id)).files.map((file) => file.path), ["note.txt"]);
    assert.ok((await saturn.runs(5)).some((run) => run.id === done.id));

    // Without onApproval the run comes back waiting; deciding and waiting again finishes it.
    const waiting = await saturn.run("write a note", { agent: "Careful", project: folder });
    assert.equal(waiting.status, "waiting_approval");
    const pending = waiting.actions.find((action) => action.status === "waiting_approval")!;
    await saturn.decide(waiting.id, pending.id, true);
    assert.equal((await saturn.wait(waiting.id)).status, "completed");

    // With onApproval it is answered in the loop; a denial still ends the run.
    const asked: string[] = [];
    const denied = await saturn.run("write a note", { agent: "Careful", project: folder, onApproval: (action) => { asked.push(action.toolId); return false; } });
    assert.deepEqual(asked, ["code"]);
    assert.equal(denied.status, "completed");
    assert.equal(denied.actions[0]?.status, "denied");

    // What is refused, and how it says so.
    await assert.rejects(saturn.run("hi", { agent: "Planner" }), (error: Error) => error instanceof SaturnError && /personal plan/.test(error.message));
    await assert.rejects(saturn.run("hi"), /Name the agent/);
    await assert.rejects(saturn.run("hi", { agent: "Nobody" }), /No agent named "Nobody"/);
    await assert.rejects(saturn.run("hi", { agent: "Doer", project: os.tmpdir() }), /is not a Saturn project/);
    await assert.rejects(new Saturn({ baseUrl: runtime.base, token: "x".repeat(40) }).agents(), (error: Error) => error instanceof SaturnError && (error as SaturnError).status === 401);
    await assert.rejects(new Saturn({ baseUrl: "http://127.0.0.1:9", token: "t" }).agents(), /Saturn is not running/);
  } finally {
    await runtime.stop();
    model.server.close();
  }
});
