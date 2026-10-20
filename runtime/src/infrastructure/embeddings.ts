import { createRequire } from "node:module";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { LMStudioClient } from "@lmstudio/sdk";
import OpenAI from "openai";
import { HttpError } from "../domain/errors.js";
import { errorText, logger } from "./logger.js";

/** A search question, or a piece of the code being indexed. Some models embed the two differently. */
export type EmbedKind = "query" | "passage";

export interface Embedder {
  /** Source and model, e.g. "builtin:multilingual-e5-small"; vectors from different ids never mix in one index. */
  readonly id: string;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
}

/** The models Saturn can run itself, on the CPU, with no other app. The first is the default. */
export const BUILTIN_MODELS = {
  "multilingual-e5-small": {
    repo: "Xenova/multilingual-e5-small",
    label: "Multilingual E5 small (built in; Chinese and English questions, 118 MB)",
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
    prefix: { query: "query: ", passage: "passage: " },
    maxTokens: 512,
  },
  "jina-embeddings-v2-base-code": {
    repo: "jinaai/jina-embeddings-v2-base-code",
    label: "Jina v2 code (download; English questions about code, 162 MB)",
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
    prefix: { query: "", passage: "" },
    maxTokens: 2048,
  },
} as const;

export type BuiltinModel = keyof typeof BUILTIN_MODELS;
export const DEFAULT_BUILTIN_MODEL: BuiltinModel = "multilingual-e5-small";

export function isBuiltinModel(name: string): name is BuiltinModel {
  return Object.hasOwn(BUILTIN_MODELS, name);
}

/**
 * Where a built-in model's files are: the copy shipped inside Saturn.app (SATURN_MODELS_DIR) when it has them,
 * else `<data>/models/<name>`, where `ensureModel` downloads them.
 */
export async function modelDir(dataRoot: string, name: BuiltinModel): Promise<{ dir: string; ready: boolean }> {
  const candidates = [process.env.SATURN_MODELS_DIR, path.join(dataRoot, "models")].filter(Boolean).map((root) => path.join(root!, name));
  for (const dir of candidates) {
    if (await hasFiles(dir, name)) return { dir, ready: true };
  }
  return { dir: candidates.at(-1)!, ready: false };
}

/** Downloads a built-in model's files from Hugging Face into `<data>/models/<name>` (once). */
export async function ensureModel(dataRoot: string, name: BuiltinModel, signal?: AbortSignal): Promise<string> {
  const found = await modelDir(dataRoot, name);
  if (found.ready) return found.dir;
  const spec = BUILTIN_MODELS[name];
  logger.info("index", `Downloading the ${name} embedding model from Hugging Face`);
  for (const file of spec.files) {
    const target = path.join(found.dir, file);
    if (await exists(target)) continue;
    const response = await fetch(`https://huggingface.co/${spec.repo}/resolve/main/${file}`, { signal });
    if (!response.ok) throw new HttpError(502, `Could not download ${name} (${file}): Hugging Face answered ${response.status}`);
    await mkdir(path.dirname(target), { recursive: true });
    // Written beside the target first, so an interrupted download is never mistaken for the model.
    await writeFile(`${target}.part`, Buffer.from(await response.arrayBuffer()));
    await rename(`${target}.part`, target);
  }
  return found.dir;
}

type Ort = typeof import("onnxruntime-node");
type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;
type TokenizerLike = { encode(text: string): { ids: number[] } };

/**
 * A model run by ONNX Runtime inside the runtime: tokenize, run the encoder, average the token vectors and
 * normalize. Inference runs on ONNX Runtime's own threads, so the event loop keeps serving while it works.
 */
export class OnnxEmbedder implements Embedder {
  readonly id: string;
  private loading: Promise<{ session: Session; tokenizer: TokenizerLike; ort: Ort }> | undefined;

  constructor(private readonly dataRoot: string, private readonly name: BuiltinModel) {
    this.id = `builtin:${name}`;
  }

