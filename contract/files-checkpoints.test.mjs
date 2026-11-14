// Checkpoints: what an agent's edits in a project folder look like for review, and how exactly they are undone.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, command, git, commitAll, node, sha, until, write } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const changes = (run) => saturn.api("GET", `/runs/${run.id}/changes`);
const revert = (run, body = {}) => saturn.api("POST", `/runs/${run.id}/changes/revert`, body);
const keep = (run, body = {}) => saturn.api("POST", `/runs/${run.id}/changes/keep`, body);
const restore = (run, body = {}) => saturn.api("POST", `/runs/${run.id}/restore`, body);
const text = (...parts) => readFile(path.join(...parts), "utf8");
const bytes = (...parts) => readFile(path.join(...parts));

test("the first write in a turn keeps the original bytes, and the folder gets no Saturn files or git state", async () => {
  const folder = await saturn.folder();
  const original = Buffer.from("line one\r\nline two\r\nno newline: café", "utf8");
  await writeFile(path.join(folder, "notes.md"), original);
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("notes.md", "first edit\n"), write("notes.md", "second edit\n")]);

  const seen = await changes(run);
  assert.equal(seen.runId, run.id);
  assert.equal(seen.root, folder);
  assert.deepEqual(seen.files.map((file) => [file.path, file.before, file.after]), [["notes.md", sha(original), sha("second edit\n")]], "one entry, the first original kept");
  assert.ok((await bytes(saturn.runtime.dataDir, "checkpoints", run.id, sha(original))).equals(original), "the original is stored in the data folder by run");
  assert.deepEqual(await readdir(folder), ["notes.md"]);

  await revert(run);
  assert.ok((await bytes(folder, "notes.md")).equals(original), "byte for byte");
});

test("two writes to one file in the same model turn still keep its first original", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "same.txt"), "original\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([[write("same.txt", "one\n"), write("same.txt", "two\n")]]);
  assert.deepEqual((await changes(run)).files.map((file) => [file.path, file.before]), [["same.txt", sha("original\n")]]);
  await revert(run);
  assert.equal(await text(folder, "same.txt"), "original\n");
});

test("changes list each file with a unified diff and counts, and leave out a file written back unchanged", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await writeFile(path.join(folder, "same.txt"), "same\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([
    write("app.ts", "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n"),
    write("src/new.ts", "export {};\n"),
    write("same.txt", "same\n"),
  ]);
  const { files } = await changes(run);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.additions, file.deletions]), [
    ["app.ts", "modified", 2, 1],
    ["src/new.ts", "added", 1, 0],
  ]);
  assert.equal(files[0].diff, "--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 20;\n const c = 3;\n+const d = 4;\n");
  assert.equal(files[1].diff, "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export {};\n");
  assert.equal(files[1].before, null);
  assert.deepEqual(files.map((file) => [file.review, file.modifiedSince, file.binary, file.truncated]), [["pending", false, false, false], ["pending", false, false, false]]);
});

test("a long file diffs only the edited regions", async () => {
  const folder = await saturn.folder();
  const old = `${Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n")}\n`;
  await writeFile(path.join(folder, "big.txt"), old);
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("big.txt", old.replace("line 250\n", "line 250 changed\n").replace("line 10\n", ""))]);
  const [file] = (await changes(run)).files;
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 2);
  assert.equal(file.diff.match(/^@@/gm).length, 2, "two separate hunks");
});

test("a huge diff is cut in the answer, and reverting still restores every byte", async () => {
  const folder = await saturn.folder();
  const old = "old line\n".repeat(30_000);
  await writeFile(path.join(folder, "huge.txt"), old);
  const setup = await saturn.chat(folder);
  const run = await setup.turn([command(node("require('fs').writeFileSync('huge.txt', ('new line' + String.fromCharCode(10)).repeat(30000))"))]);
  assert.equal(run.actions[0].status, "completed", run.actions[0].reason);
  const [file] = (await changes(run)).files;
  assert.equal(file.truncated, true);
  assert.equal(file.diff.length, 200_000);
  assert.equal(file.additions, 30_000);
  await revert(run);
  assert.equal(await text(folder, "huge.txt"), old);
});

