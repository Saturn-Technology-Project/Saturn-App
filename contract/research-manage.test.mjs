// A managed Python environment in the project: made and filled by jobs whose output is kept, with uv when it is on
// PATH, which installs a Python first when the computer has none. A stand-in uv plays the tool. docs/research-contract.md
// is the contract.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, until } from "./files-support.mjs";
import { placeProgram } from "./programs.mjs";

/**
 * A "uv" that makes a venv whose python answers the environment check, and records every install in the project.
 */
const UV = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
// The venv's python: it reads the check's helper and answers with what was "installed" in the project.
const python = "#!" + process.execPath + String.raw\`
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  let installed = [];
  try { installed = fs.readFileSync("installed.txt", "utf8").split(/\\r?\\n/); } catch { /* nothing installed yet */ }
  const version = (name, is) => (installed.includes(name) ? is : null);
  process.stdout.write(JSON.stringify({ executable: "venv", version: "3.12.0", platform: "stand-in", cpus: 2, packages: { torch: version("torch", "2.5.0"), transformers: null, transformer_lens: version("transformer_lens", "2.0.0") }, devices: { torch: null, reason: "none" } }));
});
\`;
if (args[0] === "venv") {
  const target = args.at(-1);
  if (process.platform === "win32") {
    // Windows starts only an .exe by name: the launcher this stand-in itself runs through, with the script beside it.
    const folder = path.join(target, "Scripts");
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(process.argv[1].replace(/\\.cjs$/, ".exe"), path.join(folder, "python.exe"));
    fs.writeFileSync(path.join(folder, "python.cjs"), python);
    fs.writeFileSync(path.join(folder, "python.node"), process.execPath);
  } else {
    fs.mkdirSync(path.join(target, "bin"), { recursive: true });
    fs.writeFileSync(path.join(target, "bin/python"), python, { mode: 0o755 });
  }
  console.log("made " + target);
} else if (args[0] === "pip") {
  for (const name of args.slice(4)) fs.appendFileSync("installed.txt", name + "\\n");
  console.log("installed " + args.slice(4).join(" "));
} else if (args[0] === "sync") {
  fs.appendFileSync("installed.txt", "synced\\n");
} else if (args[0] === "python") {
  const set = (name) => process.env[name] ?? "";
  console.log("installed python " + args.slice(2).join(" ") + " bin=" + set("UV_PYTHON_INSTALL_BIN") + " registry=" + set("UV_PYTHON_INSTALL_REGISTRY") + " managed=" + set("UV_MANAGED_PYTHON"));
}
`;

/** How this system writes the environment's python, and a word in a job's command. */
const WINDOWS = process.platform === "win32";
const VENV_PYTHON = WINDOWS ? ".venv/Scripts/python.exe" : ".venv/bin/python";
const q = (word) => (WINDOWS ? `"${word}"` : `'${word}'`);
/** Some tests' stand-ins are shell scripts, or need the command sandbox. */
const shellOnly = { skip: WINDOWS && "its stand-ins are shell scripts" };

let saturn;
let tools;
before(async () => {
  tools = await import("node:fs/promises").then(async (fs) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-stand-in-uv-"));
    await placeProgram(path.join(folder, "uv"), UV);
    // A Python on the PATH whatever this computer has, so uv is not asked to install one first. Nothing runs it.
    await placeProgram(path.join(folder, "python3"), `#!${process.execPath}\n`);
    return folder;
  });
  saturn = await bench({ env: { PATH: `${tools}${path.delimiter}${process.env.PATH}` } });
});
after(async () => { await saturn?.stop(); });

const settled = (record) => record.job && record.job.status !== "running";

async function project() {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  return { folder, route: `/projects/${made.id}/research/environment` };
}

