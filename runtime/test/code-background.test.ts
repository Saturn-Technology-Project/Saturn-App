import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Workspace } from "../src/domain/skills/workspace.js";
import { JobTable, MAX_JOBS } from "../src/infrastructure/jobs.js";
import { CodeSkill } from "../src/infrastructure/skills/code-skill.js";

type Started = { jobId: string; pid?: number; running: boolean; output: string; note: string };
type Output = { jobId: string; running: boolean; exitCode?: number | null; output: string };

const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Commands both shells (sh and cmd) run the same way: node scripts in double quotes, no $ or %. */
const node = (script: string) => `"${process.execPath}" -e "${script}"`;
const TICKS = node("let i=0;const t=setInterval(()=>{console.log('tick'+(++i));if(i===3){clearInterval(t);console.log('end')}},200)");
const WAIT = (seconds: number) => node(`setTimeout(()=>{},${seconds * 1000})`);

test("a background command returns at once, its output can be read and waited for, and it can be stopped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "saturn-jobs-"));
  const table = new JobTable();
  const skill = new CodeSkill(new Workspace(root));
  const options = { sandbox: { mode: "off" as const, network: true }, jobs: { table, scope: "thread_1" } };
  try {
    const started = (await skill.run({ command: TICKS, background: true }, undefined, options)) as Started;
    assert.match(started.jobId, /^job_/);
    assert.equal(started.running, true);
    assert.match(started.note, /code_output/);

    const partial = (await skill.output({ jobId: started.jobId, wait: 400 }, options)) as Output;
    assert.match(partial.output, /tick1/);
    const done = (await skill.output({ jobId: started.jobId, wait: 5_000 }, options)) as Output;
    for (let attempt = 0; attempt < 50 && (await skill.output({ jobId: started.jobId, wait: 200 }, options) as Output).running; attempt += 1) {
      // Until the loop ends.
    }
    const final = (await skill.output({ jobId: started.jobId }, options)) as Output;
    assert.equal(final.running, false);
    assert.equal(final.exitCode, 0);
    assert.match(final.output, /tick1[\s\S]*tick3[\s\S]*end/);
    assert.ok(done.output.length >= partial.output.length);

    // A long one is stopped, together with the process the shell started.
    const long = (await skill.run({ command: WAIT(60), background: true }, undefined, options)) as Started;
    assert.equal(long.running, true);
    assert.ok(alive(long.pid));
    const stopped = (await skill.stop({ jobId: long.jobId }, options)) as { stopped: boolean };
    assert.equal(stopped.stopped, true);
    for (let attempt = 0; attempt < 50 && table.get(long.jobId)?.running; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(table.get(long.jobId)?.running, false);
    for (let attempt = 0; attempt < 50 && alive(long.pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!alive(long.pid), "the shell is gone");

    // A command that fails at once comes back with its error and exit code.
    const failed = (await skill.run({ command: "exit 3", background: true }, undefined, options)) as Started & { exitCode?: number };
    assert.equal(failed.running, false);
    assert.equal(failed.exitCode, 3);

    // Jobs are per chat: another chat cannot read them, and deleting the chat ends what is left.
    await assert.rejects(skill.output({ jobId: "job_nope" }, options), /No background command/);
    const list = table.list("thread_1");
    assert.ok(list.some((job) => job.id === started.jobId));
    assert.deepEqual(table.list("thread_2"), []);
    const server = (await skill.run({ command: WAIT(60), background: true }, undefined, options)) as Started;
    assert.equal(table.stopAll("thread_1"), 1, "one job was still running");
    assert.deepEqual(table.list("thread_1"), []);
    for (let attempt = 0; attempt < 50 && alive(server.pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!alive(server.pid));

    // A cap on running jobs.
    const many: Started[] = [];
    for (let index = 0; index < MAX_JOBS; index += 1) many.push((await skill.run({ command: WAIT(30), background: true }, undefined, options)) as Started);
    await assert.rejects(skill.run({ command: WAIT(30), background: true }, undefined, options), /already runs/);
  } finally {
    table.stopAll();
  }
});

test("without a job table, background and its two tools are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "saturn-jobs-"));
  const skill = new CodeSkill(new Workspace(root));
  await assert.rejects(skill.run({ command: "true", background: true }, undefined, { sandbox: { mode: "off", network: true } }), /not available/);
  await assert.rejects(skill.output({ jobId: "x" }), /not available/);
  await assert.rejects(skill.stop({ jobId: "x" }), /not available/);
});
