import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState } from "../domain/model.js";

const empty = (): AppState => ({
  agents: [],
  models: [],
  mcp: [],
  rag: [],
  runs: [],
  broker: [],
  settings: {
    name: "Saturn",
    environment: "production",
    heartbeatSeconds: 25,
    logging: "info",
  },
  account: null,
  session: {
    paired: false,
    connected: false,
    sessionId: null,
    organizationId: null,
    apiBase: null,
    wsUrl: null,
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
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved.settings ?? {}) },
      session: { ...base.session, ...(saved.session ?? {}) },
      agents: saved.agents ?? base.agents,
      models: saved.models ?? base.models,
      mcp: saved.mcp ?? base.mcp,
      rag: saved.rag ?? base.rag,
      runs: saved.runs ?? base.runs,
      broker: saved.broker ?? base.broker,
      account: saved.account ?? null,
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

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(path.join(this.directory, name), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}