test("the editor reads one changed file before or after the turn, and nothing else", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "note.txt"), "before\n");
  await writeFile(path.join(folder, "private.txt"), "not changed by the turn\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("note.txt", "after\n"), write("new.txt", "made\n")]);
  const file = (query) => saturn.call("GET", `/runs/${run.id}/changes/file?${query}`);
  assert.deepEqual((await file("path=note.txt&side=before")).body, { path: "note.txt", content: "before\n", exists: true, binary: false });
  assert.deepEqual((await file("path=note.txt&side=after")).body, { path: "note.txt", content: "after\n", exists: true, binary: false });
  assert.deepEqual((await file("path=note.txt")).body.content, "after\n", "after is the default");
  assert.deepEqual((await file("path=new.txt&side=before")).body, { path: "new.txt", content: "", exists: false, binary: false });
  assert.equal((await file("path=private.txt")).status, 404);
  assert.equal((await file("path=../outside.txt")).status, 404);
  assert.equal((await saturn.call("GET", "/runs/run_none/changes")).status, 404);
});

test("a binary file is marked, shown without text, and restored exactly", async () => {
  const folder = await saturn.folder();
  const original = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x80, 0x0a]);
  await writeFile(path.join(folder, "image.bin"), original);
  commitAll(folder);
  const setup = await saturn.chat(folder);
  const run = await setup.turn([command("printf 'A\\000B' > image.bin")]);
  const [file] = (await changes(run)).files;
  assert.equal(file.binary, true);
  assert.deepEqual((await saturn.api("GET", `/runs/${run.id}/changes/file?path=image.bin&side=before`)), { path: "image.bin", content: "", exists: true, binary: true });
  await revert(run);
  assert.ok((await bytes(folder, "image.bin")).equals(original));
});

test("reverting one file restores its exact bytes and leaves the others", async () => {
  const folder = await saturn.folder();
  const original = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0d, 0x0a, 0x09, 0x20]);
  await writeFile(path.join(folder, "a.txt"), original);
  await writeFile(path.join(folder, "b.txt"), "b\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("a.txt", "changed a\n"), write("b.txt", "changed b\n")]);

  const answer = await revert(run, { path: "a.txt" });
  assert.ok((await bytes(folder, "a.txt")).equals(original));
  assert.equal(await text(folder, "b.txt"), "changed b\n");
  assert.deepEqual(answer.files.map((file) => [file.path, file.review]), [["a.txt", "reverted"], ["b.txt", "pending"]]);

  const unknown = await saturn.call("POST", `/runs/${run.id}/changes/revert`, { path: "other.txt" });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /did not change that file/);
});

test("revert all restores modified, deleted and moved files, and deletes the ones the turn created", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "keep.md"), "# Title\n");
  await writeFile(path.join(folder, "old.md"), "old\r\nbytes\r\n");
  await writeFile(path.join(folder, "moved.md"), "move me\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([
    write("keep.md", "# New title\n"),
    ["files", {
      action: "patch",
      patch: [
        "*** Begin Patch",
        "*** Add File: docs/added.md",
        "+added",
        "*** Delete File: old.md",
        "*** Update File: moved.md",
        "*** Move to: renamed.md",
        "@@",
        "-move me",
        "+moved",
        "*** End Patch",
      ].join("\n"),
    }],
  ]);
  assert.deepEqual(run.actions.map((action) => action.status), ["completed", "completed"]);
  assert.equal(existsSync(path.join(folder, "old.md")), false);
  assert.equal(await text(folder, "renamed.md"), "moved\n");
  const listed = (await changes(run)).files.map((file) => [file.path, file.status]);
  assert.deepEqual(listed.sort(), [["docs/added.md", "added"], ["keep.md", "modified"], ["moved.md", "deleted"], ["old.md", "deleted"], ["renamed.md", "added"]]);

  const reverted = await revert(run);
  assert.ok(reverted.files.every((file) => file.review === "reverted"));
  assert.equal(await text(folder, "keep.md"), "# Title\n");
  assert.equal(await text(folder, "old.md"), "old\r\nbytes\r\n");
  assert.equal(await text(folder, "moved.md"), "move me\n");
  assert.equal(existsSync(path.join(folder, "docs/added.md")), false);
  assert.equal(existsSync(path.join(folder, "renamed.md")), false);
});

