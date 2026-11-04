// Finding, downloading and removing Claude Code and Codex, and signing them in and out, whichever language runs them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM, VERSION, startWithPrograms } from "./programs.mjs";

test("the pinned downloads cover the systems Saturn ships on, come from the npm registry and carry a sha512", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pinned = JSON.parse(await readFile(path.join(root, "crates/saturn-core/src/agent-programs.json"), "utf8"));
  for (const id of ["claude-code", "codex"]) {
    assert.ok(pinned[id]["darwin-arm64"] && pinned[id]["win32-x64"], `${id} covers the platforms Saturn ships`);
    for (const item of Object.values(pinned[id])) {
      assert.ok(item.url.startsWith("https://registry.npmjs.org/"), item.url);
      assert.match(item.integrity, /^sha512-/);
      assert.ok(item.version);
    }
  }
});

/** A platform package as npm packs it. */
async function fakePackage(folder, inner, name) {
  const root = path.join(folder, "build");
  await mkdir(path.join(root, "package", inner), { recursive: true });
  await writeFile(path.join(root, "package", inner, name), "#!/bin/sh\necho '9.9.9 (from the package)'\n");
  const file = path.join(folder, "fake.tgz");
  execFileSync("tar", ["-czf", file, "-C", root, "package"]);
  const archive = await readFile(file);
  return { archive, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` };
}

/** A registry that hands out `archive`; `handle` may answer a request itself. */
async function registry(archive, handle) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(String(request.headers.range ?? ""));
    if (handle?.(request, response, requests.length)) return;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    response.end(archive);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/fake.tgz`, requests, close: () => server.close() };
}

async function pinned(saturn, id, url, integrity, size) {
  await writeFile(saturn.manifestFile, JSON.stringify({ "claude-code": {}, codex: {}, [id]: { [PLATFORM]: { version: VERSION, url, integrity, size } } }));
}

test("a program in Saturn's own folder is found and asked for its version; an unknown program is a 404", async () => {
  const saturn = await startWithPrograms();
  try {
    const list = await saturn.api("GET", "/programs");
    assert.deepEqual(list, [
      { id: "claude-code", label: "Claude Code", installed: true, source: "saturn", path: saturn.placed["claude-code"], version: "9.9.9 (stand-in)", downloadVersion: VERSION, downloadSize: 123 },
      { id: "codex", label: "Codex", installed: true, source: "saturn", path: saturn.placed.codex, version: "9.9.9 (stand-in)", downloadVersion: VERSION, downloadSize: 123 },
    ]);
    assert.deepEqual(await saturn.api("GET", "/programs/codex"), list[1]);
    assert.deepEqual(await saturn.call("GET", "/programs/nope"), { status: 404, body: { error: "Unknown program; use claude-code or codex" } });
    assert.equal((await saturn.call("POST", "/programs/nope/install", {})).status, 404);
    assert.equal((await saturn.call("DELETE", "/programs/nope")).status, 404);
    // The answer is remembered: a second look does not start the program again.
    await saturn.forget();
    await saturn.api("GET", "/programs/codex");
    assert.deepEqual(await saturn.journal(), []);
  } finally {
    await saturn.stop();
  }
});

test("with no program anywhere the status says so, and everything that needs one says how to get it", async () => {
  const saturn = await startWithPrograms({ install: [] });
  try {
    assert.deepEqual(await saturn.api("GET", "/programs/claude-code"), { id: "claude-code", label: "Claude Code", installed: false, source: null, path: null, version: null, downloadVersion: VERSION, downloadSize: 123 });
    assert.deepEqual(await saturn.api("GET", "/claude-code/status"), { loggedIn: false, authMethod: "none", loginCommand: "", configDir: path.join(saturn.dataDir, "claude"), installed: false });
    assert.deepEqual(await saturn.api("GET", "/codex/status"), { loggedIn: false, authMethod: "none", configDir: path.join(saturn.dataDir, "codex"), installed: false });
    assert.deepEqual(await saturn.call("POST", "/claude-code/logout", {}), { status: 409, body: { error: "Claude Code is not installed. Download it in Saturn Settings → General → Claude Code." } });
    assert.deepEqual(await saturn.call("POST", "/codex/logout", {}), { status: 409, body: { error: "Codex is not installed. Download it in Saturn Settings → General → Codex." } });
    assert.deepEqual(await saturn.call("POST", "/codex/sign-in", {}), { status: 409, body: { error: "Codex is not installed. Download it in Saturn Settings → General → Codex." } });
    assert.ok(statSync(path.join(saturn.dataDir, "claude")).isDirectory(), "the status makes the config folder");
    assert.ok(statSync(path.join(saturn.dataDir, "codex")).isDirectory());

    const connection = await saturn.api("POST", "/connections/models", { provider: "codex", model: "default" });
    const agent = await saturn.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id });
    const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "hi" });
    const run = await saturn.until("the run", () => saturn.api("GET", `/runs/${started.id}`), (item) => item.status === "failed");
    assert.match(run.error, /Codex is not installed\. Download it in Saturn Settings/);
  } finally {
    await saturn.stop();
  }
});

