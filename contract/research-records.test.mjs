// Research records: plain files in the project that survive concurrent writers and crashes, and frozen versions that
// record what a run would really compute. docs/research-contract.md is the contract.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, commitAll, git, posixOnly, sha } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

/** A new project the user has allowed, with its folder. */
async function project(files = {}) {
  const folder = await saturn.folder();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), content);
  }
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  return { id: made.id, folder, route: `/projects/${made.id}/research` };
}

/** A draft that declares these inputs, with a command to run. */
const draft = (route, inputs = {}, fields = {}) => saturn.api("POST", `${route}/experiments`, {
  title: "E1",
  command: "python probe.py",
  inputs,
  evaluation: { dataset: "ioi-set", split: "test", sampleSet: "all", scorer: "name-logit", promptFormat: "continuation", chatTemplate: null, generation: {} },
  ...fields,
});

const freeze = (route, id, body = {}) => saturn.call("POST", `${route}/experiments/${id}/versions`, body);

test("a record is a plain file in the project, with its identity set by the runtime", async () => {
  const { route, folder } = await project();
  const question = await saturn.api("POST", `${route}/questions`, { title: "When does it appear?", id: "chosen", revision: 99 });
  assert.match(question.id, /^question_[0-9a-f]+$/);
  assert.equal(question.revision, 1);
  assert.equal(question.schemaVersion, 1);
  const saved = JSON.parse(await readFile(path.join(folder, ".saturn/research/questions", `${question.id}.json`), "utf8"));
  assert.deepEqual(saved, question);
  assert.equal(await readFile(path.join(folder, ".saturn/research/.gitignore"), "utf8"), "*\n");
  assert.deepEqual(await saturn.api("GET", `${route}/questions/${question.id}`), question);
  const list = await saturn.api("GET", `${route}/questions`);
  assert.deepEqual(list, { items: [question], problems: [] });
});

test("reading a project with no records creates nothing", async () => {
  const { route, folder } = await project();
  assert.deepEqual(await saturn.api("GET", `${route}/findings`), { items: [], problems: [] });
  assert.equal(existsSync(path.join(folder, ".saturn")), false);
});

test("a change needs the revision it was based on, and of two changes on one revision only one lands", async () => {
  const { route } = await project();
  const question = await saturn.api("POST", `${route}/questions`, { title: "First" });
  const item = `${route}/questions/${question.id}`;
  assert.equal((await saturn.call("PATCH", item, { title: "No revision" })).status, 400);
  const answers = await Promise.all(["A", "B", "C", "D"].map((title) => saturn.call("PATCH", item, { title, expectedRevision: 1 })));
  const statuses = answers.map((answer) => answer.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409], JSON.stringify(answers));
  const landed = answers.find((answer) => answer.status === 200).body;
  assert.equal(landed.revision, 2);
  assert.deepEqual(await saturn.api("GET", item), landed);
});

test("the runtime's fields cannot be changed by a request", async () => {
  const { route } = await project();
  const question = await saturn.api("POST", `${route}/questions`, { title: "First" });
  const changed = await saturn.api("PATCH", `${route}/questions/${question.id}`, { expectedRevision: 1, id: "other", schemaVersion: 7, createdAt: "never", revision: 50, title: "Second" });
  assert.equal(changed.id, question.id);
  assert.equal(changed.schemaVersion, 1);
  assert.equal(changed.createdAt, question.createdAt);
  assert.equal(changed.revision, 2);
  assert.equal(changed.title, "Second");
});

