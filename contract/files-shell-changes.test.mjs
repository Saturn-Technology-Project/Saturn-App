// What a shell command changes joins the turn's checkpoint, in a git folder through git's view and elsewhere through a
// private snapshot in Saturn's data; Settings → Storage lists and deletes those snapshots.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, command, commitAll, git, posixOnly, sha, until, write } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const COMMAND = "printf 'v2\\n' > tracked.txt && printf 'more\\n' >> edited.txt && printf 'new\\n' > added.txt && rm gone.txt && mkdir -p build && printf 'x' > build/out.js";
const EXPECTED = { "added.txt": "added", "edited.txt": "modified", "gone.txt": "deleted", "tracked.txt": "modified" };

const changes = (run) => saturn.api("GET", `/runs/${run.id}/changes`);
const revert = (run, body = {}) => saturn.api("POST", `/runs/${run.id}/changes/revert`, body);
const text = (...parts) => readFile(path.join(...parts), "utf8");
const statuses = (seen) => Object.fromEntries(seen.files.map((file) => [file.path, file.status]));

test("files a command changes in a git project join the turn's changes, and revert undoes them", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "tracked.txt"), "v1\n");
  await writeFile(path.join(folder, "edited.txt"), "base\n");
  await writeFile(path.join(folder, "gone.txt"), "bye\n");
  await writeFile(path.join(folder, ".gitignore"), "build/\n");
  commitAll(folder);
  // A change of the user's own, before the turn, one of them staged: revert must bring back this, not git's version.
  await writeFile(path.join(folder, "edited.txt"), "base\nmine\n");
  await writeFile(path.join(folder, "staged.txt"), "staged by the user\n");
  git(folder, "add", "staged.txt");
  const head = git(folder, "rev-parse", "HEAD");

  const setup = await saturn.chat(folder);
  const run = await setup.turn([command(COMMAND)]);
  assert.equal(run.actions[0].status, "completed");
  const seen = await changes(run);
  assert.deepEqual(statuses(seen), EXPECTED, "ignored build output and the untouched staged file are left out");
  assert.equal(seen.root, folder);
  assert.match(seen.files.find((file) => file.path === "tracked.txt").diff, /-v1\n\+v2/);
  assert.match(seen.files.find((file) => file.path === "edited.txt").diff, / mine\n\+more/);
  assert.equal(seen.files.find((file) => file.path === "edited.txt").before, sha("base\nmine\n"));

  await revert(run);
  assert.equal(await text(folder, "tracked.txt"), "v1\n");
  assert.equal(await text(folder, "edited.txt"), "base\nmine\n", "the user's own edit survives the revert");
  assert.equal(await text(folder, "gone.txt"), "bye\n");
  assert.equal(existsSync(path.join(folder, "added.txt")), false);
  assert.equal(await text(folder, "build/out.js"), "x", "ignored output is not tracked, so it stays");
  assert.equal(await text(folder, "staged.txt"), "staged by the user\n");
  assert.equal(git(folder, "rev-parse", "HEAD"), head, "the user's git state is not touched");
  assert.equal(git(folder, "diff", "--cached", "--name-only"), "staged.txt");
});

test("a project in a subfolder of a repository lists paths relative to itself", posixOnly, async () => {
  const repository = await saturn.folder();
  await mkdir(path.join(repository, "packages/site"), { recursive: true });
  await writeFile(path.join(repository, "packages/site/page.txt"), "page\n");
  await writeFile(path.join(repository, "packages/site/dirty.txt"), "clean\n");
  await writeFile(path.join(repository, "root.txt"), "root\n");
  commitAll(repository);
  await writeFile(path.join(repository, "root.txt"), "the user's change above the project\n");
  await writeFile(path.join(repository, "packages/site/dirty.txt"), "the user's change\n");
  const folder = path.join(repository, "packages/site");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([command("printf 'edited\\n' > page.txt && printf 'made\\n' > new.txt && printf 'more\\n' >> dirty.txt")]);
  const seen = await changes(run);
  assert.deepEqual(statuses(seen), { "dirty.txt": "modified", "new.txt": "added", "page.txt": "modified" });
  await revert(run);
  assert.equal(await text(folder, "page.txt"), "page\n");
  assert.equal(await text(folder, "dirty.txt"), "the user's change\n");
  assert.equal(existsSync(path.join(folder, "new.txt")), false);
  assert.equal(await text(repository, "root.txt"), "the user's change above the project\n");
});

test("a file name with spaces or other scripts is tracked under its real name, in git and outside it", posixOnly, async () => {
  for (const inGit of [true, false]) {
    const folder = await saturn.folder();
    const name = "with space é 日本.txt";
    await writeFile(path.join(folder, name), "original\n");
    if (inGit) commitAll(folder);
    const setup = await saturn.chat(folder);
    const run = await setup.turn([command(`printf 'edited\\n' > '${name}' && printf 'new\\n' > 'new é.txt'`)]);
    assert.deepEqual(statuses(await changes(run)), { [name]: "modified", "new é.txt": "added" }, `in git: ${inGit}`);
    await revert(run);
    assert.equal(await text(folder, name), "original\n");
    assert.equal(existsSync(path.join(folder, "new é.txt")), false);
  }
});

