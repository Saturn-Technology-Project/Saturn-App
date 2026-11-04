import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordingName, screenshotPath } from "../src/infrastructure/skills/browser-files.js";

test("a screenshot is only saved in the workspace, also through links", async () => {
  const data = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-browser-files-")));
  const workspace = path.join(data, "workspace");
  await mkdir(path.join(workspace, "shots"), { recursive: true });
  await symlink(os.tmpdir(), path.join(workspace, "linked"));
  await symlink(path.join(data, "nowhere"), path.join(workspace, "dangling"));
  assert.equal(await screenshotPath(data, "shots/new/page.jpg"), path.join(workspace, "shots/new/page.jpg"));
  for (const file of ["../escaped.jpg", "/etc/page.jpg", "linked/page.jpg", "dangling", "dangling/page.jpg", "."]) {
    await assert.rejects(screenshotPath(data, file), /only be saved in the workspace/, file);
  }
});

test("a recording's name is one folder, never a way out of recordings", () => {
  assert.equal(recordingName("my demo!"), "my_demo_");
  assert.equal(recordingName(".hidden"), "hidden");
  assert.equal(recordingName("../up"), "_up");
  for (const raw of ["..", "...", ".", "  ", undefined, 7]) assert.match(recordingName(raw), /^recording-/);
});