test("reverting brings back a file whose folder has gone since", async () => {
  const folder = await saturn.folder();
  await mkdir(path.join(folder, "deep/er"), { recursive: true });
  await writeFile(path.join(folder, "deep/er/file.txt"), "original\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("deep/er/file.txt", "edited\n")]);
  await rm(path.join(folder, "deep"), { recursive: true });
  await revert(run);
  assert.equal(await text(folder, "deep/er/file.txt"), "original\n");
});

test("a file already reverted is not written again, so the user's work since then survives", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "a.txt"), "original\n");
  await writeFile(path.join(folder, "b.txt"), "original b\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("a.txt", "agent\n"), write("b.txt", "agent b\n")]);
  await revert(run, { path: "a.txt" });
  await writeFile(path.join(folder, "a.txt"), "the user's work after the revert\n");
  await revert(run);
  assert.equal(await text(folder, "a.txt"), "the user's work after the revert\n");
  assert.equal(await text(folder, "b.txt"), "original b\n");
  await restore(run);
  assert.equal(await text(folder, "a.txt"), "the user's work after the revert\n", "restoring does not either");
});

test("a change the user made to a file after the turn shows as modified since", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "a.txt"), "original\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("a.txt", "agent\n")]);
  assert.equal((await changes(run)).files[0].modifiedSince, false);
  await writeFile(path.join(folder, "a.txt"), "the user's\n");
  assert.equal((await changes(run)).files[0].modifiedSince, true);
  assert.equal((await revert(run)).files[0].modifiedSince, false, "back at the original");
  await writeFile(path.join(folder, "a.txt"), "changed again\n");
  assert.equal((await changes(run)).files[0].modifiedSince, true, "reverted, then changed");
});

test("a user's uncommitted edit from before the turn is what reverting brings back, not git's version", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "edited.txt"), "committed\n");
  commitAll(folder);
  await writeFile(path.join(folder, "edited.txt"), "committed\nthe user's own line\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("edited.txt", "replaced by the agent\n")]);
  assert.match((await changes(run)).files[0].diff, /-the user's own line/);
  await revert(run);
  assert.equal(await text(folder, "edited.txt"), "committed\nthe user's own line\n");
  assert.equal(git(folder, "status", "--porcelain"), "M edited.txt", "still the user's uncommitted edit");
  assert.equal(git(folder, "log", "--oneline").split("\n").length, 1);
});

test("keep marks edits accepted without touching the files, and they can still be reverted", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "x.txt"), "x0\n");
  await writeFile(path.join(folder, "y.txt"), "y0\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("x.txt", "x1\n"), write("y.txt", "y1\n")]);

  const one = await keep(run, { path: "x.txt" });
  assert.deepEqual(one.files.map((file) => [file.path, file.review]), [["x.txt", "kept"], ["y.txt", "pending"]]);
  assert.equal(await text(folder, "x.txt"), "x1\n");
  assert.equal((await saturn.call("POST", `/runs/${run.id}/changes/keep`, { path: "other.txt" })).status, 404);

  await revert(run, { path: "y.txt" });
  const all = await keep(run);
  assert.deepEqual(all.files.map((file) => file.review), ["kept", "reverted"], "a reverted file stays reverted");
  assert.equal(await text(folder, "y.txt"), "y0\n");

  const reverted = await revert(run, { path: "x.txt" });
  assert.deepEqual(reverted.files.map((file) => file.review), ["reverted", "reverted"]);
  assert.equal(await text(folder, "x.txt"), "x0\n");
});

