// Where the browser's screenshots and recordings may go, whatever name an agent gives them. Safari is a fake WebDriver
// server, so no browser starts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench } from "./files-support.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let saturn;
let driver;
let setup;
let workspace;

before(async () => {
  driver = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const route = (request.url ?? "").replace(/^\/session\/s1/, "");
      const value = request.url === "/session" ? { sessionId: "s1", capabilities: { browserName: "Safari" } } : route === "/screenshot" ? PNG.toString("base64") : route === "/url" ? "about:blank" : route === "/title" ? "Page" : null;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value }));
    });
  });
  await new Promise((resolve) => driver.listen(0, "127.0.0.1", resolve));
  saturn = await bench({ env: { SATURN_SAFARI_ENDPOINT: `http://127.0.0.1:${driver.address().port}` } });
  await saturn.api("PATCH", "/settings", { browser: "safari" });
  setup = await saturn.chat(undefined, { mcpConnectionIds: ["browser"] });
  workspace = path.join(saturn.runtime.dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
});
after(async () => {
  await saturn?.stop();
  driver?.closeAllConnections();
  driver?.close();
});

test("a screenshot is saved in the workspace, creating its folders", async () => {
  const run = await setup.turn([["browser_screenshot", { file: "shots/new/page.jpg" }]]);
  assert.equal(run.actions[0].status, "completed", run.actions[0].reason);
  assert.deepEqual([...await readFile(path.join(workspace, "shots/new/page.jpg"))], [...PNG]);
});

test("a screenshot is not saved anywhere else, also through links", { skip: process.platform === "win32" }, async () => {
  await symlink(os.tmpdir(), path.join(workspace, "linked"));
  await symlink(path.join(saturn.runtime.dataDir, "nowhere"), path.join(workspace, "dangling"));
  for (const file of ["../escaped.jpg", "/etc/page.jpg", "linked/saturn-contract-page.jpg", "dangling", "dangling/page.jpg", "."]) {
    const run = await setup.turn([["browser_screenshot", { file }]]);
    assert.equal(run.actions[0].status, "failed", file);
    assert.match(run.actions[0].reason, /only be saved in the workspace/, file);
  }
  assert.equal(existsSync(path.join(os.tmpdir(), "saturn-contract-page.jpg")), false);
  assert.equal(existsSync(path.join(saturn.runtime.dataDir, "nowhere")), false);
  assert.equal(existsSync(path.join(saturn.runtime.dataDir, "escaped.jpg")), false);
});

test("a recording's name is one folder under recordings, never a way out", async () => {
  const folderFor = async (name) => {
    const run = await setup.turn([["browser_record_start", name === undefined ? {} : { name }], ["browser_record_stop", {}]]);
    assert.equal(run.actions[0].status, "completed", run.actions[0].reason);
    const folder = run.actions[0].result.recording;
    assert.equal(path.dirname(folder), path.join(workspace, "recordings"), JSON.stringify(name));
    return path.basename(folder);
  };
  assert.equal(await folderFor("my demo!"), "my_demo_");
  assert.equal(await folderFor(".hidden"), "hidden");
  assert.equal(await folderFor("../up"), "_up");
  for (const name of ["..", "...", ".", "  ", undefined, 7]) assert.match(await folderFor(name), /^recording-/, JSON.stringify(name));
});
