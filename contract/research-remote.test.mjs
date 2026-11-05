// The SSH stand-in runs the real Rust worker on another temporary folder. No user host, key or model is used.
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";
import { until } from "./files-support.mjs";

let runtime, folder, remote, binaries, data, origin;
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
  await writeFile(fake, '#!/bin/sh\nif [ -f "$0.offline" ]; then exit 255; fi\nprintf "%s\\n" "$@" > "$0.args"\nfor remote_command do :; done\nexec /bin/sh -c "$remote_command"\n');
  await chmod(fake, 0o755);
  runtime = await startRuntime({ dataDir: data, keepData: true, env: { PATH: `${binaries}:${process.env.PATH}` } });
  origin = runtime.origin;
});
after(async () => { await runtime?.stop(); await rm(folder, { recursive: true, force: true }); });

/** A configured remote experiment, whose code already lives on the other machine. */
async function experiment(command, kind = "evaluation") {
  const local = path.join(folder, `local-${Date.now()}`); await mkdir(local);
  const project = await api("POST", "/projects", { path: local, grant: true });
  const route = `/projects/${project.id}/research`;
  await api("PUT", `${route}/remote`, { host: "fixture-host", workdir: remote, program: worker });
  const draft = await api("POST", `${route}/experiments`, { title: "Remote", command, kind });
  const version = await api("POST", `${route}/experiments/${draft.id}/versions`, {});
  return { route, version };
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
  runtime = await startRuntime({ dataDir: data, keepData: true, env: { PATH: `${binaries}:${process.env.PATH}` } }); origin = runtime.origin;
  const ended = await until("remote finish after reconnect", () => api("GET", `${route}/runs/${run.id}`), (item) => item.status === "completed", 30);
  assert.equal(ended.samples, 12);
  assert.equal((await api("GET", `${route}/runs/${run.id}/samples`)).items.length, 12);
  const outputs = await api("POST", `${route}/artifacts/from-run`, { runId: run.id });
  assert.equal(outputs.items.length, 1);
  const content = await api("GET", `${route}/artifacts/${outputs.items[0].id}/content`);
  assert.deepEqual(JSON.parse(Buffer.from(content.data, "base64").toString()), { framework: "NNsight", result: [1, 2] });
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

test("remote settings reject command-like host names and do not disable host verification", async () => {
  const project = await api("POST", "/projects", { path: remote, grant: true });
  const route = `/projects/${project.id}/research/remote`;
  const response = await fetch(origin + route, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${(await readFile(path.join(data, "runtime-token"), "utf8")).trim()}` }, body: JSON.stringify({ host: "-oProxyCommand=bad", workdir: remote, program: worker }) });
  assert.equal(response.status, 400);
  if (process.platform !== "win32") {
    const args = await readFile(path.join(binaries, "ssh.args"), "utf8");
    assert.match(args, /BatchMode=yes/);
    assert.equal(args.includes("StrictHostKeyChecking=no"), false);
    assert.equal(args.includes("UserKnownHostsFile=/dev/null"), false);
  }
});
