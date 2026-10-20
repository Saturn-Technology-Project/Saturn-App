import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

test("a run's browser recordings are listed from its results, frames are served by index, and only Saturn's own folders count", async () => {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-recordings-")));
  await store.load();
  const { services } = createApp(store);
  const folder = path.join(store.root, "workspace", "recordings", "demo");
  await mkdir(folder, { recursive: true });
  for (const index of [1, 2, 3]) await writeFile(path.join(folder, `frame-${String(index).padStart(5, "0")}.jpg`), Buffer.from([0xff, 0xd8, 0xff, index]));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "saturn-not-a-recording-"));
  await store.update((state) => {
    state.runs.unshift({
      id: "run_rec", agentId: "agt", input: "record", status: "completed", output: "", generation: 0,
      actions: [
        { id: "a1", toolId: "browser_record_stop", arguments: {}, status: "completed", result: { recording: folder, frames: 3, seconds: 0.3 } },
        { id: "a2", toolId: "browser_record_stop", arguments: {}, status: "completed", result: { recording: elsewhere, frames: 1 } },
        { id: "a3", toolId: "browser_record_stop", arguments: {}, status: "completed", result: { recording: path.join(store.root, "workspace", "recordings", "..", "..", "secrets.json"), frames: 1 } },
      ],
    } as Run);
  });
  assert.deepEqual(services.recordings("run_rec"), [{ name: "demo", frames: 3, seconds: 0.3, exported: false }]);
  assert.equal(services.recordingFrame("run_rec", "demo", 2), path.join(folder, "frame-00002.jpg"));
  assert.throws(() => services.recordingFrame("run_rec", "demo", 4), /No such frame/);
  assert.throws(() => services.recordingFrame("run_rec", "other", 1), /no such recording/);
});
