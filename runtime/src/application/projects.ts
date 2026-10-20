import { projectRules, type RuleSource } from "./rules.js";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import type { Project } from "../domain/model.js";
import { errorText, logger } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";
import { launchEnv } from "../infrastructure/launch-env.js";
function resolveHome(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return path.resolve(trimmed);
}

async function detectGitBranch(dir: string): Promise<string | null> {
  try {
    const gitHead = path.join(dir, ".git", "HEAD");
    const content = await readFile(gitHead, "utf8").catch(() => null);
    if (!content) return null;
    const match = content.trim().match(/^ref: refs\/heads\/(.+)$/);
    if (match && match[1]) return match[1];
    return content.trim().slice(0, 7);
  } catch {
    return null;
  }
}

function launchApp(what: string, command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", env: launchEnv() });
  child.on("error", (error) => logger.warn("projects", `Could not launch ${what}: ${errorText(error)}`));
  child.unref();
}

const exec = promisify(execFile);

/**
 * How a Saturn IDE build is laid out on each platform: what to launch, and where product.json and the app's
 * files are. macOS ships an app bundle; Windows and Linux ship a folder with the executable at its root.
 */
export function ideLayout(platform: NodeJS.Platform = process.platform): { bundle: string; binary: string[]; resources: string[]; buildDir: string } {
  if (platform === "win32") return { bundle: "Saturn IDE", binary: ["Saturn IDE.exe"], resources: ["resources", "app"], buildDir: `VSCode-win32-${process.arch}` };
  if (platform === "darwin") return { bundle: "Saturn IDE.app", binary: ["Contents", "MacOS", "Saturn IDE"], resources: ["Contents", "Resources", "app"], buildDir: `VSCode-darwin-${process.arch}` };
  return { bundle: "Saturn IDE", binary: ["saturn-ide"], resources: ["resources", "app"], buildDir: `VSCode-linux-${process.arch}` };
}

/** Where an installed Saturn IDE may be, most likely first, after the copy bundled with Saturn. */
export function ideCandidates(platform: NodeJS.Platform, home: string, repo: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const layout = ideLayout(platform);
  if (platform === "win32") {
    return [
      path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", layout.bundle),
      path.join(env.ProgramFiles || "C:\\Program Files", layout.bundle),
      path.join(repo, layout.buildDir),
      path.join(repo, "..", layout.buildDir),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Saturn IDE.app",
      path.join(home, "Applications", layout.bundle),
      // Local builds: Saturn-IDE/ lives inside this checkout and builds to VSCode-darwin-<arch>/ beside it.
      path.join(repo, layout.buildDir, layout.bundle),
      path.join(repo, "..", layout.buildDir, layout.bundle),
    ];
  }
  return [path.join(home, ".local", "share", "saturn-ide"), "/opt/saturn-ide", "/usr/share/saturn-ide", path.join(repo, layout.buildDir), path.join(repo, "..", layout.buildDir)];
}

/**
 * Identifies a Saturn IDE build: product.json's version, commit and date, plus the size and modification time
 * of its main bundle and the Saturn extension. The commit and date alone repeat across local rebuilds made
 * before a commit, which would leave an outdated copy installed.
 */
async function ideBuild(app: string): Promise<string | null> {
  const resources = path.join(app, ...ideLayout().resources);
  try {
    const product = JSON.parse(await readFile(path.join(resources, "product.json"), "utf8")) as { commit?: string; date?: string; version?: string };
    const files = await Promise.all(
      [path.join(resources, "out", "main.js"), path.join(resources, "extensions", "saturn", "extension.js")].map((file) =>
        stat(file).then((info) => `${info.size}@${Math.floor(info.mtimeMs / 1000)}`, () => "-"),
      ),
    );
    return [product.version ?? "", product.commit ?? "", product.date ?? "", ...files].join(":");
  } catch {
    return null;
  }
}

