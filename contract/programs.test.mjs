// Finding, downloading and removing Claude Code, Codex and uv, and signing the first two in and out, whichever language runs them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM, VERSION, placeProgram, startWithPrograms } from "./programs.mjs";
import { opensPages } from "./runtime.mjs";

test("the pinned downloads cover the systems the app ships on, come from the npm registry or uv's release, and carry a sha512", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pinned = JSON.parse(await readFile(path.join(root, "crates/workbench-core/src/agent-programs.json"), "utf8"));
  for (const id of ["claude-code", "codex", "uv"]) {
    assert.ok(pinned[id]["darwin-arm64"] && pinned[id]["win32-x64"], `${id} covers the platforms the app ships`);
    for (const item of Object.values(pinned[id])) {
      const origin = id === "uv" ? "https://github.com/astral-sh/uv/releases/download/" : "https://registry.npmjs.org/";
      assert.ok(item.url.startsWith(origin), item.url);
      assert.match(item.integrity, /^sha512-/);
      assert.ok(item.version);
      assert.ok(item.size > 0, `${item.url} has a size`);
    }
  }
});

/** A program that only says its version, as a shell script or, for the launcher Windows needs, as JavaScript. */
const SAYS_ITS_VERSION = process.platform === "win32" ? "console.log('9.9.9 (from the package)');\n" : "#!/bin/sh\necho '9.9.9 (from the package)'\n";
/** A program's file name on this system. */
const named = (file) => (process.platform === "win32" ? `${file}.exe` : file);

/** A platform package as npm packs it, or, with `bare`, as uv's release archive packs its folder: with no `package` root. */
async function fakePackage(folder, inner, name, { bare = false, program = SAYS_ITS_VERSION } = {}) {
  const root = path.join(folder, "build");
  await rm(root, { recursive: true, force: true });
  const top = bare ? inner.split("/")[0] : "package";
  await mkdir(path.join(root, bare ? inner : path.join("package", inner)), { recursive: true });
  await placeProgram(path.join(root, bare ? inner : path.join("package", inner), name), program);
  const file = path.join(folder, "fake.tgz");
  execFileSync("tar", ["-czf", file, "-C", root, top]);
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

async function pinned(workbench, id, url, integrity, size) {
  await writeFile(workbench.manifestFile, JSON.stringify({ "claude-code": {}, codex: {}, uv: {}, [id]: { [PLATFORM]: { version: VERSION, url, integrity, size } } }));
}

test("a program in the app's own folder is found and asked for its version; an unknown program is a 404", async () => {
  const workbench = await startWithPrograms({ install: ["claude-code", "codex", "uv"] });
  try {
    const list = await workbench.api("GET", "/programs");
    assert.deepEqual(list, [
      { id: "claude-code", label: "Claude Code", installed: true, source: "workbench", path: workbench.placed["claude-code"], version: "9.9.9 (stand-in)", downloadVersion: VERSION, downloadSize: 123 },
      { id: "codex", label: "Codex", installed: true, source: "workbench", path: workbench.placed.codex, version: "9.9.9 (stand-in)", downloadVersion: VERSION, downloadSize: 123 },
      { id: "uv", label: "uv", installed: true, source: "workbench", path: workbench.placed.uv, version: "uv 9.9.9 (stand-in)", downloadVersion: VERSION, downloadSize: 123 },
    ]);
    assert.deepEqual(await workbench.api("GET", "/programs/codex"), list[1]);
    assert.deepEqual(await workbench.call("GET", "/programs/nope"), { status: 404, body: { error: "Unknown program; use claude-code, codex or uv" } });
    assert.equal((await workbench.call("POST", "/programs/nope/install", {})).status, 404);
    assert.equal((await workbench.call("DELETE", "/programs/nope")).status, 404);
    // The answer is remembered: a second look does not start the program again.
    await workbench.forget();
    await workbench.api("GET", "/programs/codex");
    assert.deepEqual(await workbench.journal(), []);
  } finally {
    await workbench.stop();
  }
});

test("with no program anywhere the status says so, and everything that needs one says how to get it", async () => {
  const workbench = await startWithPrograms({ install: [] });
  try {
    assert.deepEqual(await workbench.api("GET", "/programs/claude-code"), { id: "claude-code", label: "Claude Code", installed: false, source: null, path: null, version: null, downloadVersion: VERSION, downloadSize: 123 });
    assert.deepEqual(await workbench.api("GET", "/claude-code/status"), { loggedIn: false, authMethod: "none", loginCommand: "", configDir: path.join(workbench.dataDir, "claude"), installed: false });
    assert.deepEqual(await workbench.api("GET", "/codex/status"), { loggedIn: false, authMethod: "none", configDir: path.join(workbench.dataDir, "codex"), installed: false });
    assert.deepEqual(await workbench.call("POST", "/claude-code/logout", {}), { status: 409, body: { error: "Claude Code is not installed. Download it in Settings → General → Claude Code." } });
    assert.deepEqual(await workbench.call("POST", "/codex/logout", {}), { status: 409, body: { error: "Codex is not installed. Download it in Settings → General → Codex." } });
    assert.deepEqual(await workbench.call("POST", "/codex/sign-in", {}), { status: 409, body: { error: "Codex is not installed. Download it in Settings → General → Codex." } });
    assert.ok(statSync(path.join(workbench.dataDir, "claude")).isDirectory(), "the status makes the config folder");
    assert.ok(statSync(path.join(workbench.dataDir, "codex")).isDirectory());

    const connection = await workbench.api("POST", "/connections/models", { provider: "codex", model: "default" });
    const agent = await workbench.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id });
    const started = await workbench.api("POST", `/agents/${agent.id}/runs`, { input: "hi" });
    const run = await workbench.until("the run", () => workbench.api("GET", `/runs/${started.id}`), (item) => item.status === "failed");
    assert.match(run.error, /Codex is not installed\. Download it in Settings/);
  } finally {
    await workbench.stop();
  }
});

