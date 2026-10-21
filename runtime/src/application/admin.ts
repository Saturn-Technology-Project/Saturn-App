import { HttpError } from "../domain/errors.js";
import type { AppSettings } from "../domain/model.js";
import { sandboxMode, type SandboxSettings } from "../infrastructure/sandbox.js";
import { logLevel, logger } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";

/** Local settings, runtime identity, and the in-app log. */
export class AdminService {
  constructor(private readonly kernel: RuntimeKernel) {}

  settings(): AppSettings {
    return this.kernel.store.state.settings;
  }

  async updateSettings(patch: Partial<Omit<AppSettings, "sandbox">> & { onboardedAt?: string | null; sandbox?: SandboxSettings | null }): Promise<AppSettings> {
    const logging = patch.logging;
    if (logging && !["debug", "info", "warning", "error"].includes(logging)) {
      throw new HttpError(400, "Unknown logging level");
    }
    const launchApp = patch.launchApp;
    if (launchApp && launchApp !== "agent" && launchApp !== "ide") {
      throw new HttpError(400, "launchApp must be \"agent\" or \"ide\"");
    }
    const completionModelId = patch.completionModelId === undefined ? undefined : patch.completionModelId || null;
    if (completionModelId && !this.kernel.store.state.models.some((item) => item.id === completionModelId)) {
      throw new HttpError(400, "Unknown completion model");
    }
    const embeddingSource = patch.embeddingSource;
    if (embeddingSource !== undefined && !["builtin", "lmstudio", "openai"].includes(embeddingSource)) {
      throw new HttpError(400, "embeddingSource must be builtin, lmstudio or openai");
    }
    if (patch.embeddingConnectionId && !this.kernel.store.state.models.some((item) => item.id === patch.embeddingConnectionId)) {
      throw new HttpError(400, "Unknown model connection for embeddings");
    }
    const sandbox = patch.sandbox === undefined ? undefined : patch.sandbox === null ? null : checkSandbox(patch.sandbox);
    const previous = this.kernel.store.state.settings;
    let next = previous;
    await this.kernel.store.update((state) => {
      state.settings = {
        name: patch.name?.trim() || state.settings.name,
        environment: patch.environment?.trim() || state.settings.environment,
        logging: logging ?? state.settings.logging,
        launchApp: launchApp ?? state.settings.launchApp,
        claudeCodeAuth: state.settings.claudeCodeAuth,
        completionModelId: completionModelId === undefined ? state.settings.completionModelId ?? null : completionModelId,
        memory: typeof patch.memory === "boolean" ? patch.memory : state.settings.memory,
        planApproval: typeof patch.planApproval === "boolean" ? patch.planApproval : state.settings.planApproval,
        // Edited through /permissions, never through this patch.
        permissions: state.settings.permissions,
        sandbox: sandbox === undefined ? state.settings.sandbox : sandbox ?? undefined,
        // Edited through /hooks and /plugins, never through this patch.
        hooks: state.settings.hooks,
        plugins: state.settings.plugins,
        claudeProjectSettings: typeof patch.claudeProjectSettings === "boolean" ? patch.claudeProjectSettings : state.settings.claudeProjectSettings,
        browser: patch.browser === "saturn" || patch.browser === "system" ? patch.browser : state.settings.browser,
        embeddingSource: embeddingSource ?? state.settings.embeddingSource,
        embeddingModel: typeof patch.embeddingModel === "string" ? patch.embeddingModel.trim() || undefined : state.settings.embeddingModel,
        embeddingConnectionId: typeof patch.embeddingConnectionId === "string" ? patch.embeddingConnectionId || undefined : state.settings.embeddingConnectionId,
        // null starts the onboarding over (Settings → About → Run onboarding again).
        onboardedAt: patch.onboardedAt === null ? undefined : typeof patch.onboardedAt === "string" ? patch.onboardedAt : state.settings.onboardedAt,
      };
      next = state.settings;
    });
    if (next.logging !== previous.logging) {
      // Written while the more verbose of the two levels is active, so the change is recorded either way.
      const target = logLevel(next.logging) ?? "info";
      const louder = ["debug", "info", "warning", "error"].indexOf(target) < ["debug", "info", "warning", "error"].indexOf(logger.level);
      if (louder) logger.level = target;
      logger.info("runtime", `Logging level changed from ${previous.logging} to ${next.logging}`);
      logger.level = target;
    }
    const renamed = next.name !== previous.name ? ` (name: ${next.name})` : "";
    const moved = next.environment !== previous.environment ? ` (environment: ${next.environment})` : "";
    const launch = next.launchApp !== previous.launchApp ? ` (opens ${next.launchApp === "ide" ? "Saturn IDE" : "the Agent App"} at launch)` : "";
    const completion = next.completionModelId !== previous.completionModelId
      ? ` (completion model: ${this.kernel.store.state.models.find((item) => item.id === next.completionModelId)?.name ?? "none"})`
      : "";
    this.kernel.log("runtime", "info", `Settings saved${renamed}${moved}${launch}${completion}`);
    return next;
  }

  information() {
    const settings = this.kernel.store.state.settings;
    return {
      version: "0.1.0",
      listen: `http://${process.env.SATURN_RUNTIME_HOST ?? "127.0.0.1"}:${process.env.SATURN_RUNTIME_PORT ?? 4700}`,
      name: settings.name,
      environment: settings.environment,
      runtimeId: "saturn-app",
      mcpServers: this.kernel.store.state.mcp.map((item) => item.id),
      secrets: this.kernel.store.secretsProtection(),
    };
  }

  listLogs(query: { service?: string; level?: string; q?: string }) {
    const floor = query.level === "error" ? 2 : query.level === "warn" || query.level === "warning" ? 1 : 0;
    const rank = (level: string) => (level === "error" ? 2 : level === "warning" ? 1 : 0);
    return logger.recent().filter((item) => {
      if (query.service && item.service !== query.service) return false;
      if (rank(item.level) < floor) return false;
      if (query.q && !item.message.toLowerCase().includes(query.q.toLowerCase())) return false;
      return true;
    });
  }
}

/** A sandbox setting from a request: a known mode, and whether commands may use the network. */
export function checkSandbox(value: unknown): SandboxSettings {
  const input = (value ?? {}) as { mode?: unknown; network?: unknown };
  const mode = sandboxMode(input.mode);
  if (!mode) throw new HttpError(400, "sandbox.mode must be workspace-write, read-only or off");
  return { mode, network: input.network !== false };
}