test("creating the environment makes a venv with uv, installs the bundled kit, and names its python", async () => {
  const { folder, route } = await project();
  const before = await saturn.api("GET", route);
  assert.equal(path.parse(before.tools.uv).name, "uv");
  assert.equal(before.tools.uvSource, "system");
  assert.equal(before.tools.managed.exists, false);
  assert.equal(before.job, null);
  assert.deepEqual(before.kits.map((kit) => [kit.id, kit.bundled]), [["core", true], ["interpretability", false], ["training", false], ["analysis", false], ["notebooks", false], ["language-server", false]]);

  const started = await saturn.api("POST", `${route}/create`, {});
  assert.equal(started.job.status, "running");
  assert.equal(started.job.kind, "create");
  const done = await until("the job to end", () => saturn.api("GET", route), settled);
  assert.equal(done.job.status, "completed", done.job.logTail);
  assert.equal(done.job.exitCode, 0);
  assert.deepEqual(done.job.commands, [`uv venv ${q(".venv")}`, `uv pip install --python ${q(VENV_PYTHON)} ${q("torch")} ${q("transformers")} ${q("numpy")}`]);
  assert.deepEqual(done.job.env, { UV_PYTHON_INSTALL_BIN: "0", UV_PYTHON_INSTALL_REGISTRY: "0" });
  assert.match(done.job.logTail.replaceAll("\r", ""), /\$ uv venv ['"].venv['"] ?\nmade .venv\n\$ uv pip install/);
  assert.equal(done.tools.managed.exists, true);
  assert.equal(done.python, VENV_PYTHON);
  assert.deepEqual((await readFile(path.join(folder, "installed.txt"), "utf8")).trim().split("\n"), ["torch", "transformers", "numpy"]);
  const log = await readFile(path.join(folder, ".saturn/research/environment-job.log"), "utf8");
  assert.match(log, /installed torch transformers numpy/);

  const checked = await saturn.api("POST", `${route}/check`);
  assert.equal(checked.report.version, "3.12.0");
  const core = checked.kits.find((kit) => kit.id === "core");
  assert.deepEqual(core.packages.map((item) => [item.name, item.installed]), [["torch", "2.5.0"], ["transformers", null], ["numpy", null]]);
});

test("a kit, named packages and a lock file are installed by jobs, one at a time, and bad names are refused", async () => {
  const { folder, route } = await project();
  const nothing = await saturn.call("POST", `${route}/install`, { kit: "interpretability" });
  assert.equal(nothing.status, 422);
  await saturn.api("POST", `${route}/create`, { withCore: false });
  const made = await until("the environment", () => saturn.api("GET", route), settled);
  assert.deepEqual(made.job.commands, [`uv venv ${q(".venv")}`]);

  await saturn.api("POST", `${route}/install`, { kit: "interpretability", packages: ["rich>=13"] });
  const installed = await until("the install", () => saturn.api("GET", route), settled);
  assert.equal(installed.job.kind, "install");
  assert.deepEqual(installed.job.env, {});
  assert.equal(installed.job.commands[0], `uv pip install --python ${q(VENV_PYTHON)} ${q("transformer_lens")} ${q("sae_lens")} ${q("einops")} ${q("rich>=13")}`);
  const bad = await saturn.call("POST", `${route}/install`, { packages: ["--upgrade"] });
  assert.equal(bad.status, 400);
  const unknown = await saturn.call("POST", `${route}/install`, { kit: "nope" });
  assert.equal(unknown.status, 404);
  const empty = await saturn.call("POST", `${route}/install`, {});
  assert.equal(empty.status, 400);

  const noLock = await saturn.call("POST", `${route}/install`, { sync: true });
  assert.equal(noLock.status, 422);
  await writeFile(path.join(folder, "requirements.txt"), "einops\n");
  await saturn.api("POST", `${route}/install`, { sync: true });
  const synced = await until("the sync", () => saturn.api("GET", route), settled);
  assert.equal(synced.job.kind, "sync");
  assert.equal(synced.job.commands[0], `uv pip install --python ${q(VENV_PYTHON)} -r ${q("requirements.txt")}`);
  await writeFile(path.join(folder, "uv.lock"), "version = 1\n");
  await saturn.api("POST", `${route}/install`, { sync: true });
  const locked = await until("the uv sync", () => saturn.api("GET", route), settled);
  assert.deepEqual(locked.job.commands, ["uv sync"]);
  assert.equal((await saturn.call("POST", `${route}/job/stop`)).status, 409);
  const checked = await saturn.api("POST", `${route}/check`);
  assert.equal(checked.kits.find((kit) => kit.id === "interpretability").packages[0].installed, "2.0.0");
  assert.ok(await readFile(path.join(folder, VENV_PYTHON)));
  await mkdir(path.join(folder, "unused"));
});

test("with uv and no Python on this computer, making the environment has uv install a Python first", shellOnly, async () => {
  // A PATH with the stand-in uv and only what its venv step runs: no python3 anywhere on it.
  const bare = await mkdtemp(path.join(os.tmpdir(), "saturn-no-python-"));
  await writeFile(path.join(bare, "uv"), UV);
  await chmod(path.join(bare, "uv"), 0o755);
  for (const name of ["mkdir", "cat", "chmod", "git"]) {
    const found = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    await symlink(found, path.join(bare, name));
  }
  const alone = await bench({ env: { PATH: bare } });
  try {
    const folder = await alone.folder();
    const made = await alone.api("POST", "/projects", { path: folder });
    await alone.api("POST", `/projects/${made.id}/access`, {});
    const route = `/projects/${made.id}/research/environment`;
    const before = await alone.api("GET", route);
    assert.equal(before.tools.python3, null);
    assert.equal(path.parse(before.tools.uv).name, "uv");

    await alone.api("POST", `${route}/create`, { withCore: false, python: "3.12" });
    const done = await until("the job to end", () => alone.api("GET", route), settled);
    assert.deepEqual(done.job.commands, ["uv python install '3.12'", "uv venv --python '3.12' '.venv'"]);
    // The Python goes into uv's folder alone, and the environment is made from it rather than one found elsewhere.
    assert.deepEqual(done.job.env, { UV_PYTHON_INSTALL_BIN: "0", UV_PYTHON_INSTALL_REGISTRY: "0", UV_MANAGED_PYTHON: "1" });
    assert.equal(done.job.status, "completed", done.job.logTail);
    assert.match(done.job.logTail, /\$ uv python install '3.12'\ninstalled python 3.12 bin=0 registry=0 managed=1\n\$ uv venv/);
    assert.equal(done.python, VENV_PYTHON);

    // With no version asked for, uv installs its newest stable Python.
    await rm(path.join(folder, ".venv"), { recursive: true, force: true });
    await alone.api("POST", `${route}/create`, { withCore: false });
    const newest = await until("the second job", () => alone.api("GET", route), (record) => settled(record) && record.job.commands.length === 2 && record.job.commands[0] === "uv python install");
    assert.deepEqual(newest.job.commands, ["uv python install", "uv venv '.venv'"]);
  } finally {
    await alone.stop();
  }
});

test("a job can be stopped, and one started by another runtime reads as interrupted", async () => {
  const { folder, route } = await project();
  await placeProgram(path.join(tools, "uv"), `#!${process.execPath}\nif (process.argv[2] === "venv") setTimeout(() => {}, 30_000);\n`);
  const started = await saturn.api("POST", `${route}/create`, { withCore: false });
  assert.equal(started.job.status, "running");
  const stopped = await saturn.api("POST", `${route}/job/stop`);
  assert.equal(stopped.status, "running");
  const ended = await until("the stop", () => saturn.api("GET", route), settled);
  assert.equal(ended.job.status, "failed");
  await writeFile(path.join(folder, ".saturn/research/environment-job.json"), JSON.stringify({ ...ended.job, status: "running", logTail: undefined, logLines: undefined }));
  const orphan = await saturn.api("GET", route);
  assert.equal(orphan.job.status, "interrupted");
  await placeProgram(path.join(tools, "uv"), UV);
});

test("an environment job times out, stops even uncooperative descendants, and releases the project for retry", shellOnly, async () => {
  const { folder, route } = await project();
  for (const timeoutSeconds of [0, -1, 1.5, "1", 86401]) {
    assert.equal((await saturn.call("POST", `${route}/create`, { withCore: false, timeoutSeconds })).status, 400);
  }
  await writeFile(path.join(tools, "uv"), `#!/bin/sh
trap '' TERM
node -e 'process.on("SIGTERM", () => {}); setInterval(() => require("node:fs").appendFileSync("late.txt", "tick\\n"), 20)' &
wait
`);
  const started = await saturn.api("POST", `${route}/create`, { withCore: false, timeoutSeconds: 1 });
  assert.equal(started.job.timeoutSeconds, 1);
  const done = await until("the deadline and process group cleanup", () => saturn.api("GET", route), settled);
  assert.equal(done.job.status, "timed_out");
  assert.match(done.job.error, /1 second/);
  assert.match(done.job.logTail, /uv venv/);
  const before = await readFile(path.join(folder, "late.txt"), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await readFile(path.join(folder, "late.txt"), "utf8"), before);
  await writeFile(path.join(tools, "uv"), UV);
  await saturn.api("POST", `${route}/create`, { withCore: false });
  const retried = await until("the retry", () => saturn.api("GET", route), settled);
  assert.equal(retried.job.status, "completed");
  assert.equal(retried.job.timeoutSeconds, 1800);
});

/** Whether commands can be sandboxed here: seatbelt on macOS, bubblewrap on Linux. */
function canSandbox() {
  if (process.platform === "darwin") return true;
  if (process.platform !== "linux") return false;
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("the project's interpreter and its environment jobs run in the sandbox: neither reads Saturn's data", shellOnly, async (t) => {
  if (!canSandbox()) return t.skip("no sandbox for commands here");
  const data = await mkdtemp(path.join(os.tmpdir(), "saturn-interpreter-data-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "saturn-interpreter-"));
  // An interpreter (here a stand-in) that the project names, which tries to read Saturn's token as it starts: a cloned
  // project's environment can run code that way, through a .pth file in its site-packages.
  const python = path.join(outside, "python");
  await writeFile(python, `#!/bin/sh
cat > /dev/null
token=$(cat '${data}/runtime-token' 2>/dev/null || echo refused)
printf '{"executable":"stand-in","version":"3.12.0","platform":"p","cpus":1,"packages":{},"devices":{"torch":null,"reason":"none"},"note":"%s"}' "$token"
`);
  await chmod(python, 0o755);
  const probe = path.join(outside, "bin");
  await mkdir(probe);
  await writeFile(path.join(probe, "uv"), `#!/bin/sh
cat '${data}/runtime-token' > probe.txt 2>/dev/null || echo refused > probe.txt
mkdir -p "$3/bin" 2>/dev/null; mkdir -p .venv/bin
`);
  await chmod(path.join(probe, "uv"), 0o755);
  const alone = await bench({ dataDir: data, keepData: false, env: { PATH: `${probe}${path.delimiter}${process.env.PATH}` } });
  try {
    const token = (await readFile(path.join(data, "runtime-token"), "utf8")).trim();
    const folder = await alone.folder();
    const made = await alone.api("POST", "/projects", { path: folder, grant: true });
    const route = `/projects/${made.id}/research/environment`;
    await alone.api("PUT", route, { python });
    const checked = await alone.api("POST", `${route}/check`);
    assert.equal(checked.report.note, "refused", "the interpreter never saw the token");
    assert.ok(!JSON.stringify(checked).includes(token));

    await alone.api("POST", `${route}/create`, { withCore: false });
    const done = await until("the job to end", () => alone.api("GET", route), settled);
    assert.equal(done.job.status, "completed", done.job.logTail);
    assert.equal((await readFile(path.join(folder, "probe.txt"), "utf8")).trim(), "refused", "nor did the job's programs");
  } finally {
    await alone.stop();
    await rm(outside, { recursive: true, force: true });
  }
});

test("the assistant asks before it changes the project's interpreter, and a path is never a package", async () => {
  const folder = await saturn.folder();
  const setup = await saturn.chat(folder, { autonomy: "execute_when_allowed", mcpConnectionIds: ["research"] });
  const run = await setup.start([["research_environment_action", { action: "set", python: "/somewhere/python" }]], "use my python");
  const waiting = await until("the card", () => saturn.api("GET", `/runs/${run.id}`), (item) => item.status !== "running" && item.status !== "queued");
  assert.equal(waiting.status, "waiting_approval", JSON.stringify(waiting.actions));
  assert.match(waiting.actions[0].reason, /Sensitive operation/);
  await saturn.api("POST", `/runs/${run.id}/stop`);
  const environment = `/projects/${setup.project.id}/research/environment`;
  assert.equal((await saturn.api("GET", environment)).python ?? null, null, "nothing changed while it waited");

  await saturn.api("POST", `${environment}/create`, { withCore: false });
  await until("the environment", () => saturn.api("GET", environment), settled);
  for (const name of [".", "./", ".venv", "..", ".[dev]"]) {
    assert.equal((await saturn.call("POST", `${environment}/install`, { packages: [name] })).status, 400, name);
  }
});