test("a program on the system is used when the app has none, and removing the app's copy leaves it alone", async () => {
  const workbench = await startWithPrograms({ install: ["claude-code"] });
  try {
    const system = await placeProgram(path.join(workbench.bin, "claude"), process.platform === "win32" ? "console.log('from the system');\n" : "#!/bin/sh\necho 'from the system'\n");
    assert.equal((await workbench.api("GET", "/programs/claude-code")).source, "workbench", "The app's own copy comes first");
    const removed = await workbench.api("DELETE", "/programs/claude-code");
    assert.deepEqual([removed.source, removed.path, removed.version], ["system", system, "from the system"]);
    assert.equal(existsSync(path.join(workbench.dataDir, "tools", "claude-code")), false);
    assert.equal(existsSync(system), true);
  } finally {
    await workbench.stop();
  }
});

test("a download that matches its pin is unpacked into the data folder, made executable and used, and old versions go", async () => {
  const workbench = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(workbench.folder, "", "claude");
  const server = await registry(archive);
  try {
    await mkdir(path.join(workbench.dataDir, "tools", "claude-code", "1.0.0"), { recursive: true });
    await pinned(workbench, "claude-code", server.url, integrity, archive.length);
    const started = await workbench.call("POST", "/programs/claude-code/install", {});
    assert.equal(started.status, 202);
    const status = await workbench.until("the download", () => workbench.api("GET", "/programs/claude-code"), (item) => item.source === "workbench");
    assert.deepEqual(status, { id: "claude-code", label: "Claude Code", installed: true, source: "workbench", path: named(path.join(workbench.dataDir, "tools", "claude-code", VERSION, "package", "claude")), version: "9.9.9 (from the package)", downloadVersion: VERSION, downloadSize: archive.length });
    // Windows has no such mode: there a program is one by its name.
    if (process.platform !== "win32") assert.ok((statSync(status.path).mode & 0o111) !== 0, "the program is executable");
    assert.equal(existsSync(path.join(workbench.dataDir, "tools", "claude-code", "1.0.0")), false, "only this version stays");
    const removed = await workbench.api("DELETE", "/programs/claude-code");
    assert.deepEqual([removed.installed, removed.source], [false, null]);
  } finally {
    server.close();
    await workbench.stop();
  }
});