test("a program on the system is used when Saturn has none, and removing Saturn's copy leaves it alone", async () => {
  const saturn = await startWithPrograms({ install: ["claude-code"] });
  try {
    const system = path.join(saturn.bin, "claude");
    await writeFile(system, "#!/bin/sh\necho 'from the system'\n", { mode: 0o755 });
    assert.equal((await saturn.api("GET", "/programs/claude-code")).source, "saturn", "Saturn's own copy comes first");
    const removed = await saturn.api("DELETE", "/programs/claude-code");
    assert.deepEqual([removed.source, removed.path, removed.version], ["system", system, "from the system"]);
    assert.equal(existsSync(path.join(saturn.dataDir, "tools", "claude-code")), false);
    assert.equal(existsSync(system), true);
  } finally {
    await saturn.stop();
  }
});

test("a download that matches its pin is unpacked into the data folder, made executable and used, and old versions go", async () => {
  const saturn = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(saturn.folder, "", "claude");
  const server = await registry(archive);
  try {
    await mkdir(path.join(saturn.dataDir, "tools", "claude-code", "1.0.0"), { recursive: true });
    await pinned(saturn, "claude-code", server.url, integrity, archive.length);
    const started = await saturn.call("POST", "/programs/claude-code/install", {});
    assert.equal(started.status, 202);
    const status = await saturn.until("the download", () => saturn.api("GET", "/programs/claude-code"), (item) => item.source === "saturn");
    assert.deepEqual(status, { id: "claude-code", label: "Claude Code", installed: true, source: "saturn", path: path.join(saturn.dataDir, "tools", "claude-code", VERSION, "package", "claude"), version: "9.9.9 (from the package)", downloadVersion: VERSION, downloadSize: archive.length });
    assert.ok((statSync(status.path).mode & 0o111) !== 0, "the program is executable");
    assert.equal(existsSync(path.join(saturn.dataDir, "tools", "claude-code", "1.0.0")), false, "only this version stays");
    const removed = await saturn.api("DELETE", "/programs/claude-code");
    assert.deepEqual([removed.installed, removed.source], [false, null]);
  } finally {
    server.close();
    await saturn.stop();
  }
});

test("Codex's program is found under vendor in its package", async () => {
  const saturn = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(saturn.folder, "vendor/aarch64-apple-darwin/bin", "codex");
  const server = await registry(archive);
  try {
    await pinned(saturn, "codex", server.url, integrity, archive.length);
    assert.equal((await saturn.call("POST", "/programs/codex/install", {})).status, 202);
    const status = await saturn.until("the download", () => saturn.api("GET", "/programs/codex"), (item) => item.source === "saturn");
    assert.equal(status.path, path.join(saturn.dataDir, "tools", "codex", VERSION, "package", "vendor", "aarch64-apple-darwin", "bin", "codex"));
  } finally {
    server.close();
    await saturn.stop();
  }
});

test("a download that does not match its pin is thrown away, and the status reports it until the next try", async () => {
  const saturn = await startWithPrograms({ install: [] });
  const { archive } = await fakePackage(saturn.folder, "", "claude");
  const server = await registry(archive);
  try {
    await pinned(saturn, "claude-code", server.url, `sha512-${createHash("sha512").update("something else").digest("base64")}`, archive.length);
    await saturn.api("POST", "/programs/claude-code/install", {});
    const status = await saturn.until("the failure", () => saturn.api("GET", "/programs/claude-code"), (item) => item.install?.state === "failed");
    assert.equal(status.install.error, "the download does not match the checksum Saturn pinned for it, so it was discarded");
    assert.equal(status.installed, false);
    assert.equal(existsSync(path.join(saturn.dataDir, "tools", "claude-code", VERSION)), false, "nothing was unpacked");
    assert.equal(existsSync(path.join(saturn.dataDir, "tools", "claude-code", `${VERSION}.tgz.part`)), false, "nothing is kept to resume");
    await saturn.api("DELETE", "/programs/claude-code");
    assert.equal((await saturn.api("GET", "/programs/claude-code")).install, undefined, "removing forgets the failure");
  } finally {
    server.close();
    await saturn.stop();
  }
});

