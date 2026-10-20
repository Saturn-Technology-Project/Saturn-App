import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OnnxEmbedder, meanPool, modelDir } from "../src/infrastructure/embeddings.js";

test("mean pooling averages a row's real tokens (not its padding) and scales to length 1", () => {
  // Two rows of width 3, two dims; row 1 has two real tokens and one padding token.
  const data = new Float32Array([1, 0, 3, 0, 9, 9, /* row 1 */ 0, 2, 0, 2, 9, 9]);
  assert.deepEqual([...meanPool(data, 0, 2, 3, 2)], [1, 0]);
  assert.deepEqual([...meanPool(data, 1, 2, 3, 2)], [0, 1]);
});

// Runs only where the built-in model is on disk (SATURN_MODELS_DIR); the packaged app ships it.
test("the built-in model finds the English code a Chinese question is about", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "saturn-embed-"));
  if (!(await modelDir(data, "multilingual-e5-small")).ready) {
    t.skip("the built-in embedding model is not on this machine (set SATURN_MODELS_DIR)");
    return;
  }
  const embedder = new OnnxEmbedder(data, "multilingual-e5-small");
  const code = [
    "function parseImages(raw) { /* checks attached images: data URLs, known types, size limit */ }",
    "export async function projectRules(root) { /* reads AGENTS.md and .cursorrules into the prompt */ }",
    "class CheckpointService { revert(runId) { /* restore the original bytes of files an agent changed */ } }",
    "function cosine(a, b) { /* similarity between two vectors */ }",
  ];
  const passages = await embedder.embed(code, "passage");
  assert.equal(passages[0]!.length, 384);
  const best = async (question: string) => {
    const [query] = await embedder.embed([question], "query");
    const scores = passages.map((vector) => vector.reduce((sum, value, i) => sum + value * query![i]!, 0));
    return scores.indexOf(Math.max(...scores));
  };
  assert.deepEqual(
    [await best("還原 agent 改過的檔案"), await best("讀取專案規則"), await best("檢查使用者附加的圖片大小"), await best("向量相似度")],
    [2, 1, 0, 3],
  );
});
