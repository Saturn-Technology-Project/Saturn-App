// The SSH stand-in runs the real Rust worker on another temporary folder. No user host, key or model is used.
import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { startRuntime } from "./runtime.mjs";
import { until } from "./files-support.mjs";

let runtime, folder, remote, binaries, data, origin, releases, served, runtimeEnv;
const worker = path.resolve("target/debug/saturn-server");
/** A JSON request to the isolated runtime. */
async function api(method, route, body) {
  const response = await fetch(origin + route, { method, headers: { "content-type": "application/json", authorization: `Bearer ${(await readFile(path.join(data, "runtime-token"), "utf8")).trim()}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
  return value;
}
before(async () => {
  folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-remote-contract-")));
  remote = path.join(folder, "remote"); binaries = path.join(folder, "bin"); data = path.join(folder, "state");
  await mkdir(remote); await mkdir(binaries);
  const fake = path.join(binaries, "ssh");
  // ssh.home names the host's home folder, and ssh.foreign makes the host another kind of system than this one.
  await writeFile(fake, '#!/bin/sh\nif [ -f "$0.offline" ]; then exit 255; fi\nprintf "%s\\n" "$@" > "$0.args"\nif [ -f "$0.home" ]; then HOME="$(cat "$0.home")"; export HOME; fi\nif [ -f "$0.foreign" ]; then PATH="$0.uname:$PATH"; export PATH; fi\nfor remote_command do :; done\nexec /bin/sh -c "$remote_command"\n');
  await chmod(fake, 0o755);
  await mkdir(path.join(binaries, "ssh.uname"));
  const foreign = process.arch === "x64" && process.platform === "linux" ? "aarch64" : "x86_64";
  await writeFile(path.join(binaries, "ssh.uname", "uname"), `#!/bin/sh\nif [ "$1" = "-m" ]; then echo ${foreign}; else echo Linux; fi\n`);
  await chmod(path.join(binaries, "ssh.uname", "uname"), 0o755);
  // The release a foreign host's worker comes from: whatever `served` holds, under any version's name.
  releases = createServer((request, response) => { if (!served) { response.writeHead(404).end(); return; } response.writeHead(200, { "content-type": "application/octet-stream" }).end(served); });
  await new Promise((resolve) => releases.listen(0, "127.0.0.1", resolve));
  const pin = createHash("sha256").update(await readFile(worker)).digest("hex");
  // Every runtime of these tests, the restarted ones too, sees the fake ssh and the release's pinned worker.
  runtimeEnv = { PATH: `${binaries}:${process.env.PATH}`, SATURN_WORKER_SHA256: `linux-x64=${pin},linux-arm64=${pin}`, SATURN_WORKER_DOWNLOAD: `http://127.0.0.1:${releases.address().port}` };
  runtime = await startRuntime({ dataDir: data, keepData: true, env: runtimeEnv });
  origin = runtime.origin;
});
after(async () => { await runtime?.stop(); releases?.close(); await rm(folder, { recursive: true, force: true }); });

/** A configured remote experiment, whose code already lives on the other machine. */
async function experiment(command, kind = "evaluation", files = {}, inputs = undefined, fields = {}) {
  const local = path.join(folder, `local-${Date.now()}`); await mkdir(local);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(local, name), content);
  const project = await api("POST", "/projects", { path: local, grant: true });
  const route = `/projects/${project.id}/research`;
  await api("PUT", `${route}/remote`, { host: "fixture-host", workdir: remote, program: worker });
  const draft = await api("POST", `${route}/experiments`, { title: "Remote", command, kind, ...(inputs ? { inputs } : {}), ...fields });
  const version = await api("POST", `${route}/experiments/${draft.id}/versions`, {});
  return { route, version, local };
}

test("a detached worker survives the runtime, reconnects, and does not submit twice", { skip: process.platform === "win32" }, async () => {
  await writeFile(path.join(remote, "probe.mjs"), `import { appendFileSync, writeFileSync } from 'node:fs'; let n=0; setInterval(()=>{ appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({schemaVersion:1,sampleId:String(n++),input:'a',scores:{s:1}})+'\\n'); if(n===12) { writeFileSync(process.env.SATURN_RUN_DIRECTORY+'/analysis.json', JSON.stringify({framework:'NNsight',result:[1,2]})); writeFileSync(process.env.SATURN_RUN_ARTIFACTS, JSON.stringify({path:'analysis.json',kind:'json'})+'\\n'); process.exit(0); } },250);`);
  const { route, version } = await experiment("node probe.mjs");
  const start = { versionId: version.id, clientId: "same-client", timeoutSeconds: 30 };
  const run = await api("POST", `${route}/remote/runs`, start);
  const duplicate = await api("POST", `${route}/remote/runs`, start);
  assert.equal(duplicate.id, run.id);
  await until("worker running", () => api("GET", `${route}/runs/${run.id}`), (item) => item.status === "running");
  await writeFile(path.join(binaries, "ssh.offline"), "offline");
  await until("transport disconnected", () => api("GET", `${route}/runs/${run.id}`), (item) => item.remoteConnection === "disconnected");
  await runtime.stop();
  await rm(path.join(binaries, "ssh.offline"));
  runtime = await startRuntime({ dataDir: data, keepData: true, env: runtimeEnv }); origin = runtime.origin;
  const ended = await until("remote finish after reconnect", () => api("GET", `${route}/runs/${run.id}`), (item) => item.status === "completed", 30);
  assert.equal(ended.samples, 12);
  assert.equal((await api("GET", `${route}/runs/${run.id}/samples`)).items.length, 12);
  const outputs = await api("POST", `${route}/artifacts/from-run`, { runId: run.id });
  assert.equal(outputs.items.length, 1);
  const content = await api("GET", `${route}/artifacts/${outputs.items[0].id}/content`);
  assert.deepEqual(JSON.parse(Buffer.from(content.data, "base64").toString()), { framework: "NNsight", result: [1, 2] });
  assert.equal(content.sourceChanged, null, "a remote snapshot has no source here to compare with");
  assert.match((await api("GET", `${route}/remote`)).note, /SSH/);
});

test("training-only jobs sync metrics, and stop and wall-clock limits end the worker's process group", { skip: process.platform === "win32" }, async () => {
  await writeFile(path.join(remote, "metrics.mjs"), `import { appendFileSync } from 'node:fs'; let n=0; setInterval(()=>appendFileSync(process.env.SATURN_RUN_METRICS,JSON.stringify({schemaVersion:1,step:n++,values:{loss:1}})+'\\n'),100);`);
  const { route, version } = await experiment("node metrics.mjs", "training");
  const run = await api("POST", `${route}/remote/runs`, { versionId: version.id, clientId: "timed", timeoutSeconds: 1 });
  const ended = await until("timeout", () => api("GET", `${route}/runs/${run.id}`), (item) => item.status === "stopped", 30);
  assert.equal(ended.remoteStatus, "timed_out");
  assert.ok((await api("GET", `${route}/runs/${run.id}/metrics`)).items.length);
  const another = await api("POST", `${route}/remote/runs`, { versionId: version.id, clientId: "stoppable", timeoutSeconds: 30 });
  await until("another worker", () => api("GET", `${route}/runs/${another.id}`), (item) => item.status === "running");
  await api("POST", `${route}/runs/${another.id}/stop`, {});
  await until("stopped", () => api("GET", `${route}/runs/${another.id}`), (item) => item.status === "stopped");
});

test("a remote job's log larger than 64 MiB comes back whole, in large parts pulled one after another", { skip: process.platform === "win32" }, async () => {
  // 65 MiB of log, then one sample: the old pace (128 KiB a second) would take minutes, and the old limit refused it.
  await writeFile(path.join(remote, "chatty.mjs"), `import { appendFileSync, writeSync } from 'node:fs'; const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 65 * 1024; i++) writeSync(1, line); appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({schemaVersion:1,sampleId:'only',input:'a',scores:{s:1}})+'\\n');`);
  const { route, version, local } = await experiment("node chatty.mjs");
  const run = await api("POST", `${route}/remote/runs`, { versionId: version.id, clientId: "chatty", timeoutSeconds: 120 });
  const ended = await until("the chatty job to come back", () => api("GET", `${route}/runs/${run.id}`), (item) => !["starting", "running", "stopping"].includes(item.status), 90);
  assert.equal(ended.status, "completed", JSON.stringify(ended));
  const log = await readFile(path.join(local, ".saturn/research/runs", run.id, "stdout.log"));
  assert.equal(log.length, 65 * 1024 * 1024);
});

test("remote settings reject command-like host names and do not disable host verification", async () => {
  const project = await api("POST", "/projects", { path: remote, grant: true });
  const route = `/projects/${project.id}/research/remote`;
  const response = await fetch(origin + route, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${(await readFile(path.join(data, "runtime-token"), "utf8")).trim()}` }, body: JSON.stringify({ host: "-oProxyCommand=bad", workdir: remote, program: worker }) });
  assert.equal(response.status, 400);
  if (process.platform !== "win32") {
    // Its own call, so what is checked is what this request sent, whatever ran before.
    await rm(path.join(binaries, "ssh.args"), { force: true });
    await api("PUT", route, { host: "fixture-host", workdir: remote, program: worker });
    await api("POST", `${route}/check`, {});
    const args = await readFile(path.join(binaries, "ssh.args"), "utf8");
    assert.match(args, /BatchMode=yes/);
    assert.equal(args.includes("StrictHostKeyChecking=no"), false);
    assert.equal(args.includes("UserKnownHostsFile=/dev/null"), false);
  }
});

/** Restarts the isolated runtime on the same data, as reopening the app does. */
async function restart() {
  await runtime.stop();
  runtime = await startRuntime({ dataDir: data, keepData: true, env: runtimeEnv });
  origin = runtime.origin;
}

test("a remote run whose record came with the project is never connected to or started, even after a restart", { skip: process.platform === "win32" }, async () => {
  // Well-formed records from a real project, then a second folder that carries a running remote run it wrote itself.
  const { version } = await experiment(`touch ${JSON.stringify(path.join(remote, "STARTED-BY-FILES"))}`);
  const source = path.dirname(path.dirname(path.join(folder, "x")));
  const shipped = path.join(folder, `shipped-${Date.now()}`);
  const own = (await api("GET", "/projects")).find((item) => existsSync(path.join(item.path, ".saturn/research/versions", `${version.id}.json`)));
  await mkdir(path.join(shipped, ".saturn/research/runs/run_aaaaaaaaaaaa"), { recursive: true });
  await cp(path.join(own.path, ".saturn/research/versions"), path.join(shipped, ".saturn/research/versions"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(shipped, ".saturn/research/runs/run_aaaaaaaaaaaa/run.json"), JSON.stringify({ schemaVersion: 1, revision: 1, id: "run_aaaaaaaaaaaa", createdAt: now, updatedAt: now, status: "running",
    experimentId: version.experimentId, versionId: version.id, kind: "evaluation", timeoutSeconds: 30, remote: { host: "fixture-host", workdir: remote, program: worker } }));
  const project = await api("POST", "/projects", { path: shipped, grant: true });
  await writeFile(path.join(binaries, "ssh.log"), "");
  await restart();
  const ended = await until("the shipped run to be let go", () => api("GET", `/projects/${project.id}/research/runs/run_aaaaaaaaaaaa`), (item) => item.status !== "running");
  assert.equal(ended.status, "interrupted");
  assert.match(ended.remoteError, /did not start this remote run/);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(existsSync(path.join(remote, "STARTED-BY-FILES")), false, "nothing ran on the remote host");
  assert.equal(existsSync(path.join(remote, ".saturn/remote-jobs/run_aaaaaaaaaaaa")), false, "nothing was even asked of it");
  assert.ok(source);
});

test("a job whose folder is gone from the remote host is reported, not started again", { skip: process.platform === "win32" }, async () => {
  await writeFile(path.join(remote, "once.mjs"), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(path.join(remote, "launches.txt"))}, 'launched\\n'); setTimeout(() => {}, 1500);`);
  // The program counts its launches in the host's working tree, which only a version without the sandbox may write.
  const { route, version } = await experiment("node once.mjs", "evaluation", {}, undefined, { sandbox: { isolated: false } });
  const run = await api("POST", `${route}/remote/runs`, { versionId: version.id, clientId: `once-${Date.now()}`, timeoutSeconds: 30 });
  await until("the job to launch", async () => (existsSync(path.join(remote, "launches.txt")) ? await readFile(path.join(remote, "launches.txt"), "utf8") : ""), (text) => text.includes("launched"));
  await writeFile(path.join(binaries, "ssh.offline"), "offline");
  await until("transport disconnected", () => api("GET", `${route}/runs/${run.id}`), (item) => item.remoteConnection === "disconnected");
  await runtime.stop();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const { rm: remove } = await import("node:fs/promises");
  await remove(path.join(remote, ".saturn/remote-jobs", run.id), { recursive: true, force: true });
  await remove(path.join(binaries, "ssh.offline"));
  runtime = await startRuntime({ dataDir: data, keepData: true, env: runtimeEnv }); origin = runtime.origin;
  const ended = await until("the lost job to be reported", () => api("GET", `${route}/runs/${run.id}`), (item) => item.status === "interrupted");
  assert.match(ended.remoteError, /not on the remote host/);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const launches = (await readFile(path.join(remote, "launches.txt"), "utf8")).trim().split("\n");
  assert.equal(launches.length, 1, "launched once, never again");
});

test("a host whose files differ from the version is refused before anything runs", { skip: process.platform === "win32" }, async () => {
  const marker = path.join(folder, `ran-${Date.now()}`);
  const local = `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({schemaVersion:1,sampleId:'a',scores:{s:1}})+'\\n');`;
  await writeFile(path.join(remote, "checked.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const { route, version } = await experiment("node checked.mjs", "evaluation", { "checked.mjs": local }, { code: ["checked.mjs"] });
  const run = await api("POST", `${route}/remote/runs`, { versionId: version.id, clientId: `refused-${Date.now()}`, timeoutSeconds: 30 });
  const ended = await until("the refusal", () => api("GET", `${route}/runs/${run.id}`), (item) => item.status === "failed", 30);
  assert.equal(ended.refused, true);
  assert.match(ended.error, /differ from version 1 — checked\.mjs/);
  assert.equal(existsSync(marker), false, "nothing ran on the host");
  const evidence = await api("GET", `${route}/runs/${run.id}/evidence`);
  assert.equal(evidence.observed.executor, "ssh");
  assert.deepEqual(evidence.verdicts, { execution: "not started", inputs: "changed", outputs: "none" });
});

test("a host that holds the version runs it from a checked snapshot, and the evidence comes back", { skip: process.platform === "win32" }, async () => {
  const escaped = path.join(remote, `escaped-${Date.now()}.txt`);
  const program = `import { appendFileSync, writeFileSync } from 'node:fs'; let wrote = 'wrote'; try { writeFileSync(${JSON.stringify(escaped)}, 'x'); } catch (error) { wrote = error.code; } writeFileSync(process.env.SATURN_RUN_OUTPUT + '/out.txt', wrote); appendFileSync(process.env.SATURN_RUN_REPORT, JSON.stringify({kind:'seed',value:7})+'\\n'); appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({schemaVersion:1,sampleId:'a',input:process.cwd(),scores:{s:1}})+'\\n');`;
  await writeFile(path.join(remote, "same.mjs"), program);
  const { route, version } = await experiment("node same.mjs", "evaluation", { "same.mjs": program }, { code: ["same.mjs"] });
  const run = await api("POST", `${route}/remote/runs`, { versionId: version.id, clientId: `same-${Date.now()}`, timeoutSeconds: 30 });
  const ended = await until("the run", () => api("GET", `${route}/runs/${run.id}`), (item) => !["starting", "running", "stopping"].includes(item.status), 30);
  assert.equal(ended.status, "completed", JSON.stringify(ended));
  const [sample] = (await api("GET", `${route}/runs/${run.id}/samples`)).items;
  assert.match(sample.sample.input, /snapshot/, "it ran in the job's snapshot, not the working tree");
  const evidence = await api("GET", `${route}/runs/${run.id}/evidence`);
  assert.equal(evidence.observed.executor, "ssh");
  assert.ok(evidence.observed.snapshot.inputs.some((input) => input.path === "same.mjs" && input.how === "copied"), JSON.stringify(evidence.observed.snapshot.inputs));
  assert.equal(evidence.verdicts.execution, "completed");
  assert.equal(evidence.verdicts.inputs, "partial", "the rest of the working tree is linked and uncontrolled");
  assert.equal(evidence.verdicts.outputs, "sealed");
  assert.deepEqual(evidence.reported.seed, { value: 7 });
  // The host ran it in its own sandbox when it has one, and says so either way.
  const sandbox = evidence.observed.sandbox;
  assert.equal(sandbox.requested, true);
  const out = await readFile(path.join(remote, ".saturn/remote-jobs", run.id, "written", "out.txt"), "utf8");
  if (sandbox.isolation === "sandbox") {
    assert.notEqual(out, "wrote", "the program could not write the host's working tree");
    assert.equal(existsSync(escaped), false);
  } else {
    assert.ok(sandbox.unavailable, JSON.stringify(sandbox));
  }
});

/** A host with an empty home of its own, set as the project's target with no worker named yet. */
async function freshHost(foreign = false) {
  const home = path.join(folder, `home-${Date.now()}`);
  await mkdir(home);
  await writeFile(path.join(binaries, "ssh.home"), home);
  if (foreign) await writeFile(path.join(binaries, "ssh.foreign"), "");
  else await rm(path.join(binaries, "ssh.foreign"), { force: true });
  const local = path.join(folder, `paired-${Date.now()}`); await mkdir(local);
  const project = await api("POST", "/projects", { path: local, grant: true });
  const route = `/projects/${project.id}/research`;
  await api("PUT", `${route}/remote`, { host: "fixture-host", workdir: remote, program: "saturn-server" });
  const { version } = await (await fetch(`${origin}/health`)).json();
  return { home, route, version, installed: path.join(home, ".saturn", "worker", version, "saturn-server") };
}

/** A request that must fail, and its status and message. */
async function refusedWith(method, route, body) {
  const response = await fetch(origin + route, { method, headers: { "content-type": "application/json", authorization: `Bearer ${(await readFile(path.join(data, "runtime-token"), "utf8")).trim()}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, error: (await response.json()).error };
}

const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

test("connecting finds no worker, installing one from this computer pairs with it, and runs then use it", { skip: process.platform === "win32" }, async () => {
  const { home, route, version, installed } = await freshHost();
  try {
    const missing = await api("POST", `${route}/remote/pair`, {});
    assert.deepEqual([missing.state, missing.source, missing.version, missing.path], ["missing", "this computer", version, installed]);
    const ready = await api("POST", `${route}/remote/install`, {});
    assert.deepEqual([ready.state, ready.installed, ready.sha256], ["ready", true, await sha(worker)]);
    assert.equal(await sha(installed), await sha(worker), "the host has exactly this Saturn's program");
    assert.equal((await api("GET", `${route}/remote`)).target.program, installed, "pairing names the worker for runs");
    assert.equal((await api("POST", `${route}/remote/check`, {})).version, version);
    assert.equal((await api("POST", `${route}/remote/pair`, {})).state, "ready", "connecting again finds it ready");
  } finally {
    await rm(path.join(binaries, "ssh.home"), { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a host of another kind gets the release's worker only if it is the one Saturn was built with", { skip: process.platform === "win32" }, async () => {
  const { home, route, installed } = await freshHost(true);
  try {
    const missing = await api("POST", `${route}/remote/pair`, {});
    assert.deepEqual([missing.state, missing.source, missing.system], ["missing", "release", "Linux"]);
    served = Buffer.from("#!/bin/sh\necho not saturn\n");
    const refused = await refusedWith("POST", `${route}/remote/install`, {});
    assert.equal(refused.status, 502);
    assert.match(refused.error, /not the one this Saturn was built with/);
    assert.equal(existsSync(installed), false, "nothing was sent to the host");
    served = await readFile(worker);
    const ready = await api("POST", `${route}/remote/install`, {});
    assert.equal(ready.state, "ready");
    assert.equal(await sha(installed), await sha(worker));
  } finally {
    served = undefined;
    await rm(path.join(binaries, "ssh.foreign"), { force: true });
    await rm(path.join(binaries, "ssh.home"), { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a worker of another version is found as such, refused for runs, and replaced by installing", { skip: process.platform === "win32" }, async () => {
  const { home, route, installed } = await freshHost();
  try {
    // An older worker: it answers a check without a version, as workers did before versions were told.
    await mkdir(path.dirname(installed), { recursive: true });
    await writeFile(installed, `#!/bin/sh\nprintf '%s' '{"protocol":1,"platform":"linux","workdir":"${remote}"}'\n`);
    await chmod(installed, 0o755);
    const old = await api("POST", `${route}/remote/pair`, {});
    assert.equal(old.state, "wrong_version");
    assert.equal((await api("GET", `${route}/remote`)).target.program, "saturn-server", "another version is not paired with");
    await api("PUT", `${route}/remote`, { host: "fixture-host", workdir: remote, program: installed });
    const check = await refusedWith("POST", `${route}/remote/check`, {});
    assert.equal(check.status, 409);
    assert.match(check.error, /not Saturn/);
    assert.equal((await api("POST", `${route}/remote/install`, {})).state, "ready");
    assert.equal(await sha(installed), await sha(worker));
  } finally {
    await rm(path.join(binaries, "ssh.home"), { force: true });
    await rm(home, { recursive: true, force: true });
  }
});