test("restoring to before a turn reverts it and every later turn in the chat, and keeps the messages", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "a.txt"), "v0\n");
  const setup = await saturn.chat(folder);
  const first = await setup.turn([write("a.txt", "v1\n")], "first");
  const second = await setup.turn([write("a.txt", "v2\n"), write("created.txt", "made by turn 2\n")], "second");
  const third = await setup.turn([write("a.txt", "v3\n"), write("created.txt", "edited by turn 3\n")], "third");

  const result = await restore(second);
  assert.deepEqual(result.reverted, [third.id, second.id], "newest first");
  assert.deepEqual(result.files.sort(), ["a.txt", "created.txt"]);
  assert.equal(await text(folder, "a.txt"), "v1\n", "back to how turn 2 found it");
  assert.equal(existsSync(path.join(folder, "created.txt")), false, "the file turn 2 created is deleted");
  assert.equal((await changes(first)).files[0].review, "pending", "earlier turns are untouched");
  assert.equal((await saturn.api("GET", `/runs/${third.id}`)).input, "third", "messages stay");

  await restore(first);
  assert.equal(await text(folder, "a.txt"), "v0\n", "the file as it was before the chat touched it");
});

test("restoring a turn with nothing to undo changes nothing, and another chat's files are left alone", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "mine.txt"), "mine\n");
  await writeFile(path.join(folder, "theirs.txt"), "theirs\n");
  const setup = await saturn.chat(folder);
  const other = await setup.newThread("The other chat");
  const quiet = await setup.turn([]);
  assert.deepEqual(await restore(quiet), { reverted: [], files: [] });

  const mine = await setup.turn([write("mine.txt", "mine edited\n")]);
  await setup.turn([write("theirs.txt", "theirs edited\n")], "go", other.id);
  assert.deepEqual(await restore(mine), { reverted: [mine.id], files: ["mine.txt"] });
  assert.equal(await text(folder, "mine.txt"), "mine\n");
  assert.equal(await text(folder, "theirs.txt"), "theirs edited\n");
});

test("restoring to a step puts each file back to just before it, and deletes what it or later steps created", async () => {
  const folder = await saturn.folder();
  const original = Buffer.from("original\r\n\xff", "latin1");
  await writeFile(path.join(folder, "notes.md"), original);
  const setup = await saturn.chat(folder);
  const run = await setup.turn([
    write("notes.md", "v1\n"),
    ["files", { action: "patch", patch: "*** Begin Patch\n*** Update File: notes.md\n@@\n-v1\n+v2\n*** Add File: src/new.ts\n+export {};\n*** End Patch" }],
    write("notes.md", "v3\n"),
  ]);
  assert.deepEqual(run.actions.map((action) => action.status), ["completed", "completed", "completed"]);
  const [stepA, stepB, stepC] = run.actions.map((action) => action.id);

  const result = await restore(run, { actionId: stepB });
  assert.deepEqual(result.reverted, [run.id]);
  assert.deepEqual(result.files.sort(), ["notes.md", "src/new.ts"]);
  assert.equal(await text(folder, "notes.md"), "v1\n", "the first step's edit stays; the later ones are undone");
  assert.equal(existsSync(path.join(folder, "src/new.ts")), false);
  const seen = await changes(run);
  assert.deepEqual(seen.files.map((file) => [file.path, file.before, file.after, file.review]), [["notes.md", sha(original), sha("v1\n"), "pending"]], "the turn's change now ends at the first step's result");

  assert.deepEqual(await restore(run, { actionId: stepC }), { reverted: [], files: [] }, "that step is already undone");
  assert.equal(await text(folder, "notes.md"), "v1\n");

  await restore(run, { actionId: stepA });
  assert.ok((await bytes(folder, "notes.md")).equals(original), "byte for byte");
  assert.deepEqual((await changes(run)).files, [], "nothing is left to review");

  const unknown = await saturn.call("POST", `/runs/${run.id}/restore`, { actionId: "act_none" });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /not part of this run/);
});