test("a file a command moves counts as deleted and added, and comes back", posixOnly, async () => {
  for (const inGit of [true, false]) {
    const folder = await saturn.folder();
    await writeFile(path.join(folder, "old-name.txt"), "contents\n");
    if (inGit) commitAll(folder);
    const setup = await saturn.chat(folder);
    const run = await setup.turn([command("mv old-name.txt new-name.txt")]);
    assert.equal(run.actions[0].status, "completed", run.actions[0].reason);
    assert.deepEqual(statuses(await changes(run)), { "new-name.txt": "added", "old-name.txt": "deleted" }, `in git: ${inGit}`);
    await revert(run);
    assert.equal(await text(folder, "old-name.txt"), "contents\n");
    assert.equal(existsSync(path.join(folder, "new-name.txt")), false);
  }
});

test("a file a command stages itself keeps its original: git mv and git add can be reviewed and reverted", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "old-name.txt"), "contents\n");
  await writeFile(path.join(folder, "staged.txt"), "before\n");
  commitAll(folder);
  const setup = await saturn.chat(folder);
  const run = await setup.turn([command("git mv old-name.txt new-name.txt && echo after > staged.txt && git add staged.txt")]);
  assert.equal(run.actions[0].status, "completed", run.actions[0].reason);
  assert.deepEqual(statuses(await changes(run)), { "new-name.txt": "added", "old-name.txt": "deleted", "staged.txt": "modified" });
  await revert(run);
  assert.equal(await text(folder, "old-name.txt"), "contents\n");
  assert.equal(await text(folder, "staged.txt"), "before\n");
  assert.equal(existsSync(path.join(folder, "new-name.txt")), false);
});

test("a command that changes nothing, or changes a file back, leaves nothing to review", posixOnly, async () => {
  for (const inGit of [true, false]) {
    const folder = await saturn.folder();
    await writeFile(path.join(folder, "same.txt"), "same\n");
    if (inGit) commitAll(folder);
    const setup = await saturn.chat(folder);
    const quiet = await setup.turn([command("cat same.txt")]);
    assert.deepEqual((await changes(quiet)).files, [], `in git: ${inGit}`);
    const back = await setup.turn([command("printf 'other\\n' > same.txt"), command("printf 'same\\n' > same.txt")]);
    assert.deepEqual((await changes(back)).files, [], `in git: ${inGit}`);
    assert.equal(await text(folder, "same.txt"), "same\n");
  }
});

test("a file changed by the files tool and then a command keeps the first original", posixOnly, async () => {
  for (const inGit of [true, false]) {
    const folder = await saturn.folder();
    await writeFile(path.join(folder, "a.txt"), "first original\n");
    if (inGit) commitAll(folder);
    const setup = await saturn.chat(folder);
    const run = await setup.turn([write("a.txt", "by the tool\n"), command("printf 'by the command\\n' >> a.txt")]);
    const [file, ...rest] = (await changes(run)).files;
    assert.deepEqual(rest, []);
    assert.deepEqual([file.before, file.after], [sha("first original\n"), sha("by the tool\nby the command\n")], `in git: ${inGit}`);
    await revert(run);
    assert.equal(await text(folder, "a.txt"), "first original\n");
  }
});

test("restoring to a command's step undoes that command and the ones after it", posixOnly, async () => {
  for (const inGit of [true, false]) {
    const folder = await saturn.folder();
    await writeFile(path.join(folder, "a.txt"), "v0\n");
    if (inGit) commitAll(folder);
    const setup = await saturn.chat(folder);
    const run = await setup.turn([command("printf 'v1\\n' > a.txt"), command("printf 'v2\\n' > a.txt && printf 'x' > b.txt"), command("printf 'v3\\n' > a.txt")]);
    const result = await saturn.api("POST", `/runs/${run.id}/restore`, { actionId: run.actions[1].id });
    assert.deepEqual(result.files.sort(), ["a.txt", "b.txt"], `in git: ${inGit}`);
    assert.equal(await text(folder, "a.txt"), "v1\n", `in git: ${inGit}`);
    assert.equal(existsSync(path.join(folder, "b.txt")), false, `in git: ${inGit}`);
    await saturn.api("POST", `/runs/${run.id}/restore`, { actionId: run.actions[0].id });
    assert.equal(await text(folder, "a.txt"), "v0\n", `in git: ${inGit}`);
  }
});

test("a file over 10 MB that a command writes is not kept", posixOnly, async () => {
  for (const inGit of [true, false]) {
    const folder = await saturn.folder();
    await writeFile(path.join(folder, "small.txt"), "small\n");
    if (inGit) commitAll(folder);
    const setup = await saturn.chat(folder);
    const run = await setup.turn([command("dd if=/dev/zero of=huge.bin bs=1048576 count=11 2>/dev/null; printf 'edited\\n' > small.txt")]);
    assert.deepEqual(statuses(await changes(run)), { "small.txt": "modified" }, `in git: ${inGit}`);
  }
});

