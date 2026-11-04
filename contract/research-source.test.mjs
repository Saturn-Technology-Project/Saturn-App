// What the research workbench's editor and sample list read and write. docs/research-contract.md is the contract.
import assert from "node:assert/strict";
import { mkdir, readFile, stat, chmod, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, sha, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

async function project(files = {}) {
  const folder = await saturn.folder();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), content);
  }
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  return { folder, route: `/projects/${made.id}/research` };
}

const open = (route, file) => saturn.call("GET", `${route}/source?path=${encodeURIComponent(file)}`);
const save = (route, body) => saturn.call("PUT", `${route}/source`, body);

test("a folder lists its entries without Saturn's records or git's folder", async () => {
  const { route } = await project({ "b.py": "b", "src/a.py": "a", ".git/config": "x" });
  await saturn.api("POST", `${route}/questions`, { title: "Q" });
  const listed = (await open(route, ".")).body;
  assert.equal(listed.kind, "directory");
  assert.deepEqual(listed.entries.map((entry) => [entry.path, entry.kind]), [[".saturn", "directory"], ["src", "directory"], ["b.py", "file"]]);
  assert.deepEqual((await open(route, ".saturn")).body.entries, []);
  assert.equal((await open(route, ".saturn/research/questions")).status, 403);
  assert.equal((await open(route, ".git/config")).status, 403);
});