test("restoring to a step reverts later turns whole, whatever they changed", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "a.txt"), "v0\n");
  const setup = await saturn.chat(folder);
  const first = await setup.turn([write("a.txt", "v1\n"), write("a.txt", "v2\n")]);
  const second = await setup.turn([write("a.txt", "v3\n"), write("later.txt", "from the later turn\n")]);

  const result = await restore(first, { actionId: first.actions[1].id });
  assert.deepEqual(result.reverted, [second.id, first.id]);
  assert.deepEqual(result.files.sort(), ["a.txt", "later.txt"]);
  assert.equal(await text(folder, "a.txt"), "v1\n");
  assert.equal(existsSync(path.join(folder, "later.txt")), false);
  assert.ok((await changes(second)).files.every((file) => file.review === "reverted"));
});

test("reverting does not follow a link a command put in the file's place", async () => {
  const folder = await saturn.folder();
  const elsewhere = await saturn.folder();
  const victim = path.join(elsewhere, "victim.txt");
  await writeFile(victim, "the user's own file");
  await writeFile(path.join(folder, "a.txt"), "original");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("a.txt", "from the agent")]);
  await rm(path.join(folder, "a.txt"));
  await symlink(victim, path.join(folder, "a.txt"));

  for (const [route, body] of [["changes/revert", {}], ["changes/revert", { path: "a.txt" }], ["restore", {}], ["restore", { actionId: run.actions[0].id }]]) {
    const refused = await saturn.call("POST", `/runs/${run.id}/${route}`, body);
    assert.ok(refused.status >= 400, `${route} ${JSON.stringify(body)}: ${refused.status}`);
    assert.match(refused.body.error, /outside the workspace/);
    assert.equal(await text(victim), "the user's own file", route);
  }
});

test("reverting does not follow a link in the place of the file's folder, and a created file's link target stays", async () => {
  const folder = await saturn.folder();
  const elsewhere = await saturn.folder();
  await writeFile(path.join(elsewhere, "made.txt"), "the user's own file");
  await mkdir(path.join(folder, "sub"));
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("sub/made.txt", "from the agent")]);
  await rm(path.join(folder, "sub"), { recursive: true });
  await symlink(elsewhere, path.join(folder, "sub"));

  const refused = await saturn.call("POST", `/runs/${run.id}/changes/revert`, {});
  assert.ok(refused.status >= 400);
  assert.match(refused.body.error, /outside the workspace/);
  assert.equal(await text(elsewhere, "made.txt"), "the user's own file", "not deleted through the link");
});

test("a turn still going cannot be reverted or restored, and an earlier turn cannot be restored past it", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "a.txt"), "v0\n");
  const setup = await saturn.chat(folder, { autonomy: "review" });
  const decide = async (run) => {
    const waiting = await until("the approval card", () => saturn.api("GET", `/runs/${run.id}`), (item) => item.status === "waiting_approval");
    return waiting.actions.find((action) => action.status === "waiting_approval");
  };
  const first = await setup.start([write("a.txt", "v1\n")]);
  await saturn.api("POST", `/runs/${first.id}/actions/${(await decide(first)).id}/decision`, { allow: true });
  await saturn.finished(first.id);
  const going = await setup.start([write("b.txt", "not yet\n")]);
  const card = await decide(going);

  for (const [route, body] of [
    [`/runs/${going.id}/changes/revert`, {}],
    [`/runs/${going.id}/changes/revert`, { path: "b.txt" }],
    [`/runs/${going.id}/restore`, {}],
    [`/runs/${going.id}/restore`, { actionId: card.id }],
    [`/runs/${first.id}/restore`, {}],
    [`/runs/${first.id}/restore`, { actionId: (await saturn.api("GET", `/runs/${first.id}`)).actions[0].id }],
  ]) {
    const refused = await saturn.call("POST", route, body);
    assert.equal(refused.status, 409, `${route} ${JSON.stringify(body)}`);
    assert.match(refused.body.error, /Wait for the run to finish/);
  }
  assert.equal(await text(folder, "a.txt"), "v1\n");
  await saturn.api("POST", `/runs/${going.id}/stop`);
  await saturn.finished(going.id);
  await restore(first);
  assert.equal(await text(folder, "a.txt"), "v0\n", "once it has stopped, it can");
});

