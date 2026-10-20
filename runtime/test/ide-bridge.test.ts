import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { useRuntimeAuth } from "./runtime-token.js";

/** A stand-in Saturn IDE window: opens the request stream for `folder` and answers each request with `answer`. */
async function fakeIde(base: string, id: string, folder: string, answer: (request: { tool: string; args: Record<string, unknown> }) => unknown) {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const stop = new AbortController();
  const response = await fetch(`${base}/runtime/clients/${id}/requests?folder=${encodeURIComponent(folder)}`, { signal: stop.signal });
  assert.equal(response.status, 200);
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!event.startsWith("data: ")) continue;
          const request = JSON.parse(event.slice(6)) as { id: string; tool: string; args: Record<string, unknown> };
          seen.push(request);
          await fetch(`${base}/runtime/clients/${id}/responses/${request.id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ result: answer(request) }),
          });
        }
      }
    } catch {
      // Closed by the test.
    }
  })();
  return { seen, close: () => stop.abort() };
}

async function model(answer: (body: Record<string, unknown>) => unknown) {
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

test("editor tools are offered only while Saturn IDE has the project open, and run in that window", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "saturn-ide-project-"));
  await writeFile(path.join(folder, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  await writeFile(path.join(folder, "use.ts"), "import { add } from './math';\nadd(1, 2);\n");
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-ide-data-")));
  await store.load();
  const { app, services } = createApp(store);
  const listening = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listening.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
  useRuntimeAuth(base);
  // The model asks for diagnostics, then a rename, then answers.
  let step = 0;
  const llm = await model(() => {
    step += 1;
    const call = (name: string, args: object) => ({ choices: [{ message: { content: "", tool_calls: [{ id: `c${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    if (step === 1) return call("ide_diagnostics", { path: "math.ts" });
    if (step === 2) return call("ide_rename", { path: "math.ts", symbol: "add", newName: "sum" });
    return { choices: [{ message: { content: "done" } }] };
  });
  const ide = await fakeIde(base, "ide:test", folder, (request) => {
    if (request.tool === "ide_diagnostics") return [{ path: request.args.path, line: 1, severity: "error", message: "Unused export" }];
    if (request.tool === "ide_rename") {
      return { files: [
        { path: path.join(folder, "math.ts"), content: "export function sum(a: number, b: number) { return a + b; }\n" },
        { path: path.join(folder, "use.ts"), content: "import { sum } from './math';\nsum(1, 2);\n" },
      ] };
    }
    return null;
  });
  try {
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const connection = await services.createModel({ name: "Local", provider: "openai", model: "local", baseUrl: llm.url });
    const agent = await services.createAgent({ name: "Editor", modelConnectionId: connection.id, autonomy: "fully_autonomous" });
    assert.ok(agent.mcpConnectionIds.includes("ide"), "new agents get the editor tools");
    const run = await services.startRun(agent.id, "rename add to sum", undefined, project.id);
    for (let attempt = 0; attempt < 200 && !["completed", "failed"].includes(services.kernel.getRun(run.id).status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = services.kernel.getRun(run.id);
    assert.equal(done.status, "completed", done.actions.map((item) => `${item.toolId}: ${item.reason ?? ""}`).join("; "));
    const offered = (llm.bodies[0]!.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.ok(offered.includes("ide_references") && offered.includes("ide_rename"));
    assert.deepEqual(ide.seen.map((item) => item.tool), ["ide_diagnostics", "ide_rename"]);
    assert.equal(ide.seen[0]!.args.path, path.join(folder, "math.ts"), "the IDE gets an absolute path inside the project");
    assert.deepEqual(done.actions[0]!.result, [{ path: "math.ts", line: 1, severity: "error", message: "Unused export" }], "paths come back relative");
    assert.equal(await readFile(path.join(folder, "use.ts"), "utf8"), "import { sum } from './math';\nsum(1, 2);\n", "the rename was written");
    assert.deepEqual(done.checkpoint?.files.map((item) => item.path).sort(), ["math.ts", "use.ts"], "and can be reviewed and reverted");

    ide.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(services.kernel.ide.available(folder), false, "a closed window no longer counts");
    const later = await services.startRun(agent.id, "again", done.threadId);
    for (let attempt = 0; attempt < 200 && !["completed", "failed"].includes(services.kernel.getRun(later.id).status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const offeredLater = (llm.bodies.at(-1)!.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.ok(!offeredLater.some((name) => name.startsWith("ide_")), "without the IDE the tools are not offered");
  } finally {
    ide.close();
    llm.server.close();
    await new Promise((resolve) => listening.close(() => resolve(undefined)));
  }
});
