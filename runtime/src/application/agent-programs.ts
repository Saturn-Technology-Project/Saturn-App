import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../domain/errors.js";
import { AGENT_PROGRAM_PACKAGES, type ProgramPackage } from "../infrastructure/agent-programs-manifest.js";
import { launchEnv } from "../infrastructure/launch-env.js";
import { errorText } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";

const exec = promisify(execFile);

export type ProgramId = "claude-code" | "codex";
export const PROGRAM_IDS: ProgramId[] = ["claude-code", "codex"];
const LABELS: Record<ProgramId, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** Where the program Saturn runs comes from: its own download, the SDK copy in a development checkout, or the system. */
export type ProgramSource = "saturn" | "bundled" | "system";

export type InstallProgress = { state: "downloading" | "verifying" | "unpacking" | "done" | "failed"; received: number; total: number; error?: string };

export type ProgramStatus = {
  id: ProgramId;
  label: string;
  installed: boolean;
  source: ProgramSource | null;
  path: string | null;
  /** What the program itself reports (`--version`), when it answered. */
  version: string | null;
  /** The version Saturn downloads (and was tested with) for this platform; null where none is published. */
  downloadVersion: string | null;
  downloadSize: number;
  install?: InstallProgress;
};

/**
 * Claude Code and Codex, the official programs behind the Claude Code and Codex providers. Saturn no longer ships
 * them in its installer: it finds one already on the system, or downloads the exact package its SDKs were built
 * against from the npm registry, checks it against the sha512 pinned from the lock file, and unpacks it into
 * <data>/tools. Settings shows a download button until one is found, and the sign-in once it is.
 */
export class AgentProgramsService {
  private readonly installs = new Map<ProgramId, InstallProgress>();
  private readonly versions = new Map<string, string | null>();

  constructor(private readonly kernel: RuntimeKernel) {}

  private root(id: ProgramId): string {
    return path.join(this.kernel.store.root, "tools", id);
  }

  package(id: ProgramId): ProgramPackage | null {
    return AGENT_PROGRAM_PACKAGES[id][`${process.platform}-${process.arch}`] ?? null;
  }

  private executable(id: ProgramId): string {
    const name = id === "claude-code" ? "claude" : "codex";
    return process.platform === "win32" ? `${name}.exe` : name;
  }

  /** The program inside an unpacked platform package: claude at its root, codex under vendor/<target>/bin. */
  private binaryIn(id: ProgramId, packageDir: string): string | null {
    if (id === "claude-code") {
      const file = path.join(packageDir, this.executable(id));
      return existsSync(file) ? file : null;
    }
    const vendor = path.join(packageDir, "vendor");
    if (!existsSync(vendor)) return null;
    for (const target of readdirSync(vendor)) {
      const file = path.join(vendor, target, "bin", this.executable(id));
      if (existsSync(file)) return file;
    }
    return null;
  }

  private saturnPath(id: ProgramId): string | null {
    const item = this.package(id);
    return item ? this.binaryIn(id, path.join(this.root(id), item.version, "package")) : null;
  }