test("a write outside the project fails and is not tracked", async () => {
  const folder = await saturn.folder();
  const elsewhere = await saturn.folder();
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("../escaped.txt", "x"), write(path.join(elsewhere, "abs.txt"), "x")]);
  assert.deepEqual(run.actions.map((action) => action.status), ["failed", "failed"]);
  assert.equal(existsSync(path.join(folder, "../escaped.txt")), false);
  assert.equal(existsSync(path.join(elsewhere, "abs.txt")), false);
  assert.deepEqual(await changes(run), { runId: run.id, root: null, files: [] });
});

test("a chat outside any project keeps no checkpoint", async () => {
  const setup = await saturn.chat();
  const run = await setup.turn([write("sandboxed.txt", "x\n")]);
  assert.equal(run.actions[0].status, "completed");
  assert.equal(await text(saturn.runtime.dataDir, "workspace/sandboxed.txt"), "x\n");
  assert.deepEqual(await changes(run), { runId: run.id, root: null, files: [] });
  assert.deepEqual(await revert(run), { runId: run.id, root: null, files: [] });
  assert.equal(await text(saturn.runtime.dataDir, "workspace/sandboxed.txt"), "x\n");
  assert.deepEqual(await restore(run), { reverted: [], files: [] });
});

test("an original whose saved copy is gone refuses the revert and leaves the file", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "a.txt"), "original\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("a.txt", "agent\n")]);
  await rm(path.join(saturn.runtime.dataDir, "checkpoints", run.id), { recursive: true });
  const refused = await saturn.call("POST", `/runs/${run.id}/changes/revert`, {});
  assert.equal(refused.status, 410);
  assert.match(refused.body.error, /saved copy is missing/);
  assert.equal(await text(folder, "a.txt"), "agent\n");
});

test("a turn can be reviewed and reverted after the runtime restarts", async () => {
  const first = await bench({ keepData: true });
  let second;
  try {
    const folder = await saturn.folder();
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    await writeFile(path.join(folder, "a.txt"), original);
    const setup = await first.chat(folder);
    const run = await setup.turn([write("a.txt", "agent\n")]);
    await first.stop();
    second = await bench({ dataDir: first.runtime.dataDir });
    const seen = await second.api("GET", `/runs/${run.id}/changes`);
    assert.deepEqual(seen.files.map((file) => [file.path, file.before, file.review]), [["a.txt", sha(original), "pending"]]);
    await second.api("POST", `/runs/${run.id}/changes/revert`, {});
    assert.ok((await bytes(folder, "a.txt")).equals(original));
  } finally {
    await second?.stop();
  }
});

test("deleting a chat drops its saved originals and never touches the project's files", async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "a.txt"), "original\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("a.txt", "agent\n")]);
  const saved = path.join(saturn.runtime.dataDir, "checkpoints", run.id);
  assert.ok(existsSync(saved));
  await saturn.api("DELETE", `/threads/${setup.thread.id}`);
  assert.equal(existsSync(saved), false);
  assert.equal((await saturn.call("GET", `/runs/${run.id}/changes`)).status, 404);
  assert.equal(await text(folder, "a.txt"), "agent\n");
});
