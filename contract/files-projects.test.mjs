// Projects: a chat works in a project's folder only with the user's grant, and a project holds folders, rules and an
// active choice; removing one never touches its files.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, write } from "./files-support.mjs";
import { program } from "./runtime.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const text = (...parts) => readFile(path.join(...parts), "utf8");

test("a project chat works in its folder only after the user grants access, and the model is told where", async () => {
  const folder = await saturn.folder();
  const setup = await saturn.chat();
  const { agent, model } = setup;
  const project = await saturn.api("POST", "/projects", { path: folder });
  assert.equal(project.access, null);
  const refused = await saturn.call("POST", `/agents/${agent.id}/runs`, { input: "write notes", projectId: project.id });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /doesn't have access/);
  assert.equal(model.requests.length, 0);

  await saturn.api("POST", `/projects/${project.id}/access`, {});
  model.queue.push(write("notes.md", "hello"));
  const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "write notes", projectId: project.id });
  const threads = await saturn.api("GET", `/agents/${agent.id}/threads`);
  assert.equal(threads.find((item) => item.id === started.threadId).projectId, project.id, "the chat belongs to the project");
  const run = await saturn.finished(started.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(await text(folder, "notes.md"), "hello");
  const system = model.requests[0].messages.find((item) => item.role === "system").content;
  assert.ok(system.includes(`Working directory: ${folder}`), system);
  assert.equal(existsSync(path.join(saturn.runtime.dataDir, "workspace/notes.md")), false);
});

test("a chat outside any project keeps to Saturn's private workspace", async () => {
  const setup = await saturn.chat();
  const run = await setup.turn([write("private-notes.md", "hello")]);
  assert.equal(run.actions[0].status, "completed");
  assert.equal(await text(saturn.runtime.dataDir, "workspace/private-notes.md"), "hello");
  assert.doesNotMatch(setup.model.requests[0].messages.find((item) => item.role === "system").content, /Working directory:/);
});

test("revoking access stops further turns; removing the project removes its chats, never its files", async () => {
  const folder = await saturn.folder();
  const setup = await saturn.chat(folder);
  const run = await setup.turn([write("notes.md", "hello")]);
  const revoked = await saturn.api("POST", `/projects/${setup.project.id}/access`, { granted: false });
  assert.equal(revoked.access, null);
  const refused = await saturn.call("POST", `/agents/${setup.agent.id}/runs`, { input: "again", threadId: setup.thread.id });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /doesn't have access/);

  assert.equal((await saturn.call("DELETE", `/projects/${setup.project.id}`)).status, 204);
  assert.equal((await saturn.api("GET", `/agents/${setup.agent.id}/threads`)).some((item) => item.projectId === setup.project.id), false);
  assert.equal((await saturn.call("GET", `/runs/${run.id}`)).status, 404);
  assert.equal(await text(folder, "notes.md"), "hello");
  assert.equal((await saturn.api("GET", "/projects")).some((item) => item.id === setup.project.id), false);
});

test("removing a project stops what is working in its chats", async () => {
  const folder = await saturn.folder();
  const setup = await saturn.chat(folder);
  let asked;
  let closed;
  const reached = new Promise((resolve) => { asked = resolve; });
  const hungUp = new Promise((resolve) => { closed = resolve; });
  await setup.start([(_request, response) => { response.on("close", closed); asked(); }]);
  await reached;
  await saturn.api("DELETE", `/projects/${setup.project.id}`);
  await hungUp;
});

test("a new runtime has a default project in the chosen folder, active and without access", async () => {
  const folder = await saturn.folder();
  const fresh = await bench({ env: { SATURN_PROJECT_PATH: folder } });
  try {
    const initial = await fresh.api("GET", "/projects");
    assert.equal(initial.length, 1);
    assert.equal(initial[0].id, "proj_default");
    assert.equal(initial[0].path, folder);
    assert.equal(initial[0].name, path.basename(folder));
    assert.equal(initial[0].isDefault, true);
    assert.deepEqual(initial[0].folders, [folder]);
    assert.ok(!initial[0].access);
    assert.equal((await fresh.api("GET", "/projects/active")).id, "proj_default");
  } finally {
    await fresh.stop();
  }
});

test("a runtime started in the folder its own program is in keeps its default project out of that folder", async () => {
  // The Windows installer puts the runtime beside the app, and the app starts it there: up to 0.6.1 the first project
  // was then the installation folder itself, which "Allow access" would have opened to agents.
  const installed = path.dirname(await realpath(program()));
  const fresh = await bench({ cwd: installed });
  try {
    const projects = await fresh.api("GET", "/projects");
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, "proj_default");
    assert.equal(projects[0].name, "Workspace");
    assert.equal(await realpath(projects[0].path), await realpath(path.join(fresh.runtime.dataDir, "workspace")));
    assert.notEqual(await realpath(projects[0].path), installed);
  } finally {
    await fresh.stop();
  }
});