  private load() {
    this.loading ??= (async () => {
      const dir = await ensureModel(this.dataRoot, this.name);
      // Loaded on first use: ONNX Runtime is a native module the rest of the runtime never needs.
      const require = createRequire(import.meta.url);
      const ort = require("onnxruntime-node") as Ort;
      const { Tokenizer } = require("@huggingface/tokenizers") as { Tokenizer: new (tokenizer: object, config: object) => TokenizerLike };
      const [tokenizerJson, configJson] = await Promise.all([readFile(path.join(dir, "tokenizer.json"), "utf8"), readFile(path.join(dir, "tokenizer_config.json"), "utf8")]);
      const tokenizer = new Tokenizer(JSON.parse(tokenizerJson), JSON.parse(configJson));
      const session = await ort.InferenceSession.create(path.join(dir, "onnx", "model_quantized.onnx"), {
        intraOpNumThreads: Math.max(1, Math.floor(availableParallelism() / 2)),
        graphOptimizationLevel: "all",
      });
      return { session, tokenizer, ort };
    })();
    this.loading.catch(() => (this.loading = undefined));
    return this.loading;
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const { session, tokenizer, ort } = await this.load();
    signal?.throwIfAborted();
    const spec = BUILTIN_MODELS[this.name];
    const encoded = texts.map((text) => clipTokens(tokenizer.encode(spec.prefix[kind] + text).ids, spec.maxTokens));
    const width = Math.max(...encoded.map((ids) => ids.length));
    const ids = new BigInt64Array(texts.length * width);
    const mask = new BigInt64Array(texts.length * width);
    encoded.forEach((row, r) => row.forEach((id, c) => {
      ids[r * width + c] = BigInt(id);
      mask[r * width + c] = 1n;
    }));
    const shape = [texts.length, width];
    const feeds: Record<string, InstanceType<Ort["Tensor"]>> = {
      input_ids: new ort.Tensor("int64", ids, shape),
      attention_mask: new ort.Tensor("int64", mask, shape),
    };
    if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(texts.length * width), shape);
    const output = (await session.run(feeds))[session.outputNames[0]!]!;
    const data = output.data as Float32Array;
    const dims = Number(output.dims[2]);
    return encoded.map((row, r) => meanPool(data, r, row.length, width, dims));
  }
}

/** Keeps the first tokens and the closing one, so a long chunk still ends the way the model expects. */
function clipTokens(ids: number[], max: number): number[] {
  return ids.length <= max ? ids : [...ids.slice(0, max - 1), ids[ids.length - 1]!];
}

/** The average of one row's token vectors (padding excluded), scaled to length 1. */
export function meanPool(data: Float32Array, row: number, tokens: number, width: number, dims: number): Float32Array {
  const vector = new Float32Array(dims);
  for (let token = 0; token < tokens; token += 1) {
    const offset = (row * width + token) * dims;
    for (let d = 0; d < dims; d += 1) vector[d]! += data[offset + d]!;
  }
  let norm = 0;
  for (let d = 0; d < dims; d += 1) {
    vector[d]! /= tokens;
    norm += vector[d]! * vector[d]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d += 1) vector[d]! /= norm;
  return vector;
}

/** An embedding model loaded in LM Studio. */
export class LmStudioEmbedder implements Embedder {
  readonly id: string;

  constructor(private readonly baseUrl: string, private readonly model: string) {
    this.id = `lmstudio:${model}`;
  }

  async embed(texts: string[], _kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const client = new LMStudioClient({ baseUrl: url.toString().replace(/\/$/, "") });
    try {
      const model = await client.embedding.model(this.model, { signal });
      const results = await model.embed(texts);
      return results.map((item) => Float32Array.from(item.embedding.map(Number)));
    } catch (error) {
      const text = errorText(error);
      if (/ECONNREFUSED|not running|connect/i.test(text)) throw new HttpError(503, "LM Studio is not running. Start it, or switch the code index to the built-in embedding model in Settings → General.");
      if (/not found|no model|unknown model|does not exist/i.test(text)) throw new HttpError(409, `The embedding model "${this.model}" is not downloaded in LM Studio. Download it there, or choose another in Settings → General.`);
      throw error;
    } finally {
      void client[Symbol.asyncDispose]().catch(() => undefined);
    }
  }
}

/** Any OpenAI-compatible `/embeddings` endpoint: OpenAI itself, or a local server that speaks its API. */
export class OpenAiEmbedder implements Embedder {
  readonly id: string;

  constructor(private readonly baseUrl: string | undefined, private readonly apiKey: string | undefined, private readonly model: string) {
    this.id = `openai:${baseUrl ?? "api.openai.com"}:${model}`;
  }

  async embed(texts: string[], _kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const client = new OpenAI({ apiKey: this.apiKey || "none", ...(this.baseUrl ? { baseURL: this.baseUrl.replace(/\/$/, "") } : {}) });
    const response = await client.embeddings.create({ model: this.model, input: texts }, { signal });
    return [...response.data].sort((a, b) => a.index - b.index).map((item) => Float32Array.from(item.embedding));
  }
}

async function hasFiles(dir: string, name: BuiltinModel): Promise<boolean> {
  for (const file of BUILTIN_MODELS[name].files) {
    if (!(await exists(path.join(dir, file)))) return false;
  }
  return true;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