test("uv is unpacked from its bare release archive, found in its folder, and makes the environment by its path", { skip: process.platform === "win32" && "a shell stand-in" }, async () => {
  const workbench = await startWithPrograms({ install: [] });
  // The archive's uv says its version and makes a venv folder, so the job that uses it ends well.
  const program = "#!/bin/sh\ncase \"$1\" in --version) echo 'uv 9.9.9 (from the archive)';; venv) mkdir -p \"$2/bin\"; : > \"$2/bin/python\"; echo \"made $2\";; esac\n";
  const { archive, integrity } = await fakePackage(workbench.folder, "uv-aarch64-apple-darwin", "uv", { bare: true, program });
  const server = await registry(archive);
  try {
    assert.deepEqual(await workbench.api("GET", "/programs/uv"), { id: "uv", label: "uv", installed: false, source: null, path: null, version: null, downloadVersion: VERSION, downloadSize: 123 });
    await pinned(workbench, "uv", server.url, integrity, archive.length);
    assert.equal((await workbench.call("POST", "/programs/uv/install", {})).status, 202);
    const status = await workbench.until("the download", () => workbench.api("GET", "/programs/uv"), (item) => item.source === "workbench");
    const file = path.join(workbench.dataDir, "tools", "uv", VERSION, "package", "uv-aarch64-apple-darwin", "uv");
    assert.deepEqual(status, { id: "uv", label: "uv", installed: true, source: "workbench", path: file, version: "uv 9.9.9 (from the archive)", downloadVersion: VERSION, downloadSize: archive.length });

    const folder = path.join(workbench.folder, "project");
    await mkdir(folder);
    const project = await workbench.api("POST", "/projects", { path: folder });
    await workbench.api("POST", `/projects/${project.id}/access`, {});
    const route = `/projects/${project.id}/research/environment`;
    const environment = await workbench.api("GET", route);
    assert.deepEqual([environment.tools.uv, environment.tools.uvSource], [file, "workbench"]);
    await workbench.api("POST", `${route}/create`, { withCore: false });
    const made = await workbench.until("the job", () => workbench.api("GET", route), (record) => record.job && record.job.status !== "running");
    assert.deepEqual(made.job.commands, [`'${file}' venv '.venv'`]);
    assert.equal(made.job.status, "completed", made.job.logTail);
    assert.equal(made.tools.managed.exists, true);
  } finally {
    server.close();
    await workbench.stop();
  }
});

test("Codex's program is found under vendor in its package", async () => {
  const workbench = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(workbench.folder, "vendor/aarch64-apple-darwin/bin", "codex");
  const server = await registry(archive);
  try {
    await pinned(workbench, "codex", server.url, integrity, archive.length);
    assert.equal((await workbench.call("POST", "/programs/codex/install", {})).status, 202);
    const status = await workbench.until("the download", () => workbench.api("GET", "/programs/codex"), (item) => item.source === "workbench");
    assert.equal(status.path, named(path.join(workbench.dataDir, "tools", "codex", VERSION, "package", "vendor", "aarch64-apple-darwin", "bin", "codex")));
  } finally {
    server.close();
    await workbench.stop();
  }
});

test("a download that does not match its pin is thrown away, and the status reports it until the next try", async () => {
  const workbench = await startWithPrograms({ install: [] });
  const { archive } = await fakePackage(workbench.folder, "", "claude");
  const server = await registry(archive);
  try {
    await pinned(workbench, "claude-code", server.url, `sha512-${createHash("sha512").update("something else").digest("base64")}`, archive.length);
    await workbench.api("POST", "/programs/claude-code/install", {});
    const status = await workbench.until("the failure", () => workbench.api("GET", "/programs/claude-code"), (item) => item.install?.state === "failed");
    assert.equal(status.install.error, "the download does not match the checksum the app pinned for it, so it was discarded");
    assert.equal(status.installed, false);
    assert.equal(existsSync(path.join(workbench.dataDir, "tools", "claude-code", VERSION)), false, "nothing was unpacked");
    assert.equal(existsSync(path.join(workbench.dataDir, "tools", "claude-code", `${VERSION}.tgz.part`)), false, "nothing is kept to resume");
    await workbench.api("DELETE", "/programs/claude-code");
    assert.equal((await workbench.api("GET", "/programs/claude-code")).install, undefined, "removing forgets the failure");
  } finally {
    server.close();
    await workbench.stop();
  }
});

test("a package without the program in it installs nothing", async () => {
  const workbench = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(workbench.folder, "", "something-else");
  const server = await registry(archive);
  try {
    await pinned(workbench, "claude-code", server.url, integrity, archive.length);
    await workbench.api("POST", "/programs/claude-code/install", {});
    const status = await workbench.until("the failure", () => workbench.api("GET", "/programs/claude-code"), (item) => item.install?.state === "failed");
    assert.equal(status.install.error, "the package does not contain the program");
    assert.equal(status.installed, false);
    assert.equal(existsSync(path.join(workbench.dataDir, "tools", "claude-code", `${VERSION}.unpacking`)), false, "the leftovers go");
  } finally {
    server.close();
    await workbench.stop();
  }
});