test("outside git, a private snapshot tracks the same changes, leaves the folder alone, and Settings lists and deletes it", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "tracked.txt"), "v1\n");
  await writeFile(path.join(folder, "edited.txt"), "base\nmine\n");
  await writeFile(path.join(folder, "gone.txt"), "bye\n");
  const setup = await saturn.chat(folder);
  const run = await setup.turn([command(COMMAND)]);
  const seen = await changes(run);
  assert.deepEqual(statuses(seen), EXPECTED, "build/ is left out by default");
  assert.deepEqual((await readdir(folder)).sort(), ["added.txt", "build", "edited.txt", "tracked.txt"], "nothing of Saturn's is written into the folder");

  const storage = await saturn.api("GET", "/storage/snapshots");
  const listed = storage.folders.find((item) => item.folder === folder);
  assert.ok(listed, JSON.stringify(storage));
  assert.match(listed.id, /^[0-9a-f]{16}$/);
  assert.ok(listed.bytes > 0);
  assert.equal(storage.bytes, storage.folders.reduce((sum, item) => sum + item.bytes, 0));

  assert.equal((await saturn.call("DELETE", `/storage/snapshots/${encodeURIComponent("../../etc")}`)).status, 404);
  const unknown = await saturn.call("DELETE", "/storage/snapshots/notasnapshot");
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /No such snapshot folder/);
  assert.deepEqual(await saturn.api("DELETE", `/storage/snapshots/${listed.id}`), { deleted: true });
  assert.equal((await saturn.api("GET", "/storage/snapshots")).folders.some((item) => item.id === listed.id), false);

  // Deleting it keeps the turn revertible.
  await revert(run);
  assert.equal(await text(folder, "tracked.txt"), "v1\n");
  assert.equal(await text(folder, "edited.txt"), "base\nmine\n");
  assert.equal(await text(folder, "gone.txt"), "bye\n");
  assert.equal(existsSync(path.join(folder, "added.txt")), false);

  // The folder's next command takes a fresh one, and deleting them all clears it.
  const next = await setup.turn([command("printf 'again\\n' > tracked.txt")]);
  assert.deepEqual(statuses(await changes(next)), { "tracked.txt": "modified" });
  assert.ok((await saturn.api("GET", "/storage/snapshots")).folders.some((item) => item.folder === folder));
  assert.deepEqual(await saturn.api("DELETE", "/storage/snapshots"), { deleted: true });
  assert.deepEqual(await saturn.api("GET", "/storage/snapshots"), { folders: [], bytes: 0 });
  await revert(next);
  assert.equal(await text(folder, "tracked.txt"), "v1\n");
});

test("outside git, dependencies, builds, caches and logs stay out of the snapshot", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "kept.txt"), "kept\n");
  const setup = await saturn.chat(folder);
  const made = ["node_modules/a.js", ".venv/a", "venv/a", "__pycache__/a", "dist/a", "build/a", "target/a", ".next/a", ".nuxt/a", ".cache/a", ".turbo/a", ".gradle/a", "Pods/a", "DerivedData/a", "server.log", ".DS_Store"];
  const script = made.map((file) => `mkdir -p "$(dirname ${file})" && printf x > ${file}`).join(" && ");
  const run = await setup.turn([command(`${script} && printf 'edited\\n' > kept.txt`)]);
  assert.equal(run.actions[0].status, "completed", run.actions[0].reason);
  assert.deepEqual(statuses(await changes(run)), { "kept.txt": "modified" });
});

test("a background command's changes are recorded under the step that started it, once it ends", posixOnly, async () => {
  for (const inGit of [true, false]) {
    const folder = await saturn.folder();
    await writeFile(path.join(folder, "server.log.txt"), "start\n");
    if (inGit) commitAll(folder);
    const setup = await saturn.chat(folder);
    const run = await setup.turn([command("sleep 0.5 && printf 'later\\n' > made-later.txt && printf 'more\\n' >> server.log.txt", { background: true })]);
    assert.equal(run.actions[0].status, "completed");
    const paths = async () => (await changes(run)).files.map((file) => file.path).sort();
    await until("the command's changes", paths, (list) => list.length === 2);
    assert.deepEqual(await paths(), ["made-later.txt", "server.log.txt"], `in git: ${inGit}`);

    const restored = await saturn.api("POST", `/runs/${run.id}/restore`, { actionId: run.actions[0].id });
    assert.deepEqual(restored.files.sort(), ["made-later.txt", "server.log.txt"], "they belong to the step that started it");
    assert.equal(await text(folder, "server.log.txt"), "start\n");
    assert.equal(existsSync(path.join(folder, "made-later.txt")), false);
  }
});

test("a background command's changes can be reverted like any other", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "log.txt"), "start\n");
  commitAll(folder);
  const setup = await saturn.chat(folder);
  const run = await setup.turn([command("sleep 0.3 && printf 'more\\n' >> log.txt", { background: true })]);
  await until("the command's change", () => changes(run), (seen) => seen.files.length === 1);
  await revert(run);
  assert.equal(await text(folder, "log.txt"), "start\n");
});