/**
 * Saturn.app carries Saturn IDE inside Contents/Resources, but Code-OSS loads no extensions when it runs from
 * inside another app bundle. So the bundled copy is installed to ~/Applications on first use, and again
 * whenever Saturn ships a different build, and that copy is the one launched.
 *
 * The new copy is staged beside the old one and swapped in with renames, so a slow or failing delete of the old
 * copy (macOS can answer ENOTEMPTY while Spotlight or Finder touch a big bundle) never blocks opening the IDE.
 * One install runs at a time; a second caller waits for it.
 */
let installing: Promise<string> | null = null;

function installBundledIde(bundled: string): Promise<string> {
  installing ??= swapInBundledIde(bundled).finally(() => {
    installing = null;
  });
  return installing;
}

/**
 * Deletes an app bundle with the system rm. The packaged runtime runs on Electron's Node, whose fs treats a
 * bundle's node_modules.asar as a folder, so fs.rm fails part-way (ENOTEMPTY) and leaves a broken app behind.
 */
async function removeBundle(target: string): Promise<void> {
  if (process.platform === "darwin") {
    await exec("/bin/rm", ["-rf", target]);
    return;
  }
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function swapInBundledIde(bundled: string): Promise<string> {
  const target = path.join(os.homedir(), "Applications", "Saturn IDE.app");
  const [want, have] = await Promise.all([ideBuild(bundled), ideBuild(target)]);
  if (want && want === have) return target;
  const staging = `${target}.installing`;
  await removeBundle(staging);
  await mkdir(path.dirname(target), { recursive: true });
  const started = Date.now();
  await exec("ditto", [bundled, staging]);
  const old = `${target}.old-${Date.now()}`;
  const hadOld = await stat(target).then(() => true, () => false);
  if (hadOld) await rename(target, old);
  await rename(staging, target);
  if (hadOld) {
    void removeBundle(old).catch((error) => logger.warn("projects", `Could not remove the previous Saturn IDE copy at ${old}: ${errorText(error)}`));
  }
  logger.info("projects", `Installed Saturn IDE to ${target} in ${Date.now() - started} ms`);
  return target;
}

/**
 * Where Saturn IDE (the Code-OSS fork in ../Saturn-IDE) is: the copy bundled in Saturn.app (SATURN_IDE_APP,
 * installed to ~/Applications first), then the usual Applications folders, then a local build in this
 * checkout (`npm run build:ide` in desktop).
 */
export async function findSaturnIde(): Promise<string | null> {
  const layout = ideLayout();
  const exists = (candidate: string) => stat(path.join(candidate, ...layout.binary)).then((info) => info.isFile()).catch(() => false);
  const bundled = process.env.SATURN_IDE_APP;
  if (bundled && (await exists(bundled))) {
    // On macOS the bundled copy is installed to ~/Applications first (see installBundledIde); elsewhere the IDE
    // runs from Saturn's own resources folder.
    if (process.platform !== "darwin" || !bundled.includes(".app/Contents/")) return bundled;
    try {
      return await installBundledIde(bundled);
    } catch (error) {
      // An older installed copy (below) still opens; better than not opening the IDE at all.
      logger.warn("projects", `Could not install the bundled Saturn IDE: ${errorText(error)}`);
    }
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const candidate of ideCandidates(process.platform, os.homedir(), repo)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Where Saturn Agent App (the desktop Electron app) is: /Applications, ~/Applications,
 * or local release builds in desktop/release/mac(-arm64).
 */
export async function findSaturnAgentApp(): Promise<string | null> {
  const exists = (candidate: string) => stat(candidate).then((info) => info.isDirectory()).catch(() => false);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const candidates = [
    "/Applications/Saturn.app",
    path.join(os.homedir(), "Applications", "Saturn.app"),
    path.join(repo, "desktop", "release", `mac-${process.arch}`, "Saturn.app"),
    path.join(repo, "desktop", "release", "mac", "Saturn.app"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/** Resolves and checks a workspace's folders: absolute, existing directories, no duplicates, primary first. */
async function resolveFolders(input: unknown, fallback?: string): Promise<string[]> {
  const raw = Array.isArray(input) ? input : fallback ? [fallback] : [];
  const folders: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) continue;
    const resolved = resolveHome(item);
    const info = await stat(resolved).catch(() => null);
    if (!info) throw new HttpError(400, `Folder not found: ${resolved}`);
    if (!info.isDirectory()) throw new HttpError(400, `Not a folder: ${resolved}`);
    if (!folders.includes(resolved)) folders.push(resolved);
  }
  if (!folders.length) throw new HttpError(400, "Add at least one folder to the workspace");
  return folders;
}

/** Older projects saved only `path`. */
function withFolders(project: Project): Project {
  return project.folders?.length ? project : { ...project, folders: [project.path] };
}

/** True for a path inside a macOS app bundle, such as the packaged runtime's own folder. */
function insideAppBundle(folder: string): boolean {
  return /\.app(\/|$)/.test(folder);
}

export class ProjectService {
  constructor(private readonly kernel: RuntimeKernel) {}

  /**
   * Where the default project points when there is none yet. In development that is this checkout (the
   * runtime's working directory, or its parent repository). In the packaged app the working directory is
   * inside Saturn.app, which is no place for agents or the IDE, so it is the agents' own workspace folder.
   */
  private async defaultFolder(): Promise<string> {
    const chosen = process.env.SATURN_PROJECT_PATH || process.cwd();
    if (!insideAppBundle(chosen)) return chosen;
    const workspace = path.join(this.kernel.store.root, "workspace");
    await mkdir(workspace, { recursive: true });
    return workspace;
  }

  private async ensureProjects(): Promise<Project[]> {
    let projects = this.kernel.store.state.projects ?? [];
    if (projects.length === 0) {
      let defaultPath = await this.defaultFolder();
      if (path.basename(defaultPath) === "runtime" || path.basename(defaultPath) === "desktop") {
        const parent = path.dirname(defaultPath);
        const hasParentGit = await stat(path.join(parent, ".git")).then(() => true).catch(() => false);
        if (hasParentGit) {
          defaultPath = parent;
        }
      }
      const defaultName = insideAppBundle(process.cwd()) && !process.env.SATURN_PROJECT_PATH ? "Workspace" : path.basename(defaultPath) || "Saturn-App";
      const branch = await detectGitBranch(defaultPath);
      const defaultProj: Project = {
        id: "proj_default",
        name: defaultName,
        path: defaultPath,
        gitBranch: branch,
        description: "Primary workspace project",
        isDefault: true,
        lastOpenedAt: new Date().toISOString(),
      };
      await this.kernel.store.update((state) => {
        if (!state.projects) state.projects = [];
        state.projects.push(defaultProj);
        state.activeProjectId = defaultProj.id;
        projects = state.projects;
      });
    }

    const defaultItem = projects.find((p) => p.id === "proj_default");
    // Saved by an earlier packaged build: the default project pointed inside Saturn.app. Move it to the workspace.
    if (defaultItem && insideAppBundle(defaultItem.path)) {
      const workspace = await this.defaultFolder();
      const moved = insideAppBundle(workspace) ? path.join(this.kernel.store.root, "workspace") : workspace;
      await mkdir(moved, { recursive: true });
      defaultItem.path = moved;
      defaultItem.name = "Workspace";
      await this.kernel.store.update((state) => {
        const target = (state.projects ?? []).find((p) => p.id === "proj_default");
        if (target) {
          target.path = moved;
          target.name = "Workspace";
          if (target.folders) target.folders = [moved];
        }
      });
    }
    if (defaultItem && (path.basename(defaultItem.path) === "runtime" || path.basename(defaultItem.path) === "desktop")) {
      const parent = path.dirname(defaultItem.path);
      const hasParentGit = await stat(path.join(parent, ".git")).then(() => true).catch(() => false);
      if (hasParentGit) {
        defaultItem.path = parent;
        defaultItem.name = path.basename(parent);
        defaultItem.gitBranch = await detectGitBranch(parent);
        await this.kernel.store.update((state) => {
          const target = (state.projects ?? []).find((p) => p.id === "proj_default");
          if (target) {
            target.path = parent;
            target.name = path.basename(parent);
            target.gitBranch = defaultItem.gitBranch;
          }
        });
      }
    }

    if (!this.kernel.store.state.activeProjectId && projects.length > 0) {
      await this.kernel.store.update((state) => {
        state.activeProjectId = projects[0]?.id ?? null;
      });
    }

    return projects;
  }

  async list(): Promise<Project[]> {
    const projects = await this.ensureProjects();
    const updated = await Promise.all(
      projects.map(async (p) => {
        const branch = await detectGitBranch(p.path);
        return { ...withFolders(p), gitBranch: branch ?? p.gitBranch ?? null };
      })
    );
    return updated;
  }

  async getActive(): Promise<Project> {
    const projects = await this.list();
    const activeId = this.kernel.store.state.activeProjectId;
    const active = projects.find((p) => p.id === activeId) ?? projects[0];
    if (!active) {
      throw new HttpError(404, "No project found");
    }
    return active;
  }

  async create(input: { name?: string; path?: string; folders?: string[]; description?: string; rules?: string; grant?: boolean }): Promise<Project> {
    const folders = await resolveFolders(input.folders, input.path);
    const resolved = folders[0]!;
    const existing = (this.kernel.store.state.projects ?? []).find((p) => p.path === resolved && !input.folders);
    if (existing) {
      if (input.grant && !existing.access) await this.setAccess(existing.id, true);
      await this.setActive(existing.id);
      return withFolders(this.kernel.store.state.projects!.find((p) => p.id === existing.id)!);
    }

    const name = input.name?.trim() || path.basename(resolved) || "New Workspace";
    const proj: Project = {
      id: newId("proj"),
      name,
      path: resolved,
      folders,
      gitBranch: await detectGitBranch(resolved),
      description: input.description?.trim() || "",
      rules: input.rules?.trim() || "",
      lastOpenedAt: new Date().toISOString(),
      isDefault: false,
      // Choosing the folder in the picker and confirming the access prompt is the user's grant.
      access: input.grant ? { grantedAt: new Date().toISOString() } : null,
    };

    await this.kernel.store.update((state) => {
      if (!state.projects) state.projects = [];
      state.projects.unshift(proj);
      state.activeProjectId = proj.id;
    });

    logger.info("projects", `Created workspace ${name} with ${folders.length} ${folders.length === 1 ? "folder" : "folders"} (${resolved})`);
    return proj;
  }

  /** Grants or revokes agents' access to a project's folder. */
  async setAccess(id: string, granted: boolean): Promise<Project> {
    let updated: Project | undefined;
    await this.kernel.store.update((state) => {
      const project = (state.projects ?? []).find((item) => item.id === id);
      if (!project) throw new HttpError(404, `Project ${id} not found`);
      project.access = granted ? { grantedAt: new Date().toISOString() } : null;
      updated = project;
    });
    logger.info("projects", `${granted ? "Granted" : "Revoked"} agent access to ${updated!.name} (${updated!.path})`);
    return withFolders(updated!);
  }

  /**
   * The folder a project's chats work in. Refuses until the user has granted access, so an agent never
   * touches a folder the user did not explicitly allow.
   */
  /** Where a chat's agent works: the chat's own worktree when it has one, else the project folder. */
  workdirFor(thread: { projectId?: string; id: string; worktree?: { branch: string; base: string } } | undefined): string | undefined {
    if (!thread?.projectId) return undefined;
    const root = this.workdir(thread.projectId);
    return this.kernel.worktrees.pathOf(thread) ?? root;
  }

  workdir(projectId: string): string {
    const project = (this.kernel.store.state.projects ?? []).find((item) => item.id === projectId);
    if (!project) throw new HttpError(404, "This chat's project was removed. Add the folder again to keep working in it.");
    if (!project.access) {
      throw new HttpError(403, `Saturn doesn't have access to ${project.name} yet. Allow access to ${project.path} to work in it.`);
    }
    return project.path;
  }

  async setActive(id: string): Promise<Project> {
    const projects = await this.ensureProjects();
    const target = projects.find((p) => p.id === id);
    if (!target) {
      throw new HttpError(404, `Project ${id} not found`);
    }

    await this.kernel.store.update((state) => {
      state.activeProjectId = id;
      const p = (state.projects ?? []).find((item) => item.id === id);
      if (p) {
        p.lastOpenedAt = new Date().toISOString();
      }
    });

    logger.info("projects", `Switched active project to ${target.name} (${target.path})`);
    return target;
  }

  async update(id: string, patch: Partial<Project>): Promise<Project> {
    const folders = patch.folders !== undefined ? await resolveFolders(patch.folders) : undefined;
    if (patch.name !== undefined && !patch.name.trim()) throw new HttpError(400, "Workspace name is required");
    let updated: Project | undefined;
    await this.kernel.store.update((state) => {
      const list = state.projects ?? [];
      const index = list.findIndex((p) => p.id === id);
      if (index === -1) throw new HttpError(404, `Project ${id} not found`);
      const existing = list[index]!;
      list[index] = {
        ...existing,
        name: patch.name !== undefined ? patch.name.trim() : existing.name,
        description: patch.description !== undefined ? patch.description.trim() : existing.description,
        rules: patch.rules !== undefined ? patch.rules : existing.rules,
        gitBranch: patch.gitBranch !== undefined ? patch.gitBranch : existing.gitBranch,
        ...(folders ? { folders, path: folders[0]! } : {}),
      };
      updated = list[index];
    });

    if (!updated) throw new HttpError(404, `Project ${id} not found`);
    if (folders) logger.info("projects", `Workspace ${updated.name} now has ${folders.length} ${folders.length === 1 ? "folder" : "folders"}`);
    return withFolders(updated);
  }

  /** Removes the project and its chats from Saturn. The folder and its files are never touched. */
  async delete(id: string): Promise<void> {
    let chats = 0;
    const stopped: string[] = [];
    await this.kernel.store.update((state) => {
      const list = state.projects ?? [];
      const remaining = list.filter((p) => p.id !== id);
      state.projects = remaining;
      const gone = new Set((state.threads ?? []).filter((thread) => thread.projectId === id).map((thread) => thread.id));
      chats = gone.size;
      state.threads = (state.threads ?? []).filter((thread) => !gone.has(thread.id));
      stopped.push(...state.runs.filter((run) => run.threadId && gone.has(run.threadId)).map((run) => run.id));
      state.runs = state.runs.filter((run) => !run.threadId || !gone.has(run.threadId));
      if (state.activeProjectId === id) {
        state.activeProjectId = remaining[0]?.id ?? null;
      }
    });
    // Anything still working in those chats stops with them.
    for (const [key, controller] of this.kernel.stops) {
      if (stopped.some((runId) => key.startsWith(`${runId}:`))) controller.abort();
    }
    logger.info("projects", `Removed project ${id} and its ${chats} ${chats === 1 ? "chat" : "chats"} (files untouched)`);
  }

  /**
   * What Saturn IDE opens: the folder itself, or for a multi-folder workspace a generated .code-workspace
   * (under the data directory) so every folder shows in one multi-root window.
   */
  private async ideTarget(project: Project): Promise<string> {
    const folders = project.folders?.length ? project.folders : [project.path];
    if (folders.length === 1) return folders[0]!;
    // One directory per workspace, the file named after it, so the IDE's window title is the workspace name.
    const dir = path.join(this.kernel.store.root, "workspaces", project.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${project.name.replace(/[^\w .-]+/g, "-").trim() || "Workspace"}.code-workspace`);
    await writeFile(file, `${JSON.stringify({ folders: folders.map((folder) => ({ path: folder })), settings: {} }, null, 2)}\n`);
    return file;
  }

  /**
   * `open` arguments that hand this runtime's address and data folder to the IDE it starts, so that IDE talks to
   * this runtime (and finds its session token) even when it is not on the default port. An IDE that is already
   * running keeps its own settings.
   */
  private ideEnv(): string[] {
    return ["--env", `SATURN_RUNTIME_PORT=${process.env.SATURN_RUNTIME_PORT ?? 4700}`, "--env", `SATURN_DATA_DIR=${this.kernel.store.root}`];
  }

  /** Starts Saturn IDE on `target` (a folder or .code-workspace), handing it this runtime's port and data folder. */
  private launchIde(ide: string, target?: string): void {
    this.kernel.clients.expect("ide");
    if (process.platform === "darwin") {
      launchApp("Saturn IDE", "open", [...this.ideEnv(), "-a", ide, ...(target ? [target] : [])]);
      return;
    }
    const binary = path.join(ide, ...ideLayout().binary);
    const child = spawn(binary, target ? [target] : [], {
      detached: true,
      stdio: "ignore",
      env: { ...launchEnv(), SATURN_RUNTIME_PORT: String(process.env.SATURN_RUNTIME_PORT ?? 4700), SATURN_DATA_DIR: this.kernel.store.root },
      ...(process.platform === "win32" ? { windowsHide: false } : {}),
    });
    child.on("error", (error) => logger.warn("projects", `Could not launch Saturn IDE: ${errorText(error)}`));
    child.unref();
  }

  /** Opens the workspace in Saturn IDE, the IDE bundled with Saturn; never another editor. */
  async openEditor(id: string): Promise<{ opened: boolean; editor?: string }> {
    const projects = await this.list();
    const target = projects.find((p) => p.id === id);
    if (!target) throw new HttpError(404, `Project ${id} not found`);
    const ide = await findSaturnIde();
    if (!ide) {
      throw new HttpError(404, "Saturn IDE is not installed. Reinstall Saturn, or in development run npm run build:ide in desktop.");
    }
    this.launchIde(ide, await this.ideTarget(target));
    logger.info("projects", `Opened ${target.name} in Saturn IDE`);
    return { opened: true, editor: "Saturn IDE" };
  }

  /**
   * Wakes up the default application (Saturn IDE or Saturn Agent App) based on settings.launchApp.
   */
  async wakeupDefaultApp(): Promise<{ target: "ide" | "agent"; opened: boolean }> {
    const setting = this.kernel.store.state.settings.launchApp ?? "agent";
    if (setting === "ide") {
      const ide = await findSaturnIde();
      if (ide) {
        try {
          const active = await this.getActive();
          this.launchIde(ide, await this.ideTarget(active));
          logger.info("projects", `Woke up Saturn IDE with project ${active.name}`);
        } catch {
          this.launchIde(ide);
          logger.info("projects", `Woke up Saturn IDE`);
        }
        return { target: "ide", opened: true };
      }
      logger.warn("projects", `Saturn IDE not found on this system, falling back to Agent App`);
    }

    if (process.env.SATURN_DESKTOP_ATTACHED === "1") {
      logger.info("projects", "Agent App attached; ready for wake");
      return { target: "agent", opened: true };
    }

    if (process.platform === "darwin") {
      const app = await findSaturnAgentApp();
      if (app) {
        launchApp("Saturn Agent App", "open", ["-a", app]);
        logger.info("projects", `Woke up Saturn Agent App (${app})`);
        return { target: "agent", opened: true };
      }
      launchApp("Saturn Agent App", "open", ["-b", "inc.saturntechnology.desktop"]);
      logger.info("projects", `Woke up Saturn Agent App via bundle id`);
      return { target: "agent", opened: true };
    }
    // Packaged on Windows or Linux, the runtime runs on Saturn's own executable (ELECTRON_RUN_AS_NODE): starting
    // that executable without the Node flag (launchEnv strips ELECTRON_*) opens the Agent App.
    if (process.versions.electron) {
      launchApp("Saturn Agent App", process.execPath, []);
      logger.info("projects", `Woke up Saturn Agent App (${process.execPath})`);
      return { target: "agent", opened: true };
    }

    return { target: "agent", opened: false };
  }

  async openTerminal(id: string): Promise<{ opened: boolean; cwd: string }> {
    const projects = await this.list();
    const target = projects.find((p) => p.id === id);
    if (!target) throw new HttpError(404, `Project ${id} not found`);

    if (process.platform === "darwin") {
      launchApp("Terminal", "open", ["-a", "Terminal", target.path]);
    } else if (process.platform === "win32") {
      launchApp("cmd", "cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${target.path}"`]);
    } else {
      launchApp("terminal", "x-terminal-emulator", ["--working-directory", target.path]);
    }
    return { opened: true, cwd: target.path };
  }

  async openFolder(id: string): Promise<{ opened: boolean; path: string }> {
    const projects = await this.list();
    const target = projects.find((p) => p.id === id);
    if (!target) throw new HttpError(404, `Project ${id} not found`);

    if (process.platform === "darwin") {
      launchApp("Finder", "open", [target.path]);
    } else if (process.platform === "win32") {
      launchApp("Explorer", "explorer.exe", [target.path]);
    } else {
      launchApp("file manager", "xdg-open", [target.path]);
    }
    return { opened: true, path: target.path };
  }

  async getRules(id: string): Promise<{ content: string; source: "cursorrules" | "agents" | "stored" | "none"; path?: string; sources: RuleSource[] }> {
    const projects = await this.list();
    const target = projects.find((p) => p.id === id);
    if (!target) throw new HttpError(404, `Project ${id} not found`);
    // Every file the agents' prompt takes rules from (rules.ts), for the editor and the IDE.
    const { sources } = await projectRules(target.path, target.rules ?? "");
    return { ...(await this.editableRules(target)), sources };
  }

  private async editableRules(target: Project): Promise<{ content: string; source: "cursorrules" | "agents" | "stored" | "none"; path?: string }> {

    // 1. Check for .cursorrules
    const cursorRulesPath = path.join(target.path, ".cursorrules");
    try {
      const content = await readFile(cursorRulesPath, "utf8");
      return { content, source: "cursorrules", path: cursorRulesPath };
    } catch {
      // Ignore
    }

    // 2. Check for .agents/rules/project.md
    const agentsRulesPath = path.join(target.path, ".agents", "rules", "project.md");
    try {
      const content = await readFile(agentsRulesPath, "utf8");
      return { content, source: "agents", path: agentsRulesPath };
    } catch {
      // Ignore
    }

    // 3. Stored rules in project
    if (target.rules) {
      return { content: target.rules, source: "stored" };
    }

    return { content: "", source: "none" };
  }

  async saveRules(id: string, content: string, targetFile?: "cursorrules" | "agents"): Promise<{ saved: boolean }> {
    const projects = await this.list();
    const target = projects.find((p) => p.id === id);
    if (!target) throw new HttpError(404, `Project ${id} not found`);

    await this.update(id, { rules: content });

    if (targetFile === "cursorrules") {
      const filePath = path.join(target.path, ".cursorrules");
      await writeFile(filePath, content, "utf8");
    } else if (targetFile === "agents") {
      const dirPath = path.join(target.path, ".agents", "rules");
      await mkdir(dirPath, { recursive: true });
      const filePath = path.join(dirPath, "project.md");
      await writeFile(filePath, content, "utf8");
    }

    return { saved: true };
  }
}
