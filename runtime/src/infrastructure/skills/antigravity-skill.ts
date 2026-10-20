import fs from "node:fs/promises";
import path from "node:path";
import type { Automation, AutomationTrigger } from "../../domain/model.js";
import { cronToTrigger, triggerToCron } from "../../domain/schedule.js";

type AutomationRecord = Automation & { agentName: string; nextRun: string | null };
type AutomationPatch = Partial<Pick<Automation, "name" | "agentId" | "prompt" | "trigger" | "timeZone" | "enabled">>;

/**
 * The runtime's automation service (application/automations.ts). Automation tools go through it, so
 * they get the same validation, scheduling, logs and telemetry as the Automations page, and never
 * write state.json behind the runtime's back.
 */
export type AutomationPort = {
  list(): AutomationRecord[];
  create(input: AutomationPatch): Promise<AutomationRecord>;
  update(id: string, patch: AutomationPatch): Promise<AutomationRecord>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<AutomationRecord>;
};

export type AntigravityContext = {
  automations?: AutomationPort;
  /** The agent making the call; new automations run on it unless the tool names another. */
  agentId?: string;
  workspaceDir?: string;
};

export class AntigravitySkill {
  private readonly workspaceDir: string;
  private readonly automations?: AutomationPort;
  private readonly agentId?: string;

  constructor(_dataDir: string, context: AntigravityContext = {}) {
    this.workspaceDir = context.workspaceDir || process.cwd();
    this.automations = context.automations;
    this.agentId = context.agentId;
  }

  async run(toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error("Operation aborted");

    switch (toolId) {
      // --- Automation ---
      case "automation_list":
        return this.automationList(args);
      case "automation_create":
        return this.automationCreate(args);
      case "automation_trigger":
        return this.automationTrigger(args);
      case "automation_toggle":
        return this.automationToggle(args);
      case "automation_delete":
        return this.automationDelete(args);

      // --- Generative UI ---
      case "generative_ui_template":
        return this.generativeUiTemplate(args);

      // --- Customizations & Rules ---
      case "customizations_list":
        return this.customizationsList(args);
      case "customizations_create_skill":
        return this.customizationsCreateSkill(args);
      case "customizations_create_rule":
        return this.customizationsCreateRule(args);

      // --- Workflows ---
      case "workflows_scan":
        return this.workflowsScan(args);
      case "workflows_migrate":
        return this.workflowsMigrate(args);

      // --- Plugins ---
      case "plugins_list":
        return this.pluginsList(args);
      case "plugins_bundle":
        return this.pluginsBundle(args);
      case "plugins_toggle":
        return this.pluginsToggle(args);

      default:
        throw new Error(`Unknown Antigravity skill tool: ${toolId}`);
    }
  }

  // --------------------------------------------------------------------------
  // Automations (through the runtime's AutomationService)
  // --------------------------------------------------------------------------
  private service(): AutomationPort {
    if (!this.automations) throw new Error("Automations are only available inside the Saturn runtime");
    return this.automations;
  }

  private describe(item: AutomationRecord) {
    return {
      id: item.id,
      name: item.name,
      prompt: item.prompt,
      cron: describeCron(item.trigger, item.timeZone),
      timeZone: item.timeZone,
      enabled: item.enabled,
      agentId: item.agentId,
      agentName: item.agentName,
      nextRun: item.nextRun,
      lastRunAt: item.lastRunAt ?? null,
      lastError: item.lastError ?? null,
    };
  }

  private automationList(args: Record<string, unknown>) {
    const automations = this.service().list();
    const filter = (args.filter as string) || "all";
    const filtered = automations.filter((item) => (filter === "enabled" ? item.enabled : filter === "disabled" ? !item.enabled : true));
    return { total: automations.length, filter, automations: filtered.map((item) => this.describe(item)) };
  }

