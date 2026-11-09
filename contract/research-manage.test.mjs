// A managed Python environment in the project: made and filled by jobs whose output is kept, with uv when it is on
// PATH, which installs a Python first when the computer has none. A stand-in uv plays the tool. docs/research-contract.md
// is the contract.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, until } from "./files-support.mjs";

/**
 * A "uv" that makes a venv whose python answers the environment check, and records every install in the project.
 */
const UV = `#!/bin/sh
case "$1" in
  venv)
    shift
    while [ $# -gt 1 ]; do shift; done
    mkdir -p "$1/bin"
    cat > "$1/bin/python" <<'PY'
#!/bin/sh
cat > /dev/null
installed=$(cat installed.txt 2>/dev/null | tr '\\n' ' ')
torch=null; case " $installed " in *" torch "*) torch='"2.5.0"';; esac
lens=null; case " $installed " in *" transformer_lens "*) lens='"2.0.0"';; esac
printf '{"executable":"venv","version":"3.12.0","platform":"stand-in","cpus":2,"packages":{"torch":%s,"transformers":null,"transformer_lens":%s},"devices":{"torch":null,"reason":"none"}}' "$torch" "$lens"
PY
    chmod +x "$1/bin/python"
    echo "made $1"
    ;;
  pip)
    shift; shift; shift; shift
    for name in "$@"; do echo "$name" >> installed.txt; done
    echo "installed $*"
    ;;
  sync)
    echo "synced" >> installed.txt
    ;;
  python)
    shift; shift
    echo "installed python $* bin=$UV_PYTHON_INSTALL_BIN registry=$UV_PYTHON_INSTALL_REGISTRY managed=$UV_MANAGED_PYTHON"
    ;;
esac
`;