test("a package without the program in it installs nothing", async () => {
  const saturn = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(saturn.folder, "", "something-else");
  const server = await registry(archive);
  try {
    await pinned(saturn, "claude-code", server.url, integrity, archive.length);
    await saturn.api("POST", "/programs/claude-code/install", {});
    const status = await saturn.until("the failure", () => saturn.api("GET", "/programs/claude-code"), (item) => item.install?.state === "failed");
    assert.equal(status.install.error, "the package does not contain the program");
    assert.equal(status.installed, false);
    assert.equal(existsSync(path.join(saturn.dataDir, "tools", "claude-code", `${VERSION}.unpacking`)), false, "the leftovers go");
  } finally {
    server.close();
    await saturn.stop();
  }
});

test("a package that writes outside its folder is refused and leaves nothing there", { skip: process.platform === "win32" && "built with the system's tar" }, async () => {
  const saturn = await startWithPrograms({ install: [] });
  const root = path.join(saturn.folder, "evil");
  await mkdir(path.join(root, "package"), { recursive: true });
  await writeFile(path.join(root, "package", "claude"), "#!/bin/sh\n");
  await writeFile(path.join(saturn.folder, "escaped.txt"), "placed by the package");
  const file = path.join(saturn.folder, "evil.tgz");
  // -P keeps the ".." in the member's name, as a tampered archive would have it.
  execFileSync("tar", ["-czPf", file, "-C", root, "package/claude", "../escaped.txt"]);
  await rm(path.join(saturn.folder, "escaped.txt"));
  const archive = await readFile(file);
  const server = await registry(archive);
  try {
    await pinned(saturn, "claude-code", server.url, `sha512-${createHash("sha512").update(archive).digest("base64")}`, archive.length);
    await saturn.api("POST", "/programs/claude-code/install", {});
    await saturn.until("the download to end", () => saturn.api("GET", "/programs/claude-code"), (item) => item.install?.state === "failed" || item.source === "saturn");
    for (const escaped of [path.join(saturn.dataDir, "tools", "claude-code", "escaped.txt"), path.join(saturn.dataDir, "tools", "escaped.txt"), path.join(saturn.folder, "escaped.txt")]) {
      assert.equal(existsSync(escaped), false, `${escaped} was not written`);
    }
  } finally {
    server.close();
    await saturn.stop();
  }
});

test("a dropped connection resumes with a range request, and the whole file is still checked", async () => {
  const saturn = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(saturn.folder, "", "claude");
  const half = Math.floor(archive.length / 2);
  const server = await registry(archive, (request, response, count) => {
    if (count === 1) {
      response.writeHead(200, { "content-length": archive.length });
      response.write(archive.subarray(0, half), () => response.socket?.destroy());
      return true;
    }
    const start = Number(/bytes=(\d+)-/.exec(String(request.headers.range))?.[1] ?? 0);
    response.writeHead(206, { "content-length": archive.length - start, "content-range": `bytes ${start}-${archive.length - 1}/${archive.length}` });
    response.end(archive.subarray(start));
    return true;
  });
  try {
    await pinned(saturn, "claude-code", server.url, integrity, archive.length);
    await saturn.api("POST", "/programs/claude-code/install", {});
    await saturn.until("the download", () => saturn.api("GET", "/programs/claude-code"), (item) => item.source === "saturn", 30_000);
    assert.equal(server.requests[0], "", "the first request asks for the whole file");
    assert.equal(server.requests[1], `bytes=${half}-`, "the retry asks only for the rest");
  } finally {
    server.close();
    await saturn.stop();
  }
});

test("a platform with no published package cannot download, and says so", async () => {
  const saturn = await startWithPrograms({ install: [], packages: { "claude-code": {}, codex: {} } });
  try {
    assert.deepEqual(await saturn.call("POST", "/programs/codex/install", {}), { status: 409, body: { error: `Codex has no download for ${process.platform}-${process.arch}.` } });
    const status = await saturn.api("GET", "/programs/codex");
    assert.deepEqual([status.downloadVersion, status.downloadSize], [null, 0]);
  } finally {
    await saturn.stop();
  }
});

