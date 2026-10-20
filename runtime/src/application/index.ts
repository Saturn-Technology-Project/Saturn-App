import { createHash } from "node:crypto";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LMStudioClient } from "@lmstudio/sdk";
import { chunkFile } from "../domain/chunks.js";
import { HttpError } from "../domain/errors.js";
import { errorText, logger } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";

/** Folders never indexed. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".cache", "coverage", "vendor", ".venv", "venv", "__pycache__", "target", ".artifacts", "release", ".staging", "Pods", "DerivedData"]);
/** Only text files of these kinds are indexed. */
const EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts", "rb", "php", "swift", "cs", "c", "h", "cc", "cpp", "hpp", "m", "mm", "md", "mdx", "txt", "json", "yaml", "yml", "toml", "sql", "sh", "css", "scss", "html", "vue", "svelte", "graphql", "proto"]);
const MAX_FILE_BYTES = 1_000_000;
/** Chunks embedded per request to the embedding model. */
const BATCH = 32;
/** The default embedding model (any one loaded in LM Studio works; this one is small and trained on code). */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

export type IndexStatus = {
  projectId: string;
  state: "empty" | "building" | "ready" | "error";
  files: number;
  chunks: number;
  /** Files still to embed while building. */
  pending?: number;
  model?: string;
  updatedAt?: string;
  error?: string;
};

export type IndexHit = { path: string; start: number; end: number; name?: string; score: number; text: string };

type Row = { id: number; path: string; start: number; end: number; name: string | null; text: string; vector: Uint8Array };

/**
 * A semantic index of each project's code, kept on this machine: files are split into chunks (one per function
 * or class where the language has them), each chunk gets an embedding from a model running in LM Studio, and
 * everything is stored in a SQLite file under the data directory. A search embeds the question and ranks chunks
 * by cosine similarity; nothing is sent anywhere but the local embedding model.
 */
export class IndexService {
  private readonly databases = new Map<string, DatabaseSync>();
  private readonly building = new Map<string, { pending: number; abort: AbortController }>();
  private readonly errors = new Map<string, string>();

  constructor(private readonly kernel: RuntimeKernel) {}

  private dir(): string {
    return path.join(this.kernel.store.root, "index");
  }