let saturn;
let tools;
before(async () => {
  tools = await import("node:fs/promises").then(async (fs) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-stand-in-uv-"));
    await writeFile(path.join(folder, "uv"), UV);
    await chmod(path.join(folder, "uv"), 0o755);
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

test("creating the environment makes a venv with uv, installs the bundled kit, and names its python", posixOnly, async () => {
  const { folder, route } = await project();
  const before = await saturn.api("GET", route);
  assert.ok(before.tools.uv.endsWith("/uv"));
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
  assert.deepEqual(done.job.commands, ["uv venv '.venv'", "uv pip install --python '.venv/bin/python' 'torch' 'transformers' 'numpy'"]);
  assert.deepEqual(done.job.env, { UV_PYTHON_INSTALL_BIN: "0", UV_PYTHON_INSTALL_REGISTRY: "0" });
  assert.match(done.job.logTail, /\$ uv venv '.venv'\nmade .venv\n\$ uv pip install/);
  assert.equal(done.tools.managed.exists, true);
  assert.equal(done.python, ".venv/bin/python");
  assert.deepEqual((await readFile(path.join(folder, "installed.txt"), "utf8")).trim().split("\n"), ["torch", "transformers", "numpy"]);
  const log = await readFile(path.join(folder, ".saturn/research/environment-job.log"), "utf8");
  assert.match(log, /installed torch transformers numpy/);

  const checked = await saturn.api("POST", `${route}/check`);
  assert.equal(checked.report.version, "3.12.0");
  const core = checked.kits.find((kit) => kit.id === "core");
  assert.deepEqual(core.packages.map((item) => [item.name, item.installed]), [["torch", "2.5.0"], ["transformers", null], ["numpy", null]]);
});

test("a kit, named packages and a lock file are installed by jobs, one at a time, and bad names are refused", posixOnly, async () => {
  const { folder, route } = await project();
  const nothing = await saturn.call("POST", `${route}/install`, { kit: "interpretability" });
  assert.equal(nothing.status, 422);
  await saturn.api("POST", `${route}/create`, { withCore: false });
  const made = await until("the environment", () => saturn.api("GET", route), settled);
  assert.deepEqual(made.job.commands, ["uv venv '.venv'"]);

  await saturn.api("POST", `${route}/install`, { kit: "interpretability", packages: ["rich>=13"] });
  const installed = await until("the install", () => saturn.api("GET", route), settled);
  assert.equal(installed.job.kind, "install");
  assert.deepEqual(installed.job.env, {});
  assert.equal(installed.job.commands[0], "uv pip install --python '.venv/bin/python' 'transformer_lens' 'sae_lens' 'einops' 'rich>=13'");
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
  assert.equal(synced.job.commands[0], "uv pip install --python '.venv/bin/python' -r 'requirements.txt'");
  await writeFile(path.join(folder, "uv.lock"), "version = 1\n");
  await saturn.api("POST", `${route}/install`, { sync: true });
  const locked = await until("the uv sync", () => saturn.api("GET", route), settled);
  assert.deepEqual(locked.job.commands, ["uv sync"]);
  assert.equal((await saturn.call("POST", `${route}/job/stop`)).status, 409);
  const checked = await saturn.api("POST", `${route}/check`);
  assert.equal(checked.kits.find((kit) => kit.id === "interpretability").packages[0].installed, "2.0.0");
  assert.ok(await readFile(path.join(folder, ".venv/bin/python"), "utf8"));
  await mkdir(path.join(folder, "unused"));
});

test("with uv and no Python on this computer, making the environment has uv install a Python first", posixOnly, async () => {
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
    assert.ok(before.tools.uv.endsWith("/uv"));

    await alone.api("POST", `${route}/create`, { withCore: false, python: "3.12" });
    const done = await until("the job to end", () => alone.api("GET", route), settled);
    assert.deepEqual(done.job.commands, ["uv python install '3.12'", "uv venv --python '3.12' '.venv'"]);
    // The Python goes into uv's folder alone, and the environment is made from it rather than one found elsewhere.
    assert.deepEqual(done.job.env, { UV_PYTHON_INSTALL_BIN: "0", UV_PYTHON_INSTALL_REGISTRY: "0", UV_MANAGED_PYTHON: "1" });
    assert.equal(done.job.status, "completed", done.job.logTail);
    assert.match(done.job.logTail, /\$ uv python install '3.12'\ninstalled python 3.12 bin=0 registry=0 managed=1\n\$ uv venv/);
    assert.equal(done.python, ".venv/bin/python");

    // With no version asked for, uv installs its newest stable Python.
    await rm(path.join(folder, ".venv"), { recursive: true, force: true });
    await alone.api("POST", `${route}/create`, { withCore: false });
    const newest = await until("the second job", () => alone.api("GET", route), (record) => settled(record) && record.job.commands.length === 2 && record.job.commands[0] === "uv python install");
    assert.deepEqual(newest.job.commands, ["uv python install", "uv venv '.venv'"]);
  } finally {
    await alone.stop();
  }
});

test("a job can be stopped, and one started by another runtime reads as interrupted", posixOnly, async () => {
  const { folder, route } = await project();
  await writeFile(path.join(tools, "uv"), `#!/bin/sh\nif [ "$1" = venv ]; then sleep 30; fi\n`);
  await chmod(path.join(tools, "uv"), 0o755);
  const started = await saturn.api("POST", `${route}/create`, { withCore: false });
  assert.equal(started.job.status, "running");
  const stopped = await saturn.api("POST", `${route}/job/stop`);
  assert.equal(stopped.status, "running");
  const ended = await until("the stop", () => saturn.api("GET", route), settled);
  assert.equal(ended.job.status, "failed");
  await writeFile(path.join(folder, ".saturn/research/environment-job.json"), JSON.stringify({ ...ended.job, status: "running", logTail: undefined, logLines: undefined }));
  const orphan = await saturn.api("GET", route);
  assert.equal(orphan.job.status, "interrupted");
  await writeFile(path.join(tools, "uv"), UV);
});

test("an environment job times out, stops even uncooperative descendants, and releases the project for retry", posixOnly, async () => {
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
