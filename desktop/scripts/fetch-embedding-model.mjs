// Downloads the built-in embedding model (the code index's default) into .staging/models, for electron-builder to
// ship as Resources/models, so the index works offline with no other app. Files are checked against pinned
// sha256 sums; a file already in place with the right sum is not downloaded again.
//
//   node scripts/fetch-embedding-model.mjs
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "multilingual-e5-small";
const REPO = "Xenova/multilingual-e5-small";
// The model and tokenizer are pinned by sha256, so a later upload cannot change what Saturn ships.
const FILES = {
  "config.json": null,
  "tokenizer_config.json": null,
  "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  "onnx/model_quantized.onnx": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
};

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(desktop, ".staging", "models", MODEL);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const [file, sum] of Object.entries(FILES)) {
  const destination = path.join(target, file);
  if (existsSync(destination) && (!sum || sha(readFileSync(destination)) === sum)) continue;
  const response = await fetch(`https://huggingface.co/${REPO}/resolve/main/${file}`);
  if (!response.ok) {
    console.error(`Could not download ${REPO}/${file}: ${response.status}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sum && sha(bytes) !== sum) {
    console.error(`${REPO}/${file} does not match its pinned sha256; refusing to ship it.`);
    process.exit(1);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(`${destination}.part`, bytes);
  renameSync(`${destination}.part`, destination);
}
console.log(`  • embedding model ${MODEL} ready  ${path.relative(process.cwd(), target)}`);
