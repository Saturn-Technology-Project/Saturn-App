import { projectRules, reallyInside, type RuleSource } from "./rules.js";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import type { Project } from "../domain/model.js";
import { errorText, logger } from "../infrastructure/logger.js";
import { terminalWindow } from "../infrastructure/shell.js";
import type { RuntimeKernel } from "./kernel.js";
import { checkSandbox } from "./admin.js";
import { Workspace } from "../domain/skills/workspace.js";
import { insideWorkspace } from "../infrastructure/skills/inside-workspace.js";
import type { SandboxSettings } from "../infrastructure/sandbox.js";
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

function launchApp(what: string, command: string, args: string[], cwd?: string): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", env: launchEnv(), ...(cwd ? { cwd } : {}) });
  child.on("error", (error) => logger.warn("projects", `Could not launch ${what}: ${errorText(error)}`));
  child.unref();
}

/**
 * Where Saturn Agent App (the desktop app) is: /Applications, ~/Applications,
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
   * inside Saturn.app, which is no place for agents, so it is the agents' own workspace folder.
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

  async update(id: string, patch: Partial<Omit<Project, "sandbox">> & { sandbox?: SandboxSettings | null }): Promise<Project> {
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
        verifyCommand: patch.verifyCommand !== undefined ? patch.verifyCommand.trim() || undefined : existing.verifyCommand,
        sandbox: patch.sandbox !== undefined ? (patch.sandbox === null ? undefined : checkSandbox(patch.sandbox)) : existing.sandbox,
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

  /** Brings up the Agent App when the runtime was started on its own. */
  async wakeupDefaultApp(): Promise<void> {
    if (process.platform === "darwin") {
      const app = await findSaturnAgentApp();
      if (app) {
        launchApp("Saturn Agent App", "open", ["-a", app]);
        logger.info("projects", `Woke up Saturn Agent App (${app})`);
        return;
      }
      launchApp("Saturn Agent App", "open", ["-b", "inc.saturntechnology.desktop"]);
      logger.info("projects", `Woke up Saturn Agent App via bundle id`);
      return;
    }
    // Packaged on Windows or Linux, the runtime runs on Saturn's own executable (ELECTRON_RUN_AS_NODE): starting
    // that executable without the Node flag (launchEnv strips ELECTRON_*) opens the Agent App.
    if (process.versions.electron) {
      launchApp("Saturn Agent App", process.execPath, []);
      logger.info("projects", `Woke up Saturn Agent App (${process.execPath})`);
    }
  }

  async openTerminal(id: string): Promise<{ opened: boolean; cwd: string }> {
    const projects = await this.list();
    const target = projects.find((p) => p.id === id);
    if (!target) throw new HttpError(404, `Project ${id} not found`);

    const window = terminalWindow(target.path);
    launchApp("a terminal", window.command, window.args, window.cwd);
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
    // Every file the agents' prompt takes rules from (rules.ts), for the editor.
    const { sources } = await projectRules(target.path, target.rules ?? "");
    return { ...(await this.editableRules(target)), sources };
  }

  private async editableRules(target: Project): Promise<{ content: string; source: "cursorrules" | "agents" | "stored" | "none"; path?: string }> {

    // 1. Check for .cursorrules
    const cursorRulesPath = path.join(target.path, ".cursorrules");
    try {
      if (!(await reallyInside(target.path, cursorRulesPath))) throw new Error("A link leads out of the project");
      const content = await readFile(cursorRulesPath, "utf8");
      return { content, source: "cursorrules", path: cursorRulesPath };
    } catch {
      // Ignore
    }

    // 2. Check for .agents/rules/project.md
    const agentsRulesPath = path.join(target.path, ".agents", "rules", "project.md");
    try {
      if (!(await reallyInside(target.path, agentsRulesPath))) throw new Error("A link leads out of the project");
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
    const workspace = new Workspace(target.path);

    if (targetFile === "cursorrules") {
      const filePath = await insideWorkspace(workspace, ".cursorrules");
      await writeFile(filePath, content, "utf8");
    } else if (targetFile === "agents") {
      const dirPath = path.join(target.path, ".agents", "rules");
      await mkdir(dirPath, { recursive: true });
      const filePath = await insideWorkspace(workspace, path.join(".agents", "rules", "project.md"));
      await writeFile(filePath, content, "utf8");
    }

    return { saved: true };
  }
}
