// The sandbox an experiment run's program runs in: it reads its snapshot, writes only its own records, output and
// temporary folders, cannot read the project it came from, Saturn's data or the credential folders, uses the network
// only when its version allows, and gets only the environment variables the version names. docs/research-contract.md
// ("Run sandbox") is the contract. Where this computer has no working sandbox the runs say so and these tests say
// why they were skipped.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, until } from "./files-support.mjs";

let saturn;
let home;
before(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-sandbox-home-")));
  await mkdir(path.join(home, ".ssh"));
  await writeFile(path.join(home, ".ssh", "id_test"), "PRIVATE KEY");
  await mkdir(path.join(home, ".cache", "huggingface"), { recursive: true });
  await writeFile(path.join(home, ".cache", "huggingface", "token"), "hf_secret");
  saturn = await bench({ env: { HOME: home, SANDBOX_TEST_SECRET_TOKEN: "hunter2", SANDBOX_TEST_DECLARED: "given" } });
});
after(async () => {
  await saturn?.stop();
  await rm(home, { recursive: true, force: true });
});

/** The names of the actions each generated script tries, in order, kept out of the script itself. */
const actionNames = new Map();

/**
 * A script that tries each named action and records whether it worked, by position, then writes one sample. Each
 * action is the body of an async function given `fs` (node:fs/promises) and `env`; the names stay with the test.
 */
const tries = (actions) => {
  const bodies = Object.values(actions);
  const script = `
import * as fs from "node:fs/promises";
const env = process.env;
const results = [];
${bodies.map((body) => `try { results.push(await (async () => { ${body} })() ?? true); } catch (error) { results.push("refused: " + (error.code ?? error.message)); }`).join("\n")}
await fs.writeFile(env.SATURN_RUN_OUTPUT + "/results.json", JSON.stringify(results));
await fs.appendFile(env.SATURN_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: "a", input: "in", output: "out", scores: { s: 1 }, error: null }) + "\\n");
`;
  actionNames.set(script, Object.keys(actions));
  return script;
};

/** A project whose experiment runs `script`, with these experiment fields. */
async function setup(script, fields = {}) {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "probe.mjs"), script);
  await writeFile(path.join(folder, "notes.txt"), "not part of the version");
  await mkdir(path.join(folder, "env"));
  await writeFile(path.join(folder, "env", "tool.txt"), "an environment folder");
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"] }, ...fields });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  return { folder, route, version, experiment };
}