  private async open(projectId: string): Promise<DatabaseSync> {
    let db = this.databases.get(projectId);
    if (db) return db;
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path.join(this.dir(), `${projectId.replace(/[^\w-]/g, "_")}.db`));
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, name TEXT, text TEXT NOT NULL, vector BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.databases.set(projectId, db);
    return db;
  }

  /** The embedding model: Settings → General → Embedding model, else the default. Needs LM Studio running. */
  private embeddingModel(): { baseUrl: string; model: string } {
    const settings = this.kernel.store.state.settings;
    const lmstudio = this.kernel.store.state.models.find((item) => item.provider === "lmstudio");
    return { baseUrl: lmstudio?.baseUrl || "http://127.0.0.1:1234", model: settings.embeddingModel || DEFAULT_EMBEDDING_MODEL };
  }

  private async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const { baseUrl, model: key } = this.embeddingModel();
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const client = new LMStudioClient({ baseUrl: url.toString().replace(/\/$/, "") });
    try {
      const model = await client.embedding.model(key, { signal });
      const results = await model.embed(texts);
      return results.map((item) => Float32Array.from(item.embedding));
    } catch (error) {
      const text = errorText(error);
      if (/ECONNREFUSED|not running|connect/i.test(text)) throw new HttpError(503, "LM Studio is not running. Start it (with an embedding model downloaded) to build or search the code index.");
      if (/not found|no model|unknown model|does not exist/i.test(text)) throw new HttpError(409, `The embedding model "${key}" is not downloaded in LM Studio. Download it there, or choose another in Settings → General.`);
      throw error;
    } finally {
      void client[Symbol.asyncDispose]().catch(() => undefined);
    }
  }

  async status(projectId: string): Promise<IndexStatus> {
    const db = await this.open(projectId);
    const files = (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    const chunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const updated = db.prepare("SELECT value FROM meta WHERE key = 'updated_at'").get() as { value: string } | undefined;
    const model = db.prepare("SELECT value FROM meta WHERE key = 'model'").get() as { value: string } | undefined;
    const building = this.building.get(projectId);
    const error = this.errors.get(projectId);
    return {
      projectId,
      state: building ? "building" : error ? "error" : files ? "ready" : "empty",
      files,
      chunks,
      ...(building ? { pending: building.pending } : {}),
      ...(model ? { model: model.value } : {}),
      ...(updated ? { updatedAt: updated.value } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * Indexes the project's files that changed since last time (by content hash) and forgets files that are gone.
   * Runs in the background; `status` reports progress. `paths` limits the pass to those files (the IDE sends the
   * file just saved).
   */
  async build(projectId: string, paths?: string[]): Promise<IndexStatus> {
    const root = this.kernel.projects.workdir(projectId);
    const db = await this.open(projectId);
    if (this.building.has(projectId) && !paths) return this.status(projectId);
    const abort = new AbortController();
    const job = { pending: 0, abort };
    this.building.set(projectId, job);
    this.errors.delete(projectId);
    void (async () => {
      try {
        const files = paths ? paths.map((item) => path.resolve(root, item)).filter((item) => item.startsWith(root)) : await this.walk(root);
        const known = new Map((db.prepare("SELECT path, hash FROM files").all() as { path: string; hash: string }[]).map((row) => [row.path, row.hash]));
        const todo: { relative: string; hash: string; content: string }[] = [];
        const seen = new Set<string>();
        for (const file of files) {
          const relative = path.relative(root, file).split(path.sep).join("/");
          seen.add(relative);
          let content: string;
          try {
            const info = await stat(file);
            if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
            content = await readFile(file, "utf8");
          } catch {
            continue;
          }
          if (content.includes("\u0000")) continue;
          const hash = createHash("sha1").update(content).digest("hex");
          if (known.get(relative) === hash) continue;
          todo.push({ relative, hash, content });
        }
        if (!paths) {
          for (const gone of [...known.keys()].filter((item) => !seen.has(item))) this.forget(db, gone);
        }
        job.pending = todo.length;
        const { model } = this.embeddingModel();
        for (const file of todo) {
          if (abort.signal.aborted) return;
          const chunks = chunkFile(file.relative, file.content);
          const vectors: Float32Array[] = [];
          for (let at = 0; at < chunks.length; at += BATCH) {
            const batch = chunks.slice(at, at + BATCH);
            vectors.push(...(await this.embed(batch.map((chunk) => `${file.relative}${chunk.name ? ` ${chunk.name}` : ""}\n${chunk.text}`), abort.signal)));
          }
          this.forget(db, file.relative);
          const insert = db.prepare("INSERT INTO chunks (path, start, end, name, text, vector) VALUES (?, ?, ?, ?, ?, ?)");
          db.exec("BEGIN");
          try {
            chunks.forEach((chunk, index) => insert.run(file.relative, chunk.start, chunk.end, chunk.name ?? null, chunk.text, new Uint8Array(vectors[index]!.buffer)));
            db.prepare("INSERT OR REPLACE INTO files (path, hash, indexed_at) VALUES (?, ?, ?)").run(file.relative, file.hash, new Date().toISOString());
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          job.pending -= 1;
        }
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('updated_at', ?)").run(new Date().toISOString());
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?)").run(model);
        if (todo.length) logger.info("index", `Indexed ${todo.length} changed ${todo.length === 1 ? "file" : "files"} of ${path.basename(root)}`);
      } catch (error) {
        this.errors.set(projectId, errorText(error));
        logger.warn("index", `Indexing ${path.basename(root)} failed: ${errorText(error)}`);
      } finally {
        if (this.building.get(projectId) === job) this.building.delete(projectId);
      }
    })();
    return this.status(projectId);
  }

  cancel(projectId: string): void {
    this.building.get(projectId)?.abort.abort();
  }

  /** The chunks most similar to `query`, best first. */
  async search(projectId: string, query: string, limit = 12): Promise<IndexHit[]> {
    const db = await this.open(projectId);
    const text = query.trim();
    if (!text) return [];
    const [vector] = await this.embed([text]);
    const rows = db.prepare("SELECT id, path, start, end, name, text, vector FROM chunks").all() as unknown as Row[];
    const scored = rows.map((row) => ({ row, score: cosine(vector!, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ row, score }) => ({ path: row.path, start: row.start, end: row.end, ...(row.name ? { name: row.name } : {}), score: Math.round(score * 1000) / 1000, text: row.text }));
  }

  private forget(db: DatabaseSync, relative: string): void {
    db.prepare("DELETE FROM chunks WHERE path = ?").run(relative);
    db.prepare("DELETE FROM files WHERE path = ?").run(relative);
  }

  private async walk(root: string): Promise<string[]> {
    const found: string[] = [];
    const visit = async (dir: string, depth: number) => {
      if (depth > 12) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await visit(full, depth + 1);
        } else if (entry.isFile() && EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase())) {
          found.push(full);
        }
      }
    };
    await visit(root, 0);
    return found;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