test("a package that writes outside its folder is refused and leaves nothing there", { skip: process.platform === "win32" && "built with the system's tar" }, async () => {
  const workbench = await startWithPrograms({ install: [] });
  const root = path.join(workbench.folder, "evil");
  await mkdir(path.join(root, "package"), { recursive: true });
  await writeFile(path.join(root, "package", "claude"), "#!/bin/sh\n");
  await writeFile(path.join(workbench.folder, "escaped.txt"), "placed by the package");
  const file = path.join(workbench.folder, "evil.tgz");
  // -P keeps the ".." in the member's name, as a tampered archive would have it.
  execFileSync("tar", ["-czPf", file, "-C", root, "package/claude", "../escaped.txt"]);
  await rm(path.join(workbench.folder, "escaped.txt"));
  const archive = await readFile(file);
  const server = await registry(archive);
  try {
    await pinned(workbench, "claude-code", server.url, `sha512-${createHash("sha512").update(archive).digest("base64")}`, archive.length);
    await workbench.api("POST", "/programs/claude-code/install", {});
    await workbench.until("the download to end", () => workbench.api("GET", "/programs/claude-code"), (item) => item.install?.state === "failed" || item.source === "workbench");
    for (const escaped of [path.join(workbench.dataDir, "tools", "claude-code", "escaped.txt"), path.join(workbench.dataDir, "tools", "escaped.txt"), path.join(workbench.folder, "escaped.txt")]) {
      assert.equal(existsSync(escaped), false, `${escaped} was not written`);
    }
  } finally {
    server.close();
    await workbench.stop();
  }
});

test("a dropped connection resumes with a range request, and the whole file is still checked", async () => {
  const workbench = await startWithPrograms({ install: [] });
  const { archive, integrity } = await fakePackage(workbench.folder, "", "claude");
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
    await pinned(workbench, "claude-code", server.url, integrity, archive.length);
    await workbench.api("POST", "/programs/claude-code/install", {});
    await workbench.until("the download", () => workbench.api("GET", "/programs/claude-code"), (item) => item.source === "workbench", 30_000);
    assert.equal(server.requests[0], "", "the first request asks for the whole file");
    assert.equal(server.requests[1], `bytes=${half}-`, "the retry asks only for the rest");
  } finally {
    server.close();
    await workbench.stop();
  }
});

test("a platform with no published package cannot download, and says so", async () => {
  const workbench = await startWithPrograms({ install: [], packages: { "claude-code": {}, codex: {} } });
  try {
    assert.deepEqual(await workbench.call("POST", "/programs/codex/install", {}), { status: 409, body: { error: `Codex has no download for ${PLATFORM}.` } });
    const status = await workbench.api("GET", "/programs/codex");
    assert.deepEqual([status.downloadVersion, status.downloadSize], [null, 0]);
  } finally {
    await workbench.stop();
  }
});