test("each kind of record says what it must hold", async () => {
  const { route } = await project();
  assert.equal((await saturn.call("POST", `${route}/questions`, {})).status, 400);
  const hypothesis = await saturn.api("POST", `${route}/hypotheses`, { title: "It drops" });
  assert.equal(hypothesis.verdict, "undecided");
  assert.equal((await saturn.call("PATCH", `${route}/hypotheses/${hypothesis.id}`, { expectedRevision: 1, verdict: "probably" })).status, 400);
  assert.equal((await saturn.api("PATCH", `${route}/hypotheses/${hypothesis.id}`, { expectedRevision: 1, verdict: "supported" })).verdict, "supported");
  assert.equal((await saturn.call("POST", `${route}/findings`, { text: "x", kind: "rumour" })).status, 400);
  assert.equal((await saturn.api("POST", `${route}/findings`, { text: "x", kind: "observation" })).kind, "observation");
  assert.equal((await saturn.call("POST", `${route}/models`, { name: "no source" })).status, 400);
  assert.equal((await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-14m" })).floating, true);
  assert.equal((await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-14m", weightsRevision: "abc" })).floating, true, "a short name can move");
  assert.equal((await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-14m", weightsRevision: "latest" })).floating, true);
  assert.equal((await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-14m", weightsRevision: "a".repeat(40) })).floating, false);
  assert.equal((await saturn.call("POST", `${route}/rumours`, { title: "x" })).status, 404);
  assert.equal((await saturn.call("POST", `${route}/versions`, { title: "x" })).status, 405);
});

test("a damaged or newer record is reported and never overwritten", async () => {
  const { route, folder } = await project();
  const good = await saturn.api("POST", `${route}/questions`, { title: "Good" });
  const damaged = await saturn.api("POST", `${route}/questions`, { title: "Damaged" });
  const newer = await saturn.api("POST", `${route}/questions`, { title: "Newer" });
  const file = (id) => path.join(folder, ".saturn/research/questions", `${id}.json`);
  await writeFile(file(damaged.id), '{"title":"half');
  const future = JSON.stringify({ ...newer, schemaVersion: 2 });
  await writeFile(file(newer.id), future);

  const list = await saturn.api("GET", `${route}/questions`);
  assert.deepEqual(list.items.map((item) => item.id), [good.id]);
  assert.deepEqual(list.problems.map((item) => item.id).sort(), [damaged.id, newer.id].sort());
  assert.equal((await saturn.call("PATCH", `${route}/questions/${damaged.id}`, { expectedRevision: 1, title: "x" })).status, 422);
  assert.equal(await readFile(file(damaged.id), "utf8"), '{"title":"half');
  assert.equal((await saturn.call("PATCH", `${route}/questions/${newer.id}`, { expectedRevision: 1, title: "x" })).status, 422);
  assert.equal(await readFile(file(newer.id), "utf8"), future);
});

test("no temporary file is left behind", async () => {
  const { route, folder } = await project();
  await Promise.all(Array.from({ length: 12 }, (_, index) => saturn.api("POST", `${route}/questions`, { title: `Q${index}` })));
  assert.equal((await readdir(path.join(folder, ".saturn/research/questions"))).length, 12);
});

test("records need the user's grant, and ids and links cannot lead elsewhere", async () => {
  const folder = await saturn.folder();
  const ungranted = await saturn.api("POST", "/projects", { path: folder });
  assert.equal((await saturn.call("GET", `/projects/${ungranted.id}/research/questions`)).status, 403);
  assert.equal(existsSync(path.join(folder, ".saturn")), false);

  const { route } = await project();
  assert.equal((await saturn.call("GET", `${route}/questions/..%2F..%2Fsecret`)).status, 404);
  assert.equal((await saturn.call("GET", `${route}/questions/question_nothere00000000`)).status, 404);
});

test("a symbolic link at the records folder is refused rather than followed", posixOnly, async () => {
  const { route, folder } = await project();
  const elsewhere = await saturn.folder();
  await symlink(elsewhere, path.join(folder, ".saturn"));
  assert.equal((await saturn.call("POST", `${route}/questions`, { title: "x" })).status, 409);
  assert.deepEqual(await readdir(elsewhere), []);
  assert.equal((await saturn.call("GET", `${route}/questions`)).status, 409);
});

test("records do not make a project dirty or follow its branches", async () => {
  const { route, folder } = await project({ "probe.py": "print(1)\n" });
  commitAll(folder);
  await saturn.api("POST", `${route}/questions`, { title: "First" });
  assert.equal(git(folder, "status", "--porcelain", "--untracked-files=all"), "");
  git(folder, "switch", "-q", "-c", "other");
  assert.equal((await saturn.api("GET", `${route}/questions`)).items.length, 1);
});

test("a frozen version records the commit, what is uncommitted, and every declared input", async () => {
  const { route, folder } = await project({ "probe.py": "print(1)\n", "tracked.py": "a\n", "data/set.jsonl": "{}\n", "score.py": "s\n", "uv.lock": "l\n" });
  commitAll(folder);
  await writeFile(path.join(folder, "tracked.py"), "edited\n");
  await writeFile(path.join(folder, "untracked.py"), "new\n");
  const experiment = await draft(route, { code: ["probe.py"], data: ["data"], scorer: ["score.py"], environment: ["uv.lock"] }, { seeds: [17], envNames: ["HF_HOME"] });

  const answer = await freeze(route, experiment.id);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const version = answer.body;
  assert.equal(version.number, 1);
  assert.equal(version.experimentId, experiment.id);
  assert.equal(version.command, "python probe.py");
  assert.deepEqual(version.seeds, [17]);
  assert.deepEqual(version.envNames, ["HF_HOME"]);
  assert.equal(version.git.commit, git(folder, "rev-parse", "HEAD"));
  assert.deepEqual(version.changedFiles.map((item) => [item.path, item.state, item.sha256, item.saved]), [
    ["tracked.py", "modified", sha("edited\n"), true],
    ["untracked.py", "untracked", sha("new\n"), true],
  ]);
  assert.equal(await readFile(path.join(folder, ".saturn/research/objects", sha("edited\n")), "utf8"), "edited\n");
  assert.deepEqual(version.inputs.map((item) => [item.role, item.path, item.sha256, item.size]), [
    ["code", "probe.py", sha("print(1)\n"), 9],
    ["data", "data/set.jsonl", sha("{}\n"), 3],
    ["scorer", "score.py", sha("s\n"), 2],
    ["environment", "uv.lock", sha("l\n"), 2],
  ]);
  assert.equal(existsSync(path.join(folder, ".saturn/research/objects", sha("{}\n"))), false, "data is not copied");
  assert.deepEqual(await saturn.api("GET", `${route}/versions/${version.id}`), version);
});

test("freezing the same content returns the same version, even at the same moment", async () => {
  const { route } = await project({ "probe.py": "print(1)\n" });
  const experiment = await draft(route, { code: ["probe.py"] });
  const answers = await Promise.all([1, 2, 3, 4].map(() => freeze(route, experiment.id)));
  assert.deepEqual(new Set(answers.map((answer) => answer.body.id)).size, 1, JSON.stringify(answers));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 200, 200, 201]);
  assert.equal((await saturn.api("GET", `${route}/versions`)).items.length, 1);
});

test("a change to code, data or the draft makes the next version, and the old one stays as it was", async () => {
  const { route, folder } = await project({ "probe.py": "print(1)\n", "set.jsonl": "{}\n" });
  const experiment = await draft(route, { code: ["probe.py"], data: ["set.jsonl"] });
  const first = (await freeze(route, experiment.id)).body;

  await writeFile(path.join(folder, "probe.py"), "print(2)\n");
  const second = await freeze(route, experiment.id);
  assert.equal(second.status, 201);
  assert.equal(second.body.number, 2);

  await writeFile(path.join(folder, "set.jsonl"), "{\"a\":1}\n");
  const third = (await freeze(route, experiment.id)).body;
  assert.equal(third.number, 3);

  await saturn.api("PATCH", `${route}/experiments/${experiment.id}`, { expectedRevision: 1, command: "python other.py" });
  const fourth = (await freeze(route, experiment.id)).body;
  assert.equal(fourth.number, 4);
  assert.equal(fourth.command, "python other.py");

  assert.deepEqual(await saturn.api("GET", `${route}/versions/${first.id}`), first);
  assert.equal((await saturn.call("PATCH", `${route}/versions/${first.id}`, { expectedRevision: 1, command: "x" })).status, 405);
});

test("outside git, the declared code is saved as copies", async () => {
  const { route, folder } = await project({ "src/probe.py": "print(1)\n", "set.jsonl": "{}\n" });
  const experiment = await draft(route, { code: ["src"], data: ["set.jsonl"] });
  const version = (await freeze(route, experiment.id)).body;
  assert.equal(version.git.commit, null);
  assert.deepEqual(version.changedFiles.map((item) => [item.path, item.state, item.saved]), [["src/probe.py", "untracked", true]]);
  assert.equal(await readFile(path.join(folder, ".saturn/research/objects", sha("print(1)\n")), "utf8"), "print(1)\n");
});

test("a repository with no commit yet can be frozen", async () => {
  const { route, folder } = await project({ "probe.py": "print(1)\n" });
  git(folder, "init", "-q", "-b", "main");
  const experiment = await draft(route, { code: ["probe.py"] });
  const version = (await freeze(route, experiment.id)).body;
  assert.equal(version.git.commit, null);
  assert.deepEqual(version.changedFiles.map((item) => item.path), ["probe.py"]);
});

test("a file too big to copy is kept by its hash", async () => {
  const big = "x".repeat(5 * 1024 * 1024 + 1);
  const { route, folder } = await project({ "weights.py": big });
  const experiment = await draft(route, { code: ["weights.py"] });
  const version = (await freeze(route, experiment.id)).body;
  assert.deepEqual(version.changedFiles.map((item) => [item.path, item.saved, item.sha256]), [["weights.py", false, sha(big)]]);
  assert.equal(existsSync(path.join(folder, ".saturn/research/objects", sha(big))), false);
});

test("a deleted file is recorded as deleted", async () => {
  const { route, folder } = await project({ "probe.py": "print(1)\n", "old.py": "o\n" });
  commitAll(folder);
  await rm(path.join(folder, "old.py"));
  const experiment = await draft(route, { code: ["probe.py"] });
  const version = (await freeze(route, experiment.id)).body;
  assert.deepEqual(version.changedFiles.map((item) => [item.path, item.state, item.sha256]), [["old.py", "deleted", null]]);
});

test("a version cannot be made from a missing input, a path outside the project, or no command", async () => {
  const { route } = await project({ "probe.py": "print(1)\n" });
  const missing = await draft(route, { data: ["gone.jsonl"] });
  const refused = await freeze(route, missing.id);
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /gone\.jsonl/);
  const outside = await draft(route, { code: ["../other.py"] });
  assert.equal((await freeze(route, outside.id)).status, 422);
  const records = await draft(route, { data: [".saturn/research/questions"] });
  assert.equal((await freeze(route, records.id)).status, 422);
  assert.equal((await saturn.call("POST", `${route}/experiments`, { title: "No command" })).status, 201);
  const empty = (await saturn.api("GET", `${route}/experiments`)).items.find((item) => item.title === "No command");
  assert.equal((await freeze(route, empty.id)).status, 422);
  assert.equal((await saturn.api("GET", `${route}/versions`)).items.length, 0);
});

test("a linked input is recorded as a link and not followed", posixOnly, async () => {
  const { route, folder } = await project({ "probe.py": "print(1)\n" });
  const elsewhere = await saturn.folder();
  await writeFile(path.join(elsewhere, "secret.txt"), "secret");
  await symlink(path.join(elsewhere, "secret.txt"), path.join(folder, "linked.txt"));
  const experiment = await draft(route, { data: ["linked.txt"] });
  assert.equal((await freeze(route, experiment.id)).status, 422);
  git(folder, "init", "-q", "-b", "main");
  const inFolder = await draft(route, { code: ["probe.py"] });
  const version = (await freeze(route, inFolder.id)).body;
  const link = version.changedFiles.find((item) => item.path === "linked.txt");
  assert.equal(link.state, "link");
  assert.equal(link.saved, false);
  assert.equal(existsSync(path.join(folder, ".saturn/research/objects", sha("secret"))), false);
});

test("a version names its models' sources and revisions, and knows the floating ones", async () => {
  const { route } = await project({ "probe.py": "print(1)\n" });
  const commit = "c".repeat(40);
  const pinned = await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-14m", weightsRevision: commit });
  const floating = await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-31m" });
  const experiment = await draft(route, { code: ["probe.py"] }, { models: [{ modelId: pinned.id, role: "base" }, { modelId: floating.id, role: "policy" }] });
  const version = (await freeze(route, experiment.id)).body;
  assert.deepEqual(version.models, [
    { modelId: pinned.id, role: "base", source: "EleutherAI/pythia-14m", weightsRevision: commit, floating: false, revisionKind: "commit" },
    { modelId: floating.id, role: "policy", source: "EleutherAI/pythia-31m", weightsRevision: null, floating: true, revisionKind: "none" },
  ]);
  const unknown = await draft(route, { code: ["probe.py"] }, { models: [{ modelId: "model_nothere000000", role: "base" }] });
  assert.equal((await freeze(route, unknown.id)).status, 422);
});

test("a revision name that can move is not a pinned identity, and local weights are known by their content", async () => {
  const { route, folder } = await project({ "probe.py": "print(1)\n" });
  await writeFile(path.join(folder, "weights.bin"), "first weights");
  const latest = await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-14m", weightsRevision: "latest" });
  const local = await saturn.api("POST", `${route}/models`, { source: "weights.bin", weightsRevision: "latest" });
  const experiment = await draft(route, { code: ["probe.py"] }, { models: [{ modelId: latest.id, role: "base" }, { modelId: local.id, role: "policy" }] });
  const version = (await freeze(route, experiment.id)).body;
  const [named, checkpoint] = version.models;
  assert.equal(named.floating, true);
  assert.equal(named.revisionKind, "name");
  assert.equal(named.weightsSha256, undefined, "a hub model is not read here");
  assert.equal(checkpoint.weightsSha256, sha("first weights"));
  // Other weights behind the same name make the next freeze a new version.
  await writeFile(path.join(folder, "weights.bin"), "other weights");
  const again = (await freeze(route, experiment.id)).body;
  assert.notEqual(again.id, version.id);
  assert.notEqual(again.models[1].weightsSha256, checkpoint.weightsSha256);
});

test("a chat from another project cannot choose the source folder", async () => {
  const first = await project({ "probe.py": "print(1)\n" });
  const second = await project({ "probe.py": "print(2)\n" });
  const { thread } = await saturn.chat(second.folder);
  const experiment = await draft(first.route, { code: ["probe.py"] });
  const answer = await freeze(first.route, experiment.id, { threadId: thread.id });
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  const own = await freeze(first.route, experiment.id, { threadId: "thread_nothere" });
  assert.equal(own.status, 404);
});