let clients = 0;
/** Runs the version to its end and returns the run, its evidence and what the script recorded. */
async function run(bed) {
  const started = await saturn.api("POST", `${bed.route}/versions/${bed.version.id}/runs`, { clientId: `sandbox-${clients += 1}` });
  const ended = await until(`run ${started.id} to end`, () => saturn.api("GET", `${bed.route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status));
  const evidence = await saturn.api("GET", `${bed.route}/runs/${started.id}/evidence`);
  const directory = path.join(bed.folder, ".saturn/research/runs", started.id);
  const recorded = JSON.parse(await readFile(path.join(directory, "written", "results.json"), "utf8").catch(() => "[]"));
  const script = await readFile(path.join(bed.folder, "probe.mjs"), "utf8");
  const results = Object.fromEntries((actionNames.get(script) ?? []).map((name, index) => [name, recorded[index]]));
  return { run: ended, evidence, results, directory };
}

/** Skips the rest of a test, saying why, when this computer could not sandbox the run. */
function sandboxed(t, evidence) {
  const sandbox = evidence.observed.sandbox;
  if (sandbox.isolation === "sandbox") return true;
  t.skip(`no sandbox here: ${sandbox.unavailable}`);
  return false;
}

const refused = (value) => typeof value === "string" && value.startsWith("refused");

test("a sandboxed run writes only its output and temporary folders, never its snapshot or the project", posixOnly, async (t) => {
  const bed = await setup(tries({
    snapshot: "await fs.writeFile('probe.mjs', 'changed'); return 'wrote';",
    newFile: "await fs.writeFile('made.txt', 'x'); return 'wrote';",
    temporary: "await fs.writeFile(env.TMPDIR + '/scratch.txt', 'x'); return 'wrote';",
    output: "await fs.writeFile(env.SATURN_RUN_OUTPUT + '/model.bin', 'weights'); return 'wrote';",
  }));
  const before = await readFile(path.join(bed.folder, "probe.mjs"), "utf8");
  const { run: ended, evidence, results, directory } = await run(bed);
  if (!sandboxed(t, evidence)) return;
  assert.equal(ended.status, "completed", JSON.stringify(ended));
  assert.ok(refused(results.snapshot), JSON.stringify(results));
  assert.ok(refused(results.newFile), "the snapshot takes no new files either");
  assert.equal(results.temporary, "wrote");
  assert.equal(results.output, "wrote");
  assert.equal(await readFile(path.join(directory, "written", "model.bin"), "utf8"), "weights");
  assert.equal(await readFile(path.join(bed.folder, "probe.mjs"), "utf8"), before, "the project's file is untouched");
  assert.equal(evidence.verdicts.inputs, "partial", "the environment folder beside the version is uncontrolled");
  assert.equal(evidence.observed.snapshot.isolation, "sandbox");
  assert.ok(["seatbelt", "bubblewrap"].includes(evidence.observed.sandbox.mechanism));
  assert.equal(evidence.observed.sandbox.network, "allowed");
});

test("a sandboxed run cannot write into its project by the project's path", posixOnly, async (t) => {
  const bed = await setup("");
  const escaped = path.join(bed.folder, "escaped.txt");
  await writeFile(path.join(bed.folder, "probe.mjs"), tries({ project: `await fs.writeFile(${JSON.stringify(escaped)}, 'x'); return 'wrote';` }));
  const version = await saturn.api("POST", `${bed.route}/experiments/${bed.experiment.id}/versions`, {});
  const { evidence } = await run({ ...bed, version });
  if (!sandboxed(t, evidence)) return;
  assert.equal(existsSync(escaped), false, "nothing reached the project");
});

test("a sandboxed run cannot read the project's own files, its records, Saturn's data or the credential folders, but reads what the snapshot links to", posixOnly, async (t) => {
  const bed = await setup("");
  await writeFile(path.join(bed.folder, "probe.mjs"), tries({
    live: `return await fs.readFile(${JSON.stringify(path.join(bed.folder, "probe.mjs"))}, 'utf8');`,
    listing: `return (await fs.readdir(${JSON.stringify(bed.folder)})).join(",");`,
    records: `return (await fs.readdir(${JSON.stringify(path.join(bed.folder, ".saturn", "research"))})).join(",");`,
    key: `return await fs.readFile(${JSON.stringify(path.join(home, ".ssh", "id_test"))}, 'utf8');`,
    hfToken: `return await fs.readFile(${JSON.stringify(path.join(home, ".cache", "huggingface", "token"))}, 'utf8');`,
    cache: `await fs.writeFile(${JSON.stringify(path.join(home, ".cache", "probe.txt"))}, 'x'); return 'wrote';`,
    data: `return (await fs.readdir(${JSON.stringify(saturn.runtime.dataDir)})).join(",");`,
    linked: "return await fs.readFile('env/tool.txt', 'utf8');",
    beside: "return await fs.readFile('notes.txt', 'utf8');",
  }));
  const experiment = await saturn.api("GET", `${bed.route}/experiments/${bed.experiment.id}`);
  const version = await saturn.api("POST", `${bed.route}/experiments/${experiment.id}/versions`, {});
  const { evidence, results } = await run({ ...bed, version });
  if (!sandboxed(t, evidence)) return;
  // macOS refuses the listing; Linux shows an empty stand-in holding only what the run may reach.
  const shows = (value, name) => !refused(value) && String(value).split(",").includes(name);
  assert.ok(refused(results.live), `the project's own copy of a file the version holds: ${JSON.stringify(results)}`);
  assert.ok(!shows(results.records, "experiments") && !shows(results.records, "versions"), JSON.stringify(results));
  assert.ok(!shows(results.listing, "probe.mjs"), JSON.stringify(results));
  assert.ok(refused(results.key), JSON.stringify(results));
  assert.ok(refused(results.hfToken), `a token in the shared cache stays hidden: ${JSON.stringify(results)}`);
  assert.equal(results.cache, "wrote", "the shared cache itself stays writable");
  assert.ok(!shows(results.data, "runtime-token"), JSON.stringify(results));
  assert.equal(results.linked, "an environment folder");
  assert.equal(results.beside, "not part of the version", "what the project has beside the version stays reachable, as uncontrolled");
});

test("a sandboxed run cannot change the records Saturn keeps about it", posixOnly, async (t) => {
  const bed = await setup(tries({
    run: "await fs.writeFile(env.SATURN_RUN_DIRECTORY + '/run.json', '{}'); return 'wrote';",
    evidence: "await fs.writeFile(env.SATURN_RUN_DIRECTORY + '/evidence.json', '{}'); return 'wrote';",
    removed: "await fs.rm(env.SATURN_RUN_DIRECTORY + '/evidence.json'); return 'removed';",
  }));
  const { run: ended, evidence, results } = await run(bed);
  if (!sandboxed(t, evidence)) return;
  assert.ok(refused(results.run), JSON.stringify(results));
  assert.ok(refused(results.evidence), JSON.stringify(results));
  assert.ok(refused(results.removed), JSON.stringify(results));
  assert.equal(ended.status, "completed");
  assert.equal(evidence.recorded, true);
});

test("the network is the version's to allow: blocked, the program cannot connect", posixOnly, async (t) => {
  const server = createServer((request, response) => response.end("reached"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const script = tries({ fetch: `return await (await fetch(${JSON.stringify(url)})).text();` });
    const open = await run(await setup(script));
    if (!sandboxed(t, open.evidence)) return;
    assert.equal(open.results.fetch, "reached");
    const closed = await run(await setup(script, { sandbox: { network: false } }));
    assert.ok(refused(closed.results.fetch), JSON.stringify(closed.results));
    assert.equal(closed.evidence.observed.sandbox.network, "blocked");
    assert.deepEqual(closed.evidence.expected.sandbox ?? null, null, "what was expected stays as the version recorded it");
  } finally {
    server.close();
  }
});

test("a sandboxed program gets the variables its version names, not the others", posixOnly, async () => {
  const script = tries({
    secret: "return env.SANDBOX_TEST_SECRET_TOKEN ?? 'unset';",
    declared: "return env.SANDBOX_TEST_DECLARED ?? 'unset';",
    path: "return Boolean(env.PATH);",
    data: "return env.SATURN_DATA_DIR ?? 'unset';",
  });
  const { evidence, results } = await run(await setup(script, { envNames: ["SANDBOX_TEST_DECLARED", "SANDBOX_TEST_MISSING"] }));
  assert.equal(results.secret, "unset");
  assert.equal(results.declared, "given");
  assert.equal(results.path, true);
  assert.equal(results.data, "unset");
  const environment = evidence.observed.sandbox.environment;
  assert.ok(environment.passed.includes("SANDBOX_TEST_DECLARED"));
  assert.ok(!environment.passed.includes("SANDBOX_TEST_SECRET_TOKEN"), "names are recorded, and only the passed ones");
  assert.deepEqual(environment.missing, ["SANDBOX_TEST_MISSING"]);
  assert.ok(!JSON.stringify(evidence).includes("hunter2"), "no value is recorded");
});

test("a version with the sandbox off runs as before, and its evidence says so", posixOnly, async () => {
  const bed = await setup(tries({
    secret: "return env.SANDBOX_TEST_SECRET_TOKEN ?? 'unset';",
    newFile: "await fs.writeFile('made.txt', 'x'); return 'wrote';",
  }), { sandbox: { isolated: false } });
  assert.deepEqual(bed.version.sandbox, { isolated: false });
  const { run: ended, evidence, results, directory } = await run(bed);
  assert.equal(ended.status, "completed");
  assert.equal(results.secret, "hunter2");
  assert.equal(results.newFile, "wrote");
  assert.equal(await readFile(path.join(directory, "written", "made.txt"), "utf8"), "x");
  assert.equal(evidence.observed.sandbox.requested, false);
  assert.equal(evidence.observed.snapshot.isolation, "read-only permissions");
});

test("an experiment's sandbox holds only its two switches, and envNames only variable names", async () => {
  const bed = await setup(tries({}));
  const change = (fields) => saturn.call("PATCH", `${bed.route}/experiments/${bed.experiment.id}`, { expectedRevision: bed.experiment.revision, ...fields });
  assert.equal((await change({ sandbox: { network: "no" } })).status, 400);
  assert.equal((await change({ sandbox: { mounts: ["/"] } })).status, 400);
  assert.equal((await change({ envNames: ["NOT A NAME"] })).status, 400);
  assert.equal((await change({ envNames: ["SATURN_RUNTIME_TOKEN"] })).status, 400);
});
