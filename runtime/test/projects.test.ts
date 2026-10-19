import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createApp } from "../src/presentation/app.js";
import { FileStore } from "../src/infrastructure/store.js";

test("projects service manages workspaces, active project, and project rules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-projects-store-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);

  // 1. Initial list has default project
  const initial = await services.listProjects();
  assert.equal(initial.length, 1);
  const activeInitial = await services.getActiveProject();
  assert.equal(activeInitial.id, initial[0]?.id);

  // 2. Create a new project directory with git repo simulation
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "my-test-project-"));
  const gitDir = path.join(projectDir, ".git");
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/feature-x\n");

  const created = await services.createProject({
    name: "My Feature Project",
    path: projectDir,
    description: "A test project",
    rules: "# Strict Typing\nAll code must be strict TypeScript.",
  });

  assert.equal(created.name, "My Feature Project");
  assert.equal(created.path, projectDir);
  assert.equal(created.gitBranch, "feature-x");
  assert.equal(created.rules, "# Strict Typing\nAll code must be strict TypeScript.");

  // 3. Newly created project becomes active
  const activeAfterCreate = await services.getActiveProject();
  assert.equal(activeAfterCreate.id, created.id);

  // 4. Update project details
  const updated = await services.updateProject(created.id, {
    description: "Updated description",
    rules: "New rules content",
  });
  assert.equal(updated.description, "Updated description");
  assert.equal(updated.rules, "New rules content");

  // 5. Get and save rules
  const rules = await services.getProjectRules(created.id);
  assert.equal(rules.content, "New rules content");

  await services.saveProjectRules(created.id, "Cursor rules content", "cursorrules");
  const cursorRulesFile = await services.getProjectRules(created.id);
  assert.equal(cursorRulesFile.content, "Cursor rules content");
  assert.equal(cursorRulesFile.source, "cursorrules");

  // 6. Switch back to initial project
  await services.setActiveProject(initial[0]!.id);
  const activeNow = await services.getActiveProject();
  assert.equal(activeNow.id, initial[0]!.id);

  // 7. Delete project
  await services.deleteProject(created.id);
  const listAfterDelete = await services.listProjects();
  assert.equal(listAfterDelete.length, 1);
  assert.equal(listAfterDelete.some((p) => p.id === created.id), false);
});

test("a workspace holds several folders, the first one primary, and edits are validated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-workspace-"));
  const web = path.join(directory, "web");
  const api = path.join(directory, "api");
  await mkdir(web);
  await mkdir(api);
  const store = new FileStore(path.join(directory, "data"));
  await store.load();
  const { services } = createApp(store);

  const created = await services.createProject({ name: "Landing-Page", folders: [web, api, web] });
  assert.equal(created.name, "Landing-Page");
  assert.deepEqual(created.folders, [web, api], "duplicates dropped, order kept");
  assert.equal(created.path, web);

  const edited = await services.updateProject(created.id, { name: "Site", folders: [api] });
  assert.equal(edited.name, "Site");
  assert.deepEqual(edited.folders, [api]);
  assert.equal(edited.path, api, "the primary follows the first folder");

  await assert.rejects(() => services.updateProject(created.id, { folders: [] }), /at least one folder/);
  await assert.rejects(() => services.updateProject(created.id, { folders: [path.join(directory, "missing")] }), /Folder not found/);
  await assert.rejects(() => services.updateProject(created.id, { name: "  " }), /name is required/);

  const listed = (await services.listProjects()).find((project) => project.id === created.id);
  assert.deepEqual(listed?.folders, [api]);
});