  private async automationCreate(args: Record<string, unknown>) {
    const agentId = args.agentId ? String(args.agentId) : this.agentId;
    if (!agentId) throw new Error("Name the agent that should run this automation (agentId)");
    const { trigger, timeZone } = cronToTrigger(String(args.cron ?? ""));
    const created = await this.service().create({
      name: String(args.name ?? ""),
      prompt: String(args.prompt ?? ""),
      agentId,
      trigger,
      timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: args.enabled !== false,
    });
    return {
      success: true,
      automation: this.describe(created),
      message: `Automation "${created.name}" created; next run ${created.nextRun ?? "when enabled"} (${created.timeZone}).`,
    };
  }

  private async automationTrigger(args: Record<string, unknown>) {
    const ran = await this.service().runNow(String(args.automationId ?? ""));
    return {
      success: !ran.lastError,
      automationId: ran.id,
      status: ran.lastError ? "failed" : "started",
      runId: ran.lastRunId ?? null,
      error: ran.lastError ?? null,
      message: ran.lastError ? `Automation "${ran.name}" could not start: ${ran.lastError}` : `Automation "${ran.name}" started a run.`,
    };
  }

  private async automationToggle(args: Record<string, unknown>) {
    const updated = await this.service().update(String(args.automationId ?? ""), { enabled: Boolean(args.enabled) });
    return {
      success: true,
      automationId: updated.id,
      enabled: updated.enabled,
      nextRun: updated.nextRun,
      message: `Automation "${updated.name}" is now ${updated.enabled ? "enabled" : "disabled"}.`,
    };
  }

  private async automationDelete(args: Record<string, unknown>) {
    const id = String(args.automationId ?? "");
    await this.service().remove(id);
    return { success: true, automationId: id, message: `Automation ${id} deleted.` };
  }

  // --------------------------------------------------------------------------
  // Generative UI
  // --------------------------------------------------------------------------
  private generativeUiTemplate(args: Record<string, unknown>) {
    const type = String(args.type || "empty_boilerplate");
    switch (type) {
      case "metrics_dashboard":
        return {
          type,
          template: `
<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
  <div class="p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
    <span class="text-xs text-[var(--muted-foreground)]">System Uptime</span>
    <div class="text-2xl font-bold text-[var(--foreground)] mt-1">99.98%</div>
    <span class="text-xs text-[var(--accent)] font-medium">↑ Healthy</span>
  </div>
  <div class="p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
    <span class="text-xs text-[var(--muted-foreground)]">Active Runs</span>
    <div class="text-2xl font-bold text-[var(--foreground)] mt-1">14</div>
    <span class="text-xs text-[var(--primary)] font-medium">4 in queue</span>
  </div>
  <div class="p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
    <span class="text-xs text-[var(--muted-foreground)]">Average Latency</span>
    <div class="text-2xl font-bold text-[var(--foreground)] mt-1">142ms</div>
    <span class="text-xs text-[var(--muted-foreground)] font-medium">p95: 280ms</span>
  </div>
</div>`,
        };
      case "interactive_filter":
        return {
          type,
          template: `
<div class="p-4 rounded-xl border border-[var(--border)] bg-[var(--card)] space-y-3">
  <div class="flex items-center justify-between">
    <h3 class="font-semibold text-sm">Status Filter</h3>
    <button class="text-xs text-[var(--primary)] hover:underline" onclick="resetFilters()">Reset</button>
  </div>
  <div class="flex gap-2">
    <button class="px-3 py-1 text-xs rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]">All</button>
    <button class="px-3 py-1 text-xs rounded-full border border-[var(--border)] hover:bg-white/5">Passed</button>
    <button class="px-3 py-1 text-xs rounded-full border border-[var(--border)] hover:bg-white/5">Failed</button>
  </div>
</div>`,
        };
      case "flow_diagram":
        return {
          type,
          template: `
<div class="p-5 rounded-xl border border-[var(--border)] bg-[var(--card)] flex items-center justify-between text-xs">
  <div class="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 font-mono">1. Ingest Query</div>
  <span class="text-[var(--muted-foreground)]">→</span>
  <div class="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400 font-mono">2. Context RAG</div>
  <span class="text-[var(--muted-foreground)]">→</span>
  <div class="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono">3. Execute Tools</div>
</div>`,
        };
      default:
        return {
          type: "empty_boilerplate",
          template: `
<div class="p-6 rounded-xl border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]">
  <h2 class="text-base font-semibold mb-2">Custom Widget Title</h2>
  <p class="text-sm text-[var(--muted-foreground)]">Interactive widget content goes here.</p>
</div>`,
        };
    }
  }