test("Claude Code's login comes from the program, in the app's own config folder, with the command to sign in", async () => {
  // A key for another service in the user's environment has no use in Claude Code, whose shell could print it.
  const workbench = await startWithPrograms({ env: { ANTHROPIC_API_KEY: "the-users-own-key", CLAUDE_CODE_USE_BEDROCK: "1", ELECTRON_RUN_AS_NODE: "1", OPENAI_API_KEY: "another-services-key" } });
  try {
    const configDir = path.join(workbench.dataDir, "claude");
    // The command to paste in a terminal: PowerShell's way on Windows.
    const loginCommand = process.platform === "win32"
      ? `$env:CLAUDE_CONFIG_DIR='${configDir}'; & '${workbench.placed["claude-code"]}' auth login --claudeai`
      : `CLAUDE_CONFIG_DIR=${configDir} ${workbench.placed["claude-code"]} auth login --claudeai`;
    assert.deepEqual(await workbench.api("GET", "/claude-code/status"), { loggedIn: false, authMethod: "none", loginCommand, configDir }, "signed out exits 1 and still prints its answer");
    const [started] = (await workbench.journal()).filter((entry) => entry.started && entry.args[0] === "auth");
    assert.deepEqual(started.args, ["auth", "status", "--json"]);
    assert.deepEqual(started.env, { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "the-users-own-key", CLAUDE_CODE_USE_BEDROCK: "1" }, "the user's own settings pass, the packaged runtime's own and other services' keys do not");

    await workbench.scenario({ status: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", subscriptionType: "max", extra: "ignored" }) } });
    assert.deepEqual(await workbench.api("GET", "/claude-code/status"), { loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", subscriptionType: "max", loginCommand, configDir });

    await workbench.scenario({ status: { code: 3, stderr: "boom", stdout: "not json" } });
    const broken = await workbench.api("GET", "/claude-code/status");
    assert.deepEqual([broken.loggedIn, broken.authMethod, broken.loginCommand], [false, "none", loginCommand]);
    assert.match(broken.error, /^Could not ask Claude Code for its login: /);

    await workbench.forget();
    await workbench.scenario({});
    assert.deepEqual(await workbench.api("POST", "/claude-code/logout", {}), { loggedIn: false, authMethod: "none", loginCommand, configDir });
    assert.deepEqual((await workbench.journal()).filter((entry) => entry.started).map((entry) => entry.args), [["auth", "logout"], ["auth", "status", "--json"]]);

    await workbench.scenario({ logout: { code: 1, stderr: "no way" } });
    const refused = await workbench.call("POST", "/claude-code/logout", {});
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /^Claude Code could not sign out: /);
  } finally {
    await workbench.stop();
  }
});

test("Codex's login comes from the program, without any credential that would outrank it", async () => {
  const workbench = await startWithPrograms({ env: { OPENAI_API_KEY: "stray", OPENAI_BASE_URL: "http://stray", CODEX_API_KEY: "stray", CODEX_ACCESS_TOKEN: "stray", ELECTRON_RUN_AS_NODE: "1" } });
  try {
    const configDir = path.join(workbench.dataDir, "codex");
    assert.deepEqual(await workbench.api("GET", "/codex/status"), { loggedIn: false, authMethod: "none", configDir }, "signed out is not an error");
    const [started] = (await workbench.journal()).filter((entry) => entry.started && entry.args[0] === "login");
    assert.deepEqual(started.args, ["login", "status"]);
    assert.deepEqual(started.env, { CODEX_HOME: configDir });

    await workbench.scenario({ status: { stdout: "Logged in using ChatGPT\n" } });
    assert.deepEqual(await workbench.api("GET", "/codex/status"), { loggedIn: true, authMethod: "chatgpt", configDir });
    await workbench.scenario({ status: { stderr: "Logged in using an API key - sk-***\n" } });
    assert.deepEqual(await workbench.api("GET", "/codex/status"), { loggedIn: true, authMethod: "api-key", configDir });
    await workbench.scenario({ status: { stdout: "Logged in somehow\n" } });
    assert.deepEqual(await workbench.api("GET", "/codex/status"), { loggedIn: true, authMethod: "unknown", configDir });
    await workbench.scenario({ status: { code: 2, stderr: "something else went wrong\n" } });
    assert.deepEqual(await workbench.api("GET", "/codex/status"), { loggedIn: false, authMethod: "none", configDir }, "an exit code means the program answered");

    await workbench.forget();
    await workbench.scenario({});
    assert.deepEqual(await workbench.api("POST", "/codex/logout", {}), { loggedIn: false, authMethod: "none", configDir });
    assert.deepEqual((await workbench.journal()).filter((entry) => entry.started).map((entry) => entry.args), [["logout"], ["login", "status"]]);

    await workbench.scenario({ logout: { code: 1, stderr: "Not logged in\n" } });
    assert.equal((await workbench.call("POST", "/codex/logout", {})).status, 200, "already signed out is not worth showing");
    await workbench.scenario({ logout: { code: 1, stderr: "disk on fire\n" } });
    const refused = await workbench.call("POST", "/codex/logout", {});
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /^Codex could not sign out: .*disk on fire/s);
  } finally {
    await workbench.stop();
  }
});

test("a device sign-in relays the program's link and code, and can be opened and cancelled", opensPages, async () => {
  const workbench = await startWithPrograms();
  try {
    const url = "https://auth.openai.com/codex/device";
    await workbench.scenario({ signIn: { stdout: `\u001b[1mWelcome to Codex\u001b[0m\n1. Open ${url}\n2. Enter this code\n   6JMY-KP8EO\n` } });
    const configDir = path.join(workbench.dataDir, "codex");
    const started = await workbench.api("POST", "/codex/sign-in", {});
    assert.deepEqual(started, { loggedIn: false, authMethod: "none", configDir, signIn: { mode: "device", state: "waiting", url, code: "6JMY-KP8EO" } });
    const login = (await workbench.journal()).find((entry) => entry.started && entry.args[0] === "login" && entry.args[1] !== "status");
    assert.deepEqual(login.args, ["login", "--device-auth"]);
    assert.equal(login.env.NO_COLOR, "1");
    assert.deepEqual(await workbench.api("GET", "/codex/status"), started);
    assert.deepEqual(await workbench.api("POST", "/codex/sign-in", {}), started, "asking again keeps the one in progress");

    assert.deepEqual(await workbench.api("POST", "/codex/sign-in/open", {}), { opened: true });
    await workbench.until("the page", () => workbench.opened(), (list) => list.length === 1);
    assert.deepEqual(await workbench.opened(), [url], "only the link the program printed");
    assert.deepEqual(await workbench.api("DELETE", "/codex/sign-in"), { loggedIn: false, authMethod: "none", configDir });
    assert.deepEqual(await workbench.call("POST", "/codex/sign-in/open", {}), { status: 409, body: { error: "No Codex sign-in is waiting" } });
  } finally {
    await workbench.stop();
  }
});

test("a browser sign-in opens the page once; a link that is not https is never opened", opensPages, async () => {
  const workbench = await startWithPrograms();
  try {
    const url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=x";
    await workbench.scenario({ signIn: { stdout: `Starting local login server on http://localhost:1455.\nnavigate to this URL to authenticate:\n\n${url}\n` } });
    const started = await workbench.api("POST", "/codex/sign-in", { mode: "browser" });
    assert.deepEqual(started.signIn, { mode: "browser", state: "waiting", url });
    await workbench.until("the page", () => workbench.opened(), (list) => list.length === 1);
    assert.deepEqual((await workbench.journal()).find((entry) => entry.started && entry.args[0] === "login" && entry.args[1] !== "status").args, ["login"]);

    // Another mode ends the sign-in in progress and starts its own.
    await workbench.scenario({ signIn: { stdout: "Enter https://auth.openai.com/codex/device with ABCD-EFGH\n" } });
    assert.deepEqual((await workbench.api("POST", "/codex/sign-in", { mode: "device" })).signIn, { mode: "device", state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH" });
    await workbench.api("DELETE", "/codex/sign-in");
  } finally {
    await workbench.stop();
  }
});

test("a sign-in that ends badly says why, and one that finishes leaves nothing behind", async () => {
  const workbench = await startWithPrograms();
  try {
    await workbench.scenario({ signIn: { stdout: "Working on it\nThe port is taken\n", exit: 1 } });
    const failed = await workbench.api("POST", "/codex/sign-in", {});
    assert.deepEqual(failed.signIn, { mode: "device", state: "failed", error: "The port is taken" });
    assert.deepEqual((await workbench.api("GET", "/codex/status")).signIn, failed.signIn, "the failure stays on show");

    await workbench.scenario({ signIn: { stdout: "", exit: 0 }, status: { stdout: "Logged in using ChatGPT\n" } });
    await workbench.api("POST", "/codex/sign-in", {});
    const done = await workbench.until("the sign-in to end", () => workbench.api("GET", "/codex/status"), (item) => !item.signIn);
    assert.deepEqual([done.loggedIn, done.authMethod], [true, "chatgpt"]);
  } finally {
    await workbench.stop();
  }
});

test("the program and sign-in routes are not open to other local programs", async () => {
  const workbench = await startWithPrograms();
  try {
    for (const [method, route] of [["GET", "/programs"], ["POST", "/programs/codex/install"], ["DELETE", "/programs/codex"], ["GET", "/claude-code/status"], ["POST", "/claude-code/logout"], ["GET", "/codex/status"], ["POST", "/codex/sign-in"], ["DELETE", "/codex/sign-in"], ["POST", "/codex/logout"], ["POST", "/codex/sign-in/open"]]) {
      assert.equal((await fetch(`${workbench.origin}${route}`, { method })).status, 401, `${method} ${route}`);
    }
  } finally {
    await workbench.stop();
  }
});
