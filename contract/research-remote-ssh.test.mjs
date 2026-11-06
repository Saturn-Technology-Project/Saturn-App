// Remote jobs over a real sshd on 127.0.0.1, with one-time host and client keys made for the test. The fake ssh in
// research-remote.test.mjs never ends a session, so it cannot show what a real one does to a detached worker; this can.
// It runs where an sshd binary exists, and is skipped elsewhere. Nothing here reads or changes the user's SSH setup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { until } from "./files-support.mjs";
import { startRuntime } from "./runtime.mjs";

const SSHD = ["/usr/sbin/sshd", "/usr/bin/sshd"].find((candidate) => existsSync(candidate));
const skip = process.platform === "win32" || !SSHD ? "needs an sshd binary" : false;
const worker = path.resolve("target/debug/saturn-server");
let folder, runtime, data, route;

/** A free port on this computer. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A JSON request to the isolated runtime, with its status. */
async function api(method, route, body) {
  const token = (await readFile(path.join(data, "runtime-token"), "utf8")).trim();
  const response = await fetch(runtime.origin + route, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

before(async () => {
  if (skip) return;
  folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-real-ssh-")));
  await chmod(folder, 0o700);
  const bin = path.join(folder, "bin");
  await mkdir(bin);
  await mkdir(path.join(folder, "remote"));
  await mkdir(path.join(folder, "local"));
  const key = (name) => execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(folder, name)]);
  key("host_key");
  key("client_key");
  await writeFile(path.join(folder, "authorized_keys"), await readFile(path.join(folder, "client_key.pub")));
  await chmod(path.join(folder, "authorized_keys"), 0o600);
  const port = await freePort();
  const user = os.userInfo().username;
  await writeFile(path.join(folder, "sshd_config"), [`Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${folder}/host_key`, `AuthorizedKeysFile ${folder}/authorized_keys`, `PidFile ${folder}/sshd.pid`, "UsePAM no", "StrictModes no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", `AllowUsers ${user}`, ""].join("\n"));
  const hostKey = (await readFile(path.join(folder, "host_key.pub"), "utf8")).split(" ").slice(0, 2).join(" ");
  await writeFile(path.join(folder, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`);
  await writeFile(path.join(folder, "ssh_config"), ["Host testhost", "  HostName 127.0.0.1", `  Port ${port}`, `  User ${user}`, `  IdentityFile ${folder}/client_key`, "  IdentitiesOnly yes", `  UserKnownHostsFile ${folder}/known_hosts`, "  GlobalKnownHostsFile /dev/null", ""].join("\n"));
  // Saturn calls plain `ssh`; this one is the real client, given the test's own configuration.
  await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F ${folder}/ssh_config "$@"\n`);
  await chmod(path.join(bin, "ssh"), 0o755);
  // Started as a daemon, as the system's sshd is: one left in the foreground keeps the test's own session, under which
  // a program that fails in a real SSH session, such as macOS's nohup, would still work.
  execFileSync(SSHD, ["-f", path.join(folder, "sshd_config"), "-E", path.join(folder, "sshd.log")]);
  await until("sshd to listen", () => { try { execFileSync(path.join(bin, "ssh"), ["-T", "-oBatchMode=yes", "testhost", "true"]); return true; } catch { return false; } }, Boolean, 20);
  data = path.join(folder, "state");
  runtime = await startRuntime({ dataDir: data, keepData: true, env: { PATH: `${bin}:${process.env.PATH}` } });
  const project = (await api("POST", "/projects", { path: path.join(folder, "local"), grant: true })).body;
  route = `/projects/${project.id}/research`;
  await api("PUT", `${route}/remote`, { host: "testhost", workdir: path.join(folder, "remote"), program: worker });
});

after(async () => {
  await runtime?.stop();
  if (folder) {
    try { process.kill(Number(await readFile(path.join(folder, "sshd.pid"), "utf8"))); } catch { /* not started */ }
    try { execFileSync("pkill", ["-f", path.join(folder, "remote")]); } catch { /* none left */ }
    await rm(folder, { recursive: true, force: true });
  }
});

/** A frozen experiment whose command runs on the other side, with Node by absolute path, since SSH's PATH is short. */
async function version(script) {
  const draft = (await api("POST", `${route}/experiments`, { title: script, command: `${process.execPath} ${script}` })).body;
  return (await api("POST", `${route}/experiments/${draft.id}/versions`, {})).body;
}

test("over a real SSH session a detached job starts, outlives the session, and syncs to the end", { skip }, async () => {
  await writeFile(path.join(folder, "remote", "eval.mjs"), "import { appendFileSync } from 'node:fs'; let n = 0; const t = setInterval(() => { appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: 's' + n, input: 'i', output: 'o', scores: { s: n % 2 } }) + '\\n'); if (++n === 6) clearInterval(t); }, 200);");
  const checked = await api("POST", `${route}/remote/check`, {});
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const run = (await api("POST", `${route}/remote/runs`, { versionId: (await version("eval.mjs")).id, clientId: "real", timeoutSeconds: 60 })).body;
  const ended = await until("the job to end", async () => (await api("GET", `${route}/runs/${run.id}`)).body, (item) => !["starting", "running", "stopping"].includes(item.status), 60);
  assert.equal(ended.status, "completed", ended.remoteError);
  assert.equal(ended.samples, 6);
  // The job's processor and memory were read on the host, and came back with its outputs.
  const resources = (await api("GET", `${route}/runs/${run.id}/resources`)).body;
  assert.ok(resources.points.length >= 1, JSON.stringify(resources));
  assert.ok(resources.points.some((point) => point.memoryBytes > 0), "the job's own memory was read");
  assert.equal(resources.system.host, "testhost", "the readings say which host they came from");
  assert.ok(resources.system.cpus > 0);
});

test("over a real SSH session, stop ends the remote process", { skip }, async () => {
  await writeFile(path.join(folder, "remote", "forever.mjs"), "setInterval(() => {}, 1000);");
  const run = (await api("POST", `${route}/remote/runs`, { versionId: (await version("forever.mjs")).id, clientId: "forever", timeoutSeconds: 600 })).body;
  await until("the job to run", async () => (await api("GET", `${route}/runs/${run.id}`)).body, (item) => item.status === "running", 60);
  await api("POST", `${route}/runs/${run.id}/stop`, {});
  await until("the job to stop", async () => (await api("GET", `${route}/runs/${run.id}`)).body, (item) => item.status === "stopped", 60);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let left = "";
  try { left = execFileSync("pgrep", ["-f", path.join(folder, "remote", "forever.mjs")]).toString(); } catch { /* none */ }
  assert.equal(left.trim(), "", "no process left on the remote side");
});