  // --------------------------------------------------------------------------
  // Customizations & Rules
  // --------------------------------------------------------------------------
  private async customizationsList(args: Record<string, unknown>) {
    const scope = String(args.scope || "all");
    const workspaceSkillsDir = path.join(this.workspaceDir, ".agents", "skills");
    const workspaceRulesDir = path.join(this.workspaceDir, ".agents", "rules");

    const skills: Array<{ name: string; path: string }> = [];
    const rules: Array<{ name: string; path: string }> = [];

    // Scan workspace skills
    try {
      const dirs = await fs.readdir(workspaceSkillsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          const skillFile = path.join(workspaceSkillsDir, d.name, "SKILL.md");
          try {
            await fs.access(skillFile);
            skills.push({ name: d.name, path: skillFile });
          } catch {}
        }
      }
    } catch {}

    // Scan workspace rules
    try {
      const files = await fs.readdir(workspaceRulesDir);
      for (const f of files) {
        if (f.endsWith(".md")) {
          rules.push({ name: f, path: path.join(workspaceRulesDir, f) });
        }
      }
    } catch {}

    return {
      scope,
      workspace: this.workspaceDir,
      discovered: {
        skillsCount: skills.length,
        skills,
        rulesCount: rules.length,
        rules,
      },
    };
  }

  private async customizationsCreateSkill(args: Record<string, unknown>) {
    const name = String(args.name || "custom-skill").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const description = String(args.description || "");
    const instructions = String(args.instructions || "");

    const skillDir = path.join(this.workspaceDir, ".agents", "skills", name);
    await fs.mkdir(skillDir, { recursive: true });
    const targetFile = path.join(skillDir, "SKILL.md");

    const content = `---
name: ${name}
description: >-
  ${description}
---

# ${name}

${instructions}
`;

    await fs.writeFile(targetFile, content, "utf8");
    return {
      success: true,
      name,
      path: targetFile,
      message: `Created on-demand skill "${name}" under .agents/skills/${name}/SKILL.md`,
    };
  }

  private async customizationsCreateRule(args: Record<string, unknown>) {
    const rawName = String(args.name || "rule");
    const ruleName = rawName.endsWith(".md") ? rawName : `${rawName}.md`;
    const content = String(args.content || "");

    const rulesDir = path.join(this.workspaceDir, ".agents", "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    const targetFile = path.join(rulesDir, ruleName);

    await fs.writeFile(targetFile, content, "utf8");
    return {
      success: true,
      name: ruleName,
      path: targetFile,
      message: `Created rule "${ruleName}" under .agents/rules/${ruleName}`,
    };
  }

  // --------------------------------------------------------------------------
  // Workflows
  // --------------------------------------------------------------------------
  private async workflowsScan(_args: Record<string, unknown>) {
    const scanDirs = [
      path.join(this.workspaceDir, ".agents", "workflows"),
      path.join(this.workspaceDir, "_agents", "workflows"),
    ];

    const discovered: Array<{ name: string; path: string }> = [];
    for (const d of scanDirs) {
      try {
        const files = await fs.readdir(d);
        for (const file of files) {
          if (file.endsWith(".md")) {
            discovered.push({ name: path.basename(file, ".md"), path: path.join(d, file) });
          }
        }
      } catch {}
    }

    return {
      total: discovered.length,
      workflows: discovered,
      recommendation: discovered.length > 0
        ? "Legacy workflows found. Use workflows_migrate to convert them into modern .agents/skills/<name>/SKILL.md format."
        : "No legacy workflows found in workspace.",
    };
  }

  private async workflowsMigrate(args: Record<string, unknown>) {
    const targetName = String(args.workflowName || "*");
    const archiveOld = args.archiveOld !== false;

    const workflowsDir = path.join(this.workspaceDir, ".agents", "workflows");
    const migrated: string[] = [];

    try {
      const files = await fs.readdir(workflowsDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const name = path.basename(file, ".md");
        if (targetName !== "*" && targetName !== name) continue;

        const srcPath = path.join(workflowsDir, file);
        const content = await fs.readFile(srcPath, "utf8");

        // Create target skill
        const skillDir = path.join(this.workspaceDir, ".agents", "skills", name);
        await fs.mkdir(skillDir, { recursive: true });
        const skillFile = path.join(skillDir, "SKILL.md");

        const convertedContent = content.startsWith("---")
          ? content
          : `---
name: ${name}
description: Migrated from legacy workflow ${name}
---

${content}
`;
        await fs.writeFile(skillFile, convertedContent, "utf8");
        migrated.push(name);

        if (archiveOld) {
          const archiveDir = path.join(workflowsDir, "archive");
          await fs.mkdir(archiveDir, { recursive: true });
          await fs.rename(srcPath, path.join(archiveDir, file));
        }
      }
    } catch {}

    return {
      success: true,
      migratedCount: migrated.length,
      migrated,
      archiveLocation: archiveOld ? ".agents/workflows/archive/" : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Plugins
  // --------------------------------------------------------------------------
  private async pluginsList(_args: Record<string, unknown>) {
    const pluginsDir = path.join(this.workspaceDir, "plugins");
    const plugins: Array<Record<string, unknown>> = [];

    try {
      const dirs = await fs.readdir(pluginsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          const manifestFile = path.join(pluginsDir, d.name, "plugin.json");
          try {
            const raw = await fs.readFile(manifestFile, "utf8");
            plugins.push(JSON.parse(raw));
          } catch {
            plugins.push({ name: d.name, status: "unconfigured" });
          }
        }
      }
    } catch {}

    return {
      total: plugins.length,
      plugins,
    };
  }

  private async pluginsBundle(args: Record<string, unknown>) {
    const name = String(args.name || "custom-plugin").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const manifest = {
      name,
      displayName: String(args.displayName || name),
      description: String(args.description || ""),
      skills: Array.isArray(args.skills) ? args.skills : [],
      mcpServers: Array.isArray(args.mcpServers) ? args.mcpServers : [],
      disabled: false,
      createdAt: new Date().toISOString(),
    };

    const pluginDir = path.join(this.workspaceDir, "plugins", name);
    await fs.mkdir(pluginDir, { recursive: true });
    const targetFile = path.join(pluginDir, "plugin.json");
    await fs.writeFile(targetFile, JSON.stringify(manifest, null, 2), "utf8");

    return {
      success: true,
      plugin: manifest,
      path: targetFile,
      message: `Created plugin bundle "${name}" with manifest plugin.json.`,
    };
  }

  private async pluginsToggle(args: Record<string, unknown>) {
    const name = String(args.pluginName || "");
    const enabled = Boolean(args.enabled);
    const targetFile = path.join(this.workspaceDir, "plugins", name, "plugin.json");

    try {
      const content = await fs.readFile(targetFile, "utf8");
      const manifest = JSON.parse(content);
      manifest.disabled = !enabled;
      await fs.writeFile(targetFile, JSON.stringify(manifest, null, 2), "utf8");
      return {
        success: true,
        pluginName: name,
        enabled,
        message: `Plugin "${name}" is now ${enabled ? "enabled" : "disabled"}.`,
      };
    } catch {
      throw new Error(`Plugin "${name}" manifest not found at ${targetFile}`);
    }
  }
}

function describeCron(trigger: AutomationTrigger, timeZone: string): string {
  return `CRON_TZ=${timeZone} ${triggerToCron(trigger)}`;
}
