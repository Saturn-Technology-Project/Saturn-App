import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NetworkLog } from "../src/infrastructure/network-log.js";

test("every request the process sends is recorded by host, without its query string, and appended to network.log", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(os.tmpdir(), "saturn-network-"));
  const log = new NetworkLog();
  log.start(dir);
  try {
    await (await fetch(`http://127.0.0.1:${port}/v1/models?key=SECRET`)).text();
    await new Promise<void>((resolve) => http.get(`http://127.0.0.1:${port}/health?token=SECRET`, (res) => { res.resume(); res.on("end", () => resolve()); }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const view = log.view();
    assert.deepEqual(view.recent.map((entry) => [entry.method, entry.path, entry.local]).reverse(), [["GET", "/v1/models", true], ["GET", "/health", true]]);
    assert.deepEqual(view.hosts.map((host) => [host.host, host.requests]), [[`127.0.0.1:${port}`, 2]]);
    const file = await readFile(path.join(dir, "network.log"), "utf8");
    assert.equal(file.trim().split("\n").length, 2);
    assert.ok(!file.includes("SECRET"), "query strings never reach the log");
  } finally {
    server.close();
  }
});