test("a project keeps its details and rules, knows its git branch, and a new one becomes active", async () => {
  const folder = await saturn.folder();
  await mkdir(path.join(folder, ".git"));
  await writeFile(path.join(folder, ".git/HEAD"), "ref: refs/heads/feature-x\n");
  const earlier = await saturn.api("POST", "/projects", { path: await saturn.folder() });
  const created = await saturn.api("POST", "/projects", { name: " My Feature Project ", path: folder, description: " A test project ", rules: "# Strict Typing\nAll code must be strict.\n" });
  assert.equal(created.name, "My Feature Project");
  assert.equal(created.path, folder);
  assert.equal(created.gitBranch, "feature-x");
  assert.equal(created.description, "A test project");
  assert.equal(created.rules, "# Strict Typing\nAll code must be strict.");
  assert.equal(created.isDefault, false);
  assert.equal((await saturn.api("GET", "/projects/active")).id, created.id);

  await writeFile(path.join(folder, ".git/HEAD"), "ref: refs/heads/another\n");
  assert.equal((await saturn.api("GET", "/projects")).find((item) => item.id === created.id).gitBranch, "another", "the list reads the branch again");

  const updated = await saturn.api("PATCH", `/projects/${created.id}`, { description: "Updated description", rules: "New rules content" });
  assert.equal(updated.description, "Updated description");
  assert.equal(updated.rules, "New rules content");
  const stored = await saturn.api("GET", `/projects/${created.id}/rules`);
  assert.deepEqual([stored.content, stored.source], ["New rules content", "stored"]);

  await saturn.api("PUT", `/projects/${created.id}/rules`, { content: "Cursor rules content", targetFile: "cursorrules" });
  const cursor = await saturn.api("GET", `/projects/${created.id}/rules`);
  assert.deepEqual([cursor.content, cursor.source, cursor.path], ["Cursor rules content", "cursorrules", path.join(folder, ".cursorrules")]);
  assert.equal(await text(folder, ".cursorrules"), "Cursor rules content");

  const switched = await saturn.api("POST", `/projects/${earlier.id}/active`);
  assert.equal(switched.id, earlier.id);
  assert.equal((await saturn.api("GET", "/projects/active")).id, earlier.id);

  await saturn.api("POST", `/projects/${created.id}/active`);
  await saturn.api("DELETE", `/projects/${created.id}`);
  assert.equal((await saturn.api("GET", "/projects")).some((item) => item.id === created.id), false);
  assert.notEqual((await saturn.api("GET", "/projects/active")).id, created.id, "removing the active project moves on to another");

  for (const [method, route, body] of [["POST", "/projects/proj_none/active"], ["POST", "/projects/proj_none/access", {}], ["PATCH", "/projects/proj_none", { description: "x" }], ["GET", "/projects/proj_none/rules"], ["PUT", "/projects/proj_none/rules", { content: "x" }]]) {
    assert.equal((await saturn.call(method, route, body)).status, 404, `${method} ${route}`);
  }
});

test("adding a folder that is already a project gives that project, and can grant it", async () => {
  const folder = await saturn.folder();
  const created = await saturn.api("POST", "/projects", { path: folder, description: "first" });
  const other = await saturn.api("POST", "/projects", { path: await saturn.folder() });
  assert.equal((await saturn.api("GET", "/projects/active")).id, other.id);
  const again = await saturn.api("POST", "/projects", { path: folder, description: "second", grant: true });
  assert.equal(again.id, created.id);
  assert.equal(again.description, "first");
  assert.ok(again.access.grantedAt);
  assert.equal((await saturn.api("GET", "/projects/active")).id, created.id);
});

test("a workspace holds several folders, the first one primary, and edits are checked", async () => {
  const directory = await saturn.folder();
  const web = path.join(directory, "web");
  const api = path.join(directory, "api");
  await mkdir(web);
  await mkdir(api);
  await writeFile(path.join(directory, "a-file"), "");
  const created = await saturn.api("POST", "/projects", { name: "Landing-Page", folders: [web, api, web, " "] });
  assert.equal(created.name, "Landing-Page");
  assert.deepEqual(created.folders, [web, api], "duplicates dropped, order kept");
  assert.equal(created.path, web);

  const edited = await saturn.api("PATCH", `/projects/${created.id}`, { name: "Site", folders: [api] });
  assert.equal(edited.name, "Site");
  assert.deepEqual(edited.folders, [api]);
  assert.equal(edited.path, api, "the primary follows the first folder");

  const refused = async (body, pattern) => {
    const answer = await saturn.call("PATCH", `/projects/${created.id}`, body);
    assert.equal(answer.status, 400);
    assert.match(answer.body.error, pattern);
  };
  await refused({ folders: [] }, /at least one folder/);
  await refused({ folders: [path.join(directory, "missing")] }, /Folder not found/);
  await refused({ folders: [path.join(directory, "a-file")] }, /Not a folder/);
  await refused({ name: "  " }, /name is required/);

  assert.equal((await saturn.call("POST", "/projects", { folders: [] })).status, 400);
  assert.equal((await saturn.call("POST", "/projects", {})).status, 400);
  assert.deepEqual((await saturn.api("GET", "/projects")).find((item) => item.id === created.id).folders, [api]);
  const named = await saturn.api("POST", "/projects", { folders: [web] });
  assert.equal(named.name, "web", "named after its folder unless told otherwise");
  assert.notEqual(named.id, created.id);
});
