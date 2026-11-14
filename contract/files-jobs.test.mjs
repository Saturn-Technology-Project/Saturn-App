// Background commands a chat's agent starts: they return at once, the agent reads and stops them with its tools, the app
// lists and stops them, and they belong to their chat.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bench, command, idle, node, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

/** Whether a process is still there. */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A command that stays for a minute unless it is stopped. */
const WAITING = idle(60);

const gone = (pid) => until(`process ${pid} to end`, () => !alive(pid));
const jobs = (thread) => saturn.api("GET", `/threads/${thread.id}/jobs`);

test("a background command returns at once, and the agent can read it, wait for it and see it end", async () => {
  const setup = await saturn.chat();
  const started = await setup.turn([command(node("let i = 0; const timer = setInterval(() => { i += 1; console.log('tick' + i); if (i === 3) { clearInterval(timer); console.log('end'); } }, 200)"), { background: true })]);
  const job = started.actions[0].result;
  assert.match(job.jobId, /^job_/);
  assert.equal(job.running, true);
  assert.match(job.note, /code_output/);

  const read = await setup.turn([["code_output", { jobId: job.jobId, wait: 5000 }]]);
  assert.equal(read.actions[0].status, "completed", read.actions[0].reason);
  assert.equal(read.actions[0].result.jobId, job.jobId);
  const ended = await until("the command to end", async () => (await setup.turn([["code_output", { jobId: job.jobId, wait: 200 }]])).actions[0].result, (item) => !item.running);
  assert.equal(ended.exitCode, 0);
  assert.match(ended.output, /tick1[\s\S]*tick3[\s\S]*end/);
});

test("a background command that fails at once comes back with its exit code", async () => {
  const setup = await saturn.chat();
  const run = await setup.turn([command("exit 3", { background: true })]);
  let { running, exitCode, jobId } = run.actions[0].result;
  // Windows's sandbox opens the chat's folder to the command before it starts it, which can take longer than the
  // first look at a background command waits; the job then says how it ended.
  if (process.platform === "win32" && running) {
    ({ running, exitCode } = await until("the command to end", async () => (await jobs(setup.thread)).find((job) => job.id === jobId), (job) => job && !job.running));
  }
  assert.equal(running, false);
  assert.equal(exitCode, 3);
});

test("the app lists a chat's background commands and stops them, with the processes they started", async () => {
  const setup = await saturn.chat();
  const other = await setup.newThread("Another chat");
  assert.deepEqual(await jobs(setup.thread), []);
  const run = await setup.turn([command(WAITING, { background: true })]);
  const { jobId, pid } = run.actions[0].result;
  assert.ok(alive(pid));
  const listed = await jobs(setup.thread);
  assert.deepEqual(listed.map((job) => [job.id, job.running, job.command]), [[jobId, true, WAITING]]);
  assert.deepEqual(await jobs(other), [], "jobs are per chat");

  const wrongChat = await saturn.call("POST", `/threads/${other.id}/jobs/${jobId}/stop`);
  assert.equal(wrongChat.status, 404);
  assert.match(wrongChat.body.error, /No such background command/);
  assert.equal((await saturn.call("POST", `/threads/${setup.thread.id}/jobs/job_none/stop`)).status, 404);
  assert.ok(alive(pid), "still running");

  assert.equal((await saturn.api("POST", `/threads/${setup.thread.id}/jobs/${jobId}/stop`)).id, jobId);
  await gone(pid);
  await until("the list to show it ended", () => jobs(setup.thread), ([job]) => job.running === false);
});

test("the agent stops its own command with code_stop, and an unknown one is refused", async () => {
  const setup = await saturn.chat();
  const run = await setup.turn([command(WAITING, { background: true })]);
  const { jobId, pid } = run.actions[0].result;
  assert.ok(alive(pid));

  const unknown = await setup.turn([["code_output", { jobId: "job_nope" }], ["code_stop", { jobId: "job_nope" }]]);
  assert.deepEqual(unknown.actions.map((action) => action.status), ["failed", "failed"]);
  assert.match(unknown.actions[0].reason, /No background command/);
  assert.match(unknown.actions[1].reason, /No background command/);
  assert.ok(alive(pid));

  const stopped = await setup.turn([["code_stop", { jobId }]]);
  assert.equal(stopped.actions[0].status, "completed", stopped.actions[0].reason);
  assert.equal(stopped.actions[0].result.stopped, true);
  await gone(pid);
});

test("deleting a chat ends what its background commands still run", async () => {
  const setup = await saturn.chat();
  const run = await setup.turn([command(WAITING, { background: true })]);
  const { pid } = run.actions[0].result;
  assert.ok(alive(pid));
  await saturn.api("DELETE", `/threads/${setup.thread.id}`);
  await gone(pid);
});

test("a chat runs at most eight background commands at once", async () => {
  const setup = await saturn.chat();
  const start = command(idle(30), { background: true });
  const run = await setup.turn(Array.from({ length: 9 }, () => start));
  assert.deepEqual(run.actions.map((action) => action.status), [...Array(8).fill("completed"), "failed"]);
  assert.match(run.actions[8].reason, /already runs 8 background commands/);
  const pids = run.actions.slice(0, 8).map((action) => action.result.pid);
  await saturn.api("DELETE", `/threads/${setup.thread.id}`);
  await Promise.all(pids.map(gone));
});

test("a chat cannot read or stop another chat's background command through the agent's tools", async () => {
  const setup = await saturn.chat();
  const run = await setup.turn([command(WAITING, { background: true })]);
  const { jobId, pid } = run.actions[0].result;
  const other = await saturn.chat();
  const tried = await other.turn([["code_output", { jobId }], ["code_stop", { jobId }]]);
  for (const action of tried.actions) {
    assert.equal(action.status, "failed", JSON.stringify(action));
    assert.match(action.reason, /No background command/);
    assert.ok(!JSON.stringify(action.result ?? "").includes("setTimeout"));
  }
  assert.ok(alive(pid), "it keeps running");
  await saturn.api("POST", `/threads/${setup.thread.id}/jobs/${jobId}/stop`);
});
