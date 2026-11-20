// Prints the --config arguments that make a build look for updates, when this build has Eisoptric Workbench's updater key (UPDATER_PUBKEY and
// the bundler's TAURI_SIGNING_PRIVATE_KEY). Forks and builds without the key print nothing, and that build has no updater.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.UPDATER_PUBKEY;
if (key && process.env.TAURI_SIGNING_PRIVATE_KEY) {
  const template = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.updater.json");
  const config = readFileSync(template, "utf8").replace("__WORKBENCH_UPDATER_PUBKEY__", key);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "workbench-updater-")), "tauri.updater.json");
  writeFileSync(file, config);
  console.log(`--config ${file}`);
}