  private bundledPath(id: ProgramId): string | null {
    const name = id === "claude-code" ? `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}` : `@openai/codex-${process.platform}-${process.arch}`;
    try {
      const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`);
      return this.binaryIn(id, path.dirname(manifest));
    } catch {
      return null;
    }
  }

  /**
   * The program on the user's PATH (as a login shell sees it, Homebrew included). On Windows only a real .exe
   * counts: npm's .cmd shims cannot be started without a shell.
   */
  private systemPath(id: ProgramId): string | null {
    const name = this.executable(id);
    for (const dir of (launchEnv().PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const file = path.join(dir, name);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // Not in this folder.
      }
    }
    return null;
  }

  /** Saturn's own download first (the tested version), then a development checkout's SDK copy, then the system's. */
  resolve(id: ProgramId): { path: string; source: ProgramSource } | null {
    const saturn = this.saturnPath(id);
    if (saturn) return { path: saturn, source: "saturn" };
    const bundled = this.bundledPath(id);
    if (bundled) return { path: bundled, source: "bundled" };
    const system = this.systemPath(id);
    if (system) return { path: system, source: "system" };
    return null;
  }

  /** The program to run, or a 409 that says where to get it. */
  path(id: ProgramId): string {
    const found = this.resolve(id);
    if (!found) throw new HttpError(409, `${LABELS[id]} is not installed. Download it in Saturn Settings → General → ${LABELS[id]}.`);
    return found.path;
  }

  private async version(file: string): Promise<string | null> {
    let key = file;
    try {
      key = `${file}:${statSync(file).mtimeMs}`;
    } catch {
      return null;
    }
    if (this.versions.has(key)) return this.versions.get(key) ?? null;
    let version: string | null = null;
    try {
      const { stdout } = await exec(file, ["--version"], { env: launchEnv(), timeout: 15_000, windowsHide: true });
      version = stdout.trim().split("\n")[0]?.trim() || null;
    } catch {
      version = null;
    }
    this.versions.set(key, version);
    return version;
  }

  async status(id: ProgramId): Promise<ProgramStatus> {
    const found = this.resolve(id);
    const item = this.package(id);
    // A snapshot: the download keeps running while the version is asked for below.
    const current = this.installs.get(id);
    const install = current ? { ...current } : undefined;
    return {
      id,
      label: LABELS[id],
      installed: Boolean(found),
      source: found?.source ?? null,
      path: found?.path ?? null,
      version: found ? await this.version(found.path) : null,
      downloadVersion: item?.version ?? null,
      downloadSize: item?.size ?? 0,
      ...(install && install.state !== "done" ? { install } : {}),
    };
  }

  /** Starts the download in the background; the status reports its progress. */
  install(id: ProgramId): Promise<ProgramStatus> {
    const current = this.installs.get(id);
    if (current && ["downloading", "verifying", "unpacking"].includes(current.state)) return this.status(id);
    const item = this.package(id);
    if (!item) throw new HttpError(409, `${LABELS[id]} has no download for ${process.platform}-${process.arch}.`);
    const progress: InstallProgress = { state: "downloading", received: 0, total: item.size };
    this.installs.set(id, progress);
    void this.download(id, item, progress).catch((error) => {
      progress.state = "failed";
      progress.error = errorText(error);
      this.kernel.log("admin", "warning", `Downloading ${LABELS[id]} failed: ${progress.error}`);
    });
    return this.status(id);
  }

  private async download(id: ProgramId, item: ProgramPackage, progress: InstallProgress): Promise<void> {
    const root = this.root(id);
    await mkdir(root, { recursive: true });
    const archive = path.join(root, `${item.version}.tgz.part`);
    const unpacking = path.join(root, `${item.version}.unpacking`);
    const target = path.join(root, item.version);
    this.kernel.log("admin", "info", `Downloading ${LABELS[id]} ${item.version} from ${new URL(item.url).host}`);
    await this.fetchResumable(item, archive, progress);

    progress.state = "verifying";
    const expected = item.integrity.replace(/^sha512-/, "");
    if ((await sha512(archive)) !== expected) {
      await rm(archive, { force: true });
      throw new Error("the download does not match the checksum Saturn pinned for it, so it was discarded");
    }

    progress.state = "unpacking";
    try {
      await rm(unpacking, { recursive: true, force: true });
      await mkdir(unpacking, { recursive: true });
      await untar(archive, unpacking);
      const binary = this.binaryIn(id, path.join(unpacking, "package"));
      if (!binary) throw new Error("the package does not contain the program");
      if (process.platform !== "win32") await chmod(binary, 0o755);
      await rm(target, { recursive: true, force: true });
      await rename(unpacking, target);
      // Older versions and leftovers go; only the version this Saturn uses stays.
      for (const entry of readdirSync(root)) {
        if (entry !== item.version) await rm(path.join(root, entry), { recursive: true, force: true });
      }
    } finally {
      await rm(archive, { force: true });
      await rm(unpacking, { recursive: true, force: true });
    }
    progress.state = "done";
    this.kernel.log("admin", "info", `${LABELS[id]} ${item.version} is installed`);
  }

  /**
   * Downloads into `archive`, resuming after a dropped connection: what arrived stays on disk, and the next attempt
   * (a retry here, or the user's next click) asks only for the rest with an HTTP range request.
   */
  private async fetchResumable(item: ProgramPackage, archive: string, progress: InstallProgress): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      let have = 0;
      try {
        have = statSync(archive).size;
      } catch {
        have = 0;
      }
      if (item.size && have >= item.size) return;
      try {
        const response = await fetch(item.url, have ? { headers: { range: `bytes=${have}-` } } : {});
        if (response.status === 416) {
          await rm(archive, { force: true });
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`the registry answered ${response.status}`);
        const resuming = have > 0 && response.status === 206;
        if (!resuming) have = 0;
        const length = Number(response.headers.get("content-length")) || 0;
        progress.total = length ? have + length : item.size;
        progress.received = have;
        const file = createWriteStream(archive, { flags: resuming ? "a" : "w", mode: 0o600 });
        try {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            progress.received += value.byteLength;
            if (!file.write(value)) await new Promise<void>((resolve) => file.once("drain", resolve));
          }
        } finally {
          await new Promise<void>((resolve) => file.end(() => resolve()));
        }
        if (!progress.total || progress.received >= progress.total) return;
        lastError = new Error("the connection closed early");
      } catch (error) {
        lastError = error;
      }
      if (attempt < 5) {
        this.kernel.log("admin", "warning", `The download of ${new URL(item.url).pathname.split("/").pop()} was interrupted (${errorText(lastError)}); resuming`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
    throw new Error(`the download kept failing (${errorText(lastError)}). What arrived is kept: press Download again to resume.`);
  }

  /** Removes Saturn's own copy (a system install is left alone). */
  async remove(id: ProgramId): Promise<ProgramStatus> {
    await rm(this.root(id), { recursive: true, force: true });
    this.installs.delete(id);
    this.kernel.log("admin", "info", `Removed Saturn's copy of ${LABELS[id]}`);
    return this.status(id);
  }
}

export function programId(value: string): ProgramId {
  if (value === "claude-code" || value === "codex") return value;
  throw new HttpError(404, "Unknown program; use claude-code or codex");
}

function sha512(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("base64")));
  });
}

/** Unpacks a .tgz with the system's tar (bsdtar on macOS and Windows 10+, GNU tar on Linux). */
function untar(archive: string, destination: string): Promise<void> {
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ["-xzf", archive, "-C", destination], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar could not unpack the package: ${stderr.trim() || `exit ${code}`}`))));
  });
}
