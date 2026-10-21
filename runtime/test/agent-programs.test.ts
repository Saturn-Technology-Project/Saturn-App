import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_PROGRAM_PACKAGES } from "../src/infrastructure/agent-programs-manifest.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

test("the download manifest pins exactly the lock file's packages (rerun scripts/agent-programs-manifest.mjs after an SDK update)", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8")).packages as Record<string, { version: string; resolved: string; integrity: string }>;
  const names = { "claude-code": "@anthropic-ai/claude-agent-sdk", codex: "@openai/codex" } as const;
  for (const [program, platforms] of Object.entries(AGENT_PROGRAM_PACKAGES)) {
    assert.ok(platforms["darwin-arm64"] && platforms["win32-x64"], `${program} covers the platforms Saturn ships`);
    for (const [platform, item] of Object.entries(platforms)) {
      const entry = lock[`node_modules/${names[program as keyof typeof names]}-${platform}`];
      assert.ok(entry, `${program} ${platform} is in the lock file`);
      assert.equal(item.url, entry.resolved);
      assert.equal(item.integrity, entry.integrity);
      assert.ok(item.url.startsWith("https://registry.npmjs.org/"));
    }
  }
});

/** A platform package as npm packs it: package/claude, a script standing in for the program. */
async function fakePackage(dir: string): Promise<{ archive: Buffer; integrity: string }> {
  const root = path.join(dir, "build");
  await mkdir(path.join(root, "package"), { recursive: true });
  const program = process.platform === "win32" ? "claude.exe" : "claude";
  await writeFile(path.join(root, "package", program), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
  await writeFile(path.join(root, "package", "package.json"), '{"name":"fake"}');
  const file = path.join(dir, "fake.tgz");
  execFileSync("tar", ["-czf", file, "-C", root, "package"]);
  const archive = await readFile(file);
  return { archive, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` };
}

async function serve(body: Buffer): Promise<{ url: string; close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}/fake.tgz`, close: () => server.close() };
}

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-programs-"));
  const store = new FileStore(directory);
  await store.load();
  return { directory, ...createApp(store) };
}

async function until(check: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out");
}

test("a download that matches its pinned checksum is unpacked into the data folder and used first", { skip: process.platform === "win32" && "the stand-in is a shell script" }, async () => {
  const { directory, services } = await setup();
  const { archive, integrity } = await fakePackage(directory);
  const server = await serve(archive);
  const programs = services.kernel.programs;
  programs.package = () => ({ version: "9.9.9", url: server.url, integrity, size: archive.length });
  try {
    const started = await programs.install("claude-code");
    // A local download can finish before the first status is assembled; otherwise it reports its progress.
    assert.ok(started.install || started.source === "saturn", "the status reports the download, or that it is done");
    await until(async () => (await programs.status("claude-code")).source === "saturn");
    const status = await programs.status("claude-code");
    assert.equal(status.installed, true);
    assert.equal(status.path, path.join(directory, "tools", "claude-code", "9.9.9", "package", "claude"));
    assert.equal(status.version, "9.9.9 (Claude Code)", "the version comes from the program itself");
    assert.ok(((await stat(status.path!)).mode & 0o111) !== 0, "the program is executable");
    assert.equal(services.kernel.claudeCode.cliPath(), status.path, "Claude Code runs Saturn's copy");

    const removed = await programs.remove("claude-code");
    assert.notEqual(removed.source, "saturn");
  } finally {
    server.close();
  }
});

test("a download that does not match its checksum is discarded and nothing is installed", async () => {
  const { directory, services } = await setup();
  const { archive } = await fakePackage(directory);
  const server = await serve(archive);
  const programs = services.kernel.programs;
  programs.package = () => ({ version: "9.9.9", url: server.url, integrity: `sha512-${createHash("sha512").update("something else").digest("base64")}`, size: archive.length });
  try {
    await programs.install("codex");
    await until(async () => (await programs.status("codex")).install?.state === "failed");
    const status = await programs.status("codex");
    assert.match(status.install?.error ?? "", /does not match the checksum/);
    assert.notEqual(status.source, "saturn");
    await assert.rejects(stat(path.join(directory, "tools", "codex", "9.9.9")), "nothing was unpacked");
  } finally {
    server.close();
  }
});

test("with no program anywhere, the status says so and running one asks for the download", async () => {
  const { services } = await setup();
  const programs = services.kernel.programs;
  programs.resolve = () => null;
  const status = await programs.status("codex");
  assert.deepEqual([status.installed, status.source, status.path], [false, null, null]);
  assert.ok(status.downloadSize > 0 && status.downloadVersion, "the button can say what it downloads");
  assert.throws(() => services.kernel.codex.cliPath(), /not installed\. Download it in Saturn Settings/);
  const claude = await services.kernel.claudeCode.status();
  assert.equal(claude.installed, false);
});

test("a dropped connection resumes with a range request, and the whole file is still checked", { skip: process.platform === "win32" && "the stand-in is a shell script" }, async () => {
  const { directory, services } = await setup();
  const { archive, integrity } = await fakePackage(directory);
  const ranges: string[] = [];
  let first = true;
  const server = createServer((req, res) => {
    ranges.push(String(req.headers.range ?? ""));
    if (first) {
      // Send half the file, then drop the connection, as a flaky network does.
      first = false;
      res.writeHead(200, { "content-length": archive.length });
      res.write(archive.subarray(0, Math.floor(archive.length / 2)), () => res.socket?.destroy());
      return;
    }
    const start = Number(/bytes=(\d+)-/.exec(String(req.headers.range))?.[1] ?? 0);
    res.writeHead(206, { "content-length": archive.length - start, "content-range": `bytes ${start}-${archive.length - 1}/${archive.length}` });
    res.end(archive.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const programs = services.kernel.programs;
  programs.package = () => ({ version: "9.9.9", url: `http://127.0.0.1:${address.port}/fake.tgz`, integrity, size: archive.length });
  try {
    await programs.install("claude-code");
    await until(async () => (await programs.status("claude-code")).source === "saturn", 20_000);
    assert.equal(ranges[0], "", "the first request asks for the whole file");
    assert.equal(ranges[1], `bytes=${Math.floor(archive.length / 2)}-`, "the retry asks only for the rest");
  } finally {
    server.close();
  }
});