test("a save needs the revision it was opened at, so it cannot overwrite a change it has not seen", async () => {
  const { route, folder } = await project({ "probe.py": "one\n" });
  const opened = (await open(route, "probe.py")).body;
  assert.equal(opened.content, "one\n");
  assert.equal(opened.revision, sha("one\n"));

  const saved = await save(route, { path: "probe.py", content: "two\n", expectedRevision: opened.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.revision, sha("two\n"));
  assert.equal(await readFile(path.join(folder, "probe.py"), "utf8"), "two\n");

  const stale = await save(route, { path: "probe.py", content: "three\n", expectedRevision: opened.revision });
  assert.equal(stale.status, 409);
  assert.equal(await readFile(path.join(folder, "probe.py"), "utf8"), "two\n");

  await writeFile(path.join(folder, "probe.py"), "by an agent\n");
  assert.equal((await save(route, { path: "probe.py", content: "four\n", expectedRevision: saved.body.revision })).status, 409);
  assert.equal(await readFile(path.join(folder, "probe.py"), "utf8"), "by an agent\n");
});

test("a new file needs no revision, and an existing one cannot be replaced as if new", async () => {
  const { route, folder } = await project({ "old.py": "old\n" });
  assert.equal((await save(route, { path: "new/dir/fresh.py", content: "x\n" })).status, 200);
  assert.equal(await readFile(path.join(folder, "new/dir/fresh.py"), "utf8"), "x\n");
  assert.equal((await save(route, { path: "old.py", content: "y\n" })).status, 409);
});

test("saving keeps a file's permissions", posixOnly, async () => {
  const { route, folder } = await project({ "run.sh": "a\n" });
  await chmod(path.join(folder, "run.sh"), 0o755);
  await save(route, { path: "run.sh", content: "b\n", expectedRevision: sha("a\n") });
  assert.equal((await stat(path.join(folder, "run.sh"))).mode & 0o777, 0o755);
});

test("the editor cannot reach outside the project, or write the records", posixOnly, async () => {
  const { route, folder } = await project({ "probe.py": "a" });
  const elsewhere = await saturn.folder();
  await writeFile(path.join(elsewhere, "secret.txt"), "secret");
  await symlink(path.join(elsewhere, "secret.txt"), path.join(folder, "linked.txt"));
  assert.equal((await open(route, "../secret.txt")).status, 403);
  assert.equal((await open(route, "linked.txt")).status, 403);
  assert.equal((await save(route, { path: "linked.txt", content: "x", expectedRevision: sha("secret") })).status, 403);
  assert.equal(await readFile(path.join(elsewhere, "secret.txt"), "utf8"), "secret");
  assert.equal((await save(route, { path: ".saturn/research/questions/q.json", content: "{}" })).status, 403);
});

test("binary and very large files say they cannot be opened", async () => {
  const { route, folder } = await project();
  await writeFile(path.join(folder, "weights.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  await writeFile(path.join(folder, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal((await open(route, "weights.bin")).status, 415);
  assert.equal((await open(route, "big.txt")).status, 413);
  assert.equal((await open(route, "missing.txt")).status, 404);
});

/** A project with a run that wrote these lines; `script` overrides how. */
async function runWith(lines, code = 0) {
  const script = `
    import { appendFileSync } from "node:fs";
    for (const text of ${JSON.stringify(lines)}) appendFileSync(process.env.SATURN_RUN_SAMPLES, text);
    console.log("hello from the run");
    console.error("a warning");
    process.exit(${code});
  `;
  const bed = await project({ "probe.mjs": script });
  const experiment = await saturn.api("POST", `${bed.route}/experiments`, { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"] } });
  const version = await saturn.api("POST", `${bed.route}/experiments/${experiment.id}/versions`, {});
  const started = await saturn.api("POST", `${bed.route}/versions/${version.id}/runs`, { clientId: "one" });
  const run = await until("the run to end", () => saturn.api("GET", `${bed.route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status));
  return { ...bed, run };
}

const sampleLine = (id) => `${JSON.stringify({ schemaVersion: 1, sampleId: id, input: "i", output: "瑪麗", scores: { s: 1 } })}\n`;

test("samples come a page at a time, from a cursor, to the end", posixOnly, async () => {
  const { route, run } = await runWith(Array.from({ length: 5 }, (_, index) => sampleLine(`s${index}`)));
  const page = (cursor, limit) => saturn.api("GET", `${route}/runs/${run.id}/samples?cursor=${cursor}&limit=${limit}`);
  const first = await page(0, 2);
  assert.deepEqual(first.items.map((item) => item.sample.sampleId), ["s0", "s1"]);
  assert.equal(first.items[0].sample.output, "瑪麗");
  const second = await page(first.next, 2);
  assert.deepEqual(second.items.map((item) => item.sample.sampleId), ["s2", "s3"]);
  const third = await page(second.next, 2);
  assert.deepEqual(third.items.map((item) => item.sample.sampleId), ["s4"]);
  assert.equal(third.next, null);
});

test("a position that is not the start of a sample is refused", posixOnly, async () => {
  const { route, run } = await runWith([sampleLine("a"), sampleLine("b")]);
  assert.equal((await saturn.call("GET", `${route}/runs/${run.id}/samples?cursor=3`)).status, 400);
  assert.equal((await saturn.call("GET", `${route}/runs/${run.id}/samples?cursor=999999`)).status, 400);
  assert.equal((await saturn.call("GET", `${route}/runs/run_nothere/samples`)).status, 404);
});

test("a bad line is shown as a problem with its raw text, in its place", posixOnly, async () => {
  const { route, run } = await runWith([sampleLine("a"), "not json\n", sampleLine("b")]);
  const { items } = await saturn.api("GET", `${route}/runs/${run.id}/samples`);
  assert.equal(items.length, 3);
  assert.equal(items[1].raw, "not json\n");
  assert.match(items[1].problem, /not JSON/);
});

test("what is written after a run was sealed does not count", posixOnly, async () => {
  const { route, run, folder } = await runWith([sampleLine("a")]);
  const file = path.join(folder, ".saturn/research/runs", run.id, "samples.jsonl");
  await writeFile(file, await readFile(file, "utf8") + sampleLine("late"));
  const { items } = await saturn.api("GET", `${route}/runs/${run.id}/samples`);
  assert.deepEqual(items.map((item) => item.sample.sampleId), ["a"]);
});

test("a run's logs can be read", posixOnly, async () => {
  const { route, run } = await runWith([sampleLine("a")]);
  assert.equal((await saturn.api("GET", `${route}/runs/${run.id}/log?stream=stdout`)).text.trim(), "hello from the run");
  assert.equal((await saturn.api("GET", `${route}/runs/${run.id}/log?stream=stderr`)).text.trim(), "a warning");
  assert.equal((await saturn.call("GET", `${route}/runs/${run.id}/log?stream=../run.json`)).status, 404);
});
