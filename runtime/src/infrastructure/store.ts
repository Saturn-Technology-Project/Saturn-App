import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState } from "../domain/model.js";
import { errorText, logger } from "./logger.js";
import { instruments, seconds, traced } from "./telemetry.js";

const empty = (): AppState => ({
  projects: [],
  activeProjectId: null,
  agents: [],
  automations: [],
  models: [],
  mcp: [],
  rag: [],
  runs: [],
  threads: [],
  groups: [],
  groupMessages: [],
  usage: [],
  settings: {
    name: "Saturn",
    environment: "production",
    logging: "info",
    launchApp: "agent",
  },
});

export class FileStore {
  private queue: Promise<void> = Promise.resolve();
  private secrets = new Map<string, string>();

  constructor(private readonly directory: string) {}

  get root(): string {
    return this.directory;
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const saved = await this.readJson<Partial<AppState>>("state.json", {});
    const base = empty();
    this.state = {
      projects: saved.projects ?? base.projects ?? [],
      activeProjectId: saved.activeProjectId ?? base.activeProjectId ?? null,
      agents: saved.agents ?? base.agents,
      automations: saved.automations ?? base.automations,
      models: saved.models ?? base.models,
      mcp: saved.mcp ?? base.mcp,
      rag: saved.rag ?? base.rag,
      runs: saved.runs ?? base.runs,
      threads: saved.threads ?? base.threads ?? [],
      groups: saved.groups ?? [],
      groupMessages: saved.groupMessages ?? [],
      usage: saved.usage ?? base.usage,
      settings: {
        name: saved.settings?.name ?? base.settings.name,
        environment: saved.settings?.environment ?? base.settings.environment,
        logging: saved.settings?.logging ?? base.settings.logging,
        launchApp: saved.settings?.launchApp === "ide" ? "ide" : base.settings.launchApp,
        claudeCodeAuth: saved.settings?.claudeCodeAuth === "api-key" ? "api-key" : "subscription",
        completionModelId: saved.settings?.completionModelId ?? null,
      },
    };
    const secrets = await this.readJson<Record<string, string>>("secrets.json", {});
    this.secrets = new Map(Object.entries(secrets));
  }

  state: AppState = empty();

  update(change: (state: AppState) => void): Promise<AppState> {
    const run = this.queue.then(async () => {
      change(this.state);
      await this.persist();
      return this.state;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  putSecret(id: string, value: string): Promise<void> {
    return this.update(() => {
      this.secrets.set(id, value);
    }).then(() => undefined);
  }

  secret(id: string): string | undefined {
    return this.secrets.get(id);
  }

  deleteSecret(id: string): Promise<void> {
    return this.update(() => {
      this.secrets.delete(id);
    }).then(() => undefined);
  }

  private async persist(): Promise<void> {
    const startedAt = performance.now();
    try {
      await traced("store.persist", { attributes: { "saturn.store.runs": this.state.runs.length } }, () => this.write());
    } catch (error) {
      logger.error("store", `Could not save state to ${this.directory}: ${errorText(error)}`);
      throw error;
    }
    instruments().storeWrites.record(seconds(startedAt));
  }

  private async write(): Promise<void> {
    await writeFile(
      path.join(this.directory, "state.json"),
      JSON.stringify(this.state, null, 2),
    );
    await writeFile(
      path.join(this.directory, "secrets.json"),
      JSON.stringify(Object.fromEntries(this.secrets), null, 2),
      { mode: 0o600 },
    );
  }

  /**
   * A missing file is a first start. An unreadable one would be overwritten by the next save,
   * so a copy is kept next to it and the loss is logged.
   */
  private async readJson<T>(name: string, fallback: T): Promise<T> {
    const file = path.join(this.directory, name);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.debug("store", `No ${name} yet; starting empty`);
      } else {
        logger.error("store", `Could not read ${file}: ${errorText(error)}; starting empty`);
      }
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      const backup = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await copyFile(file, backup).catch(() => undefined);
      logger.error("store", `${name} is not valid JSON (${errorText(error)}); starting empty. The old file was kept as ${path.basename(backup)}`);
      return fallback;
    }
  }
}