test("Claude Code's login comes from the program, in Saturn's own config folder, with the command to sign in", async () => {
  const saturn = await startWithPrograms({ env: { ANTHROPIC_API_KEY: "the-users-own-key", CLAUDE_CODE_USE_BEDROCK: "1", ELECTRON_RUN_AS_NODE: "1" } });
  try {
    const configDir = path.join(saturn.dataDir, "claude");
    const loginCommand = `CLAUDE_CONFIG_DIR=${configDir} ${saturn.placed["claude-code"]} auth login --claudeai`;
    assert.deepEqual(await saturn.api("GET", "/claude-code/status"), { loggedIn: false, authMethod: "none", loginCommand, configDir }, "signed out exits 1 and still prints its answer");
    const [started] = (await saturn.journal()).filter((entry) => entry.started && entry.args[0] === "auth");
    assert.deepEqual(started.args, ["auth", "status", "--json"]);
    assert.deepEqual(started.env, { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "the-users-own-key", CLAUDE_CODE_USE_BEDROCK: "1" }, "the user's own settings pass, the packaged runtime's own do not");

    await saturn.scenario({ status: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", subscriptionType: "max", extra: "ignored" }) } });
    assert.deepEqual(await saturn.api("GET", "/claude-code/status"), { loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", subscriptionType: "max", loginCommand, configDir });

    await saturn.scenario({ status: { code: 3, stderr: "boom", stdout: "not json" } });
    const broken = await saturn.api("GET", "/claude-code/status");
    assert.deepEqual([broken.loggedIn, broken.authMethod, broken.loginCommand], [false, "none", loginCommand]);
    assert.match(broken.error, /^Could not ask Claude Code for its login: /);

    await saturn.forget();
    await saturn.scenario({});
    assert.deepEqual(await saturn.api("POST", "/claude-code/logout", {}), { loggedIn: false, authMethod: "none", loginCommand, configDir });
    assert.deepEqual((await saturn.journal()).filter((entry) => entry.started).map((entry) => entry.args), [["auth", "logout"], ["auth", "status", "--json"]]);

    await saturn.scenario({ logout: { code: 1, stderr: "no way" } });
    const refused = await saturn.call("POST", "/claude-code/logout", {});
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /^Claude Code could not sign out: /);
  } finally {
    await saturn.stop();
  }
});

test("Codex's login comes from the program, without any credential that would outrank it", async () => {
  const saturn = await startWithPrograms({ env: { OPENAI_API_KEY: "stray", OPENAI_BASE_URL: "http://stray", CODEX_API_KEY: "stray", CODEX_ACCESS_TOKEN: "stray", ELECTRON_RUN_AS_NODE: "1" } });
  try {
    const configDir = path.join(saturn.dataDir, "codex");
    assert.deepEqual(await saturn.api("GET", "/codex/status"), { loggedIn: false, authMethod: "none", configDir }, "signed out is not an error");
    const [started] = (await saturn.journal()).filter((entry) => entry.started && entry.args[0] === "login");
    assert.deepEqual(started.args, ["login", "status"]);
    assert.deepEqual(started.env, { CODEX_HOME: configDir });

    await saturn.scenario({ status: { stdout: "Logged in using ChatGPT\n" } });
    assert.deepEqual(await saturn.api("GET", "/codex/status"), { loggedIn: true, authMethod: "chatgpt", configDir });
    await saturn.scenario({ status: { stderr: "Logged in using an API key - sk-***\n" } });
    assert.deepEqual(await saturn.api("GET", "/codex/status"), { loggedIn: true, authMethod: "api-key", configDir });
    await saturn.scenario({ status: { stdout: "Logged in somehow\n" } });
    assert.deepEqual(await saturn.api("GET", "/codex/status"), { loggedIn: true, authMethod: "unknown", configDir });
    await saturn.scenario({ status: { code: 2, stderr: "something else went wrong\n" } });
    assert.deepEqual(await saturn.api("GET", "/codex/status"), { loggedIn: false, authMethod: "none", configDir }, "an exit code means the program answered");

    await saturn.forget();
    await saturn.scenario({});
    assert.deepEqual(await saturn.api("POST", "/codex/logout", {}), { loggedIn: false, authMethod: "none", configDir });
    assert.deepEqual((await saturn.journal()).filter((entry) => entry.started).map((entry) => entry.args), [["logout"], ["login", "status"]]);

    await saturn.scenario({ logout: { code: 1, stderr: "Not logged in\n" } });
    assert.equal((await saturn.call("POST", "/codex/logout", {})).status, 200, "already signed out is not worth showing");
    await saturn.scenario({ logout: { code: 1, stderr: "disk on fire\n" } });
    const refused = await saturn.call("POST", "/codex/logout", {});
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /^Codex could not sign out: .*disk on fire/s);
  } finally {
    await saturn.stop();
  }
});

test("a device sign-in relays the program's link and code, and can be opened and cancelled", async () => {
  const saturn = await startWithPrograms();
  try {
    const url = "https://auth.openai.com/codex/device";
    await saturn.scenario({ signIn: { stdout: `\u001b[1mWelcome to Codex\u001b[0m\n1. Open ${url}\n2. Enter this code\n   6JMY-KP8EO\n` } });
    const configDir = path.join(saturn.dataDir, "codex");
    const started = await saturn.api("POST", "/codex/sign-in", {});
    assert.deepEqual(started, { loggedIn: false, authMethod: "none", configDir, signIn: { mode: "device", state: "waiting", url, code: "6JMY-KP8EO" } });
    const login = (await saturn.journal()).find((entry) => entry.started && entry.args[0] === "login" && entry.args[1] !== "status");
    assert.deepEqual(login.args, ["login", "--device-auth"]);
    assert.equal(login.env.NO_COLOR, "1");
    assert.deepEqual(await saturn.api("GET", "/codex/status"), started);
    assert.deepEqual(await saturn.api("POST", "/codex/sign-in", {}), started, "asking again keeps the one in progress");

    assert.deepEqual(await saturn.api("POST", "/codex/sign-in/open", {}), { opened: true });
    await saturn.until("the page", () => saturn.opened(), (list) => list.length === 1);
    assert.deepEqual(await saturn.opened(), [url], "only the link the program printed");
    assert.deepEqual(await saturn.api("DELETE", "/codex/sign-in"), { loggedIn: false, authMethod: "none", configDir });
    assert.deepEqual(await saturn.call("POST", "/codex/sign-in/open", {}), { status: 409, body: { error: "No Codex sign-in is waiting" } });
  } finally {
    await saturn.stop();
  }
});

test("a browser sign-in opens the page once; a link that is not https is never opened", async () => {
  const saturn = await startWithPrograms();
  try {
    const url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=x";
    await saturn.scenario({ signIn: { stdout: `Starting local login server on http://localhost:1455.\nnavigate to this URL to authenticate:\n\n${url}\n` } });
    const started = await saturn.api("POST", "/codex/sign-in", { mode: "browser" });
    assert.deepEqual(started.signIn, { mode: "browser", state: "waiting", url });
    await saturn.until("the page", () => saturn.opened(), (list) => list.length === 1);
    assert.deepEqual((await saturn.journal()).find((entry) => entry.started && entry.args[0] === "login" && entry.args[1] !== "status").args, ["login"]);

    // Another mode ends the sign-in in progress and starts its own.
    await saturn.scenario({ signIn: { stdout: "Enter https://auth.openai.com/codex/device with ABCD-EFGH\n" } });
    assert.deepEqual((await saturn.api("POST", "/codex/sign-in", { mode: "device" })).signIn, { mode: "device", state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH" });
    await saturn.api("DELETE", "/codex/sign-in");
  } finally {
    await saturn.stop();
  }
});

test("a sign-in that ends badly says why, and one that finishes leaves nothing behind", async () => {
  const saturn = await startWithPrograms();
  try {
    await saturn.scenario({ signIn: { stdout: "Working on it\nThe port is taken\n", exit: 1 } });
    const failed = await saturn.api("POST", "/codex/sign-in", {});
    assert.deepEqual(failed.signIn, { mode: "device", state: "failed", error: "The port is taken" });
    assert.deepEqual((await saturn.api("GET", "/codex/status")).signIn, failed.signIn, "the failure stays on show");

    await saturn.scenario({ signIn: { stdout: "", exit: 0 }, status: { stdout: "Logged in using ChatGPT\n" } });
    await saturn.api("POST", "/codex/sign-in", {});
    const done = await saturn.until("the sign-in to end", () => saturn.api("GET", "/codex/status"), (item) => !item.signIn);
    assert.deepEqual([done.loggedIn, done.authMethod], [true, "chatgpt"]);
  } finally {
    await saturn.stop();
  }
});

test("the program and sign-in routes are not open to other local programs", async () => {
  const saturn = await startWithPrograms();
  try {
    for (const [method, route] of [["GET", "/programs"], ["POST", "/programs/codex/install"], ["DELETE", "/programs/codex"], ["GET", "/claude-code/status"], ["POST", "/claude-code/logout"], ["GET", "/codex/status"], ["POST", "/codex/sign-in"], ["DELETE", "/codex/sign-in"], ["POST", "/codex/logout"], ["POST", "/codex/sign-in/open"]]) {
      assert.equal((await fetch(`${saturn.origin}${route}`, { method })).status, 401, `${method} ${route}`);
    }
  } finally {
    await saturn.stop();
  }
});
