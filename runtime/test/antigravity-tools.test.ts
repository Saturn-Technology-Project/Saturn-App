import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/presentation/app.js";
import { FileStore } from "../src/infrastructure/store.js";
import {
  ANTIGRAVITY_SKILLS_ID,
  antigravitySkills,
} from "../src/domain/builtin.js";
import { runAntigravitySkill } from "../src/infrastructure/skills.js";
import { buildSystemPrompt } from "../src/domain/policies.js";
import type { McpConnection } from "../src/domain/model.js";

test("antigravity tools definitions contain 14 tools and skips duplicate github tools", () => {
  const ag = antigravitySkills();
  assert.equal(ag.id, ANTIGRAVITY_SKILLS_ID);
  assert.equal(ag.tools.length, 14);

  const reads = ag.tools.filter((t) => t.category === "read");
  const writes = ag.tools.filter((t) => t.category === "write");
  assert.equal(reads.length, 5);
  assert.equal(writes.length, 9);

  // Verifies duplicate git permission tools were skipped (since Cursor's Origin has 31 git tools)
  assert.ok(!ag.tools.some((t) => t.toolId.includes("permissioned_github")));
  assert.ok(!ag.tools.some((t) => t.toolId === "github_permission"));

  // Verifies all 7 unique Antigravity capability modules are present
  assert.ok(ag.tools.some((t) => t.toolId === "automation_create"));
  assert.ok(ag.tools.some((t) => t.toolId === "generative_ui_template"));
  assert.ok(ag.tools.some((t) => t.toolId === "customizations_create_skill"));
  assert.ok(ag.tools.some((t) => t.toolId === "workflows_migrate"));
  assert.ok(ag.tools.some((t) => t.toolId === "plugins_bundle"));
  // Tools that only pretended (sidecar:// pills nothing renders, Google's docs) are gone.
  assert.ok(!ag.tools.some((t) => /^ui_navigation_|^guide_|^generative_ui_render$/.test(t.toolId)));
});

test("antigravity skill executes automations and serves UI templates", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "saturn-ag-test-"));
  const store = new FileStore(dataDir);
  await store.load();
  const { services } = createApp(store);
  const agent = await services.createAgent({ name: "Syncer" });
  // The same context runs.ts gives the skill: the runtime's AutomationService and the calling agent.
  const context = { automations: services.kernel.automations, agentId: agent.id };

  // 1. Automation creation & list go through the runtime's service, not state.json.
  const created = (await runAntigravitySkill(dataDir, "automation_create", {
    name: "Nightly Sync",
    prompt: "Sync all issues and summarize",
    cron: "CRON_TZ=Asia/Taipei 0 9 * * 1-5",
  }, undefined, context)) as { success: boolean; automation: { id: string; name: string; agentId: string; cron: string } };
  assert.ok(created.success);
  assert.equal(created.automation.name, "Nightly Sync");
  assert.equal(created.automation.agentId, agent.id, "defaults to the calling agent");
  assert.equal(created.automation.cron, "CRON_TZ=Asia/Taipei 0 9 * * 1-5");
  const stored = store.state.automations.find((item) => item.id === created.automation.id);
  assert.deepEqual(stored?.trigger, { frequency: "weekdays", time: "09:00", weekday: 1 });
  assert.equal(stored?.timeZone, "Asia/Taipei");

  const list = (await runAntigravitySkill(dataDir, "automation_list", {}, undefined, context)) as {
    total: number;
    automations: Array<{ id: string; name: string }>;
  };
  assert.equal(list.total, 1);
  assert.equal(list.automations[0]?.name, "Nightly Sync");

  await runAntigravitySkill(dataDir, "automation_toggle", { automationId: created.automation.id, enabled: false }, undefined, context);
  assert.equal(store.state.automations[0]?.enabled, false);

  await assert.rejects(
    () => runAntigravitySkill(dataDir, "automation_create", { name: "x", prompt: "y", cron: "*/5 * * * *" }, undefined, context),
    /Unsupported schedule/,
  );
  await assert.rejects(() => runAntigravitySkill(dataDir, "automation_list", {}), /only available inside the Saturn runtime/);

  await runAntigravitySkill(dataDir, "automation_delete", { automationId: created.automation.id }, undefined, context);
  assert.equal(store.state.automations.length, 0);

  // 2. Generative UI render & template
  const tmpl = (await runAntigravitySkill(dataDir, "generative_ui_template", {
    type: "metrics_dashboard",
  })) as { type: string; template: string };
  assert.ok(tmpl.template.includes("System Uptime"));

  await assert.rejects(() => runAntigravitySkill(dataDir, "guide_sitemap", {}), /Unknown Antigravity skill tool/);
});

test("antigravity skill manages customizations, workflows, and plugins", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "saturn-ag-test2-"));

  // Customizations: create skill
  const skill = (await runAntigravitySkill(dataDir, "customizations_create_skill", {
    name: "test-skill",
    description: "Skill for testing",
    instructions: "Run tests and verify",
  })) as { success: boolean; name: string };
  assert.ok(skill.success);
  assert.equal(skill.name, "test-skill");

  // Customizations: create rule
  const rule = (await runAntigravitySkill(dataDir, "customizations_create_rule", {
    name: "coding-standard",
    content: "# Coding Standards\nUse TypeScript strictly.",
  })) as { success: boolean; name: string };
  assert.ok(rule.success);
  assert.equal(rule.name, "coding-standard.md");

  // Plugins: bundle & list
  const bundle = (await runAntigravitySkill(dataDir, "plugins_bundle", {
    name: "my-pack",
    displayName: "My Pack",
    description: "A bundle of skills",
    skills: ["test-skill"],
  })) as { success: boolean; plugin: { name: string } };
  assert.ok(bundle.success);
  assert.equal(bundle.plugin.name, "my-pack");
});

test("built-in antigravity skills are installed by kernel and configured properly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "saturn-ag-store-"));
  const store = new FileStore(dir);
  await store.load();
  const { services } = createApp(store);

  const mcpList = await services.listConnections("mcp");
  const agServer = (mcpList as McpConnection[]).find((item) => item.id === ANTIGRAVITY_SKILLS_ID);
  assert.ok(agServer, "automations must be installed by default");
  assert.equal(agServer.name, "Automations");
  assert.equal(agServer.url, "builtin://automations");
  assert.equal(agServer.tools.length, 14);

  // Test tool disabling
  const updated = await services.updateMcp(ANTIGRAVITY_SKILLS_ID, {
    disabledTools: ["automation_delete"],
  });
  assert.deepEqual(updated.disabledTools, ["automation_delete"]);
});

test("buildSystemPrompt informs model of Antigravity Skills capabilities", () => {
  const prompt = buildSystemPrompt({
    agent: {
      id: "agent-1",
      name: "Assistant",
      instructions: "Be helpful",
      description: "",
      responseStyle: "professional",
      autonomy: "execute_when_allowed",
      mcpConnectionIds: ["automations"],
      temperature: 0.2,
      maxOutput: 4000,
      status: "active",
      canEdit: true,
      modelConnectionId: null,
      ragConnectionIds: [],
    },
    serverIds: ["automations"],
  });

  assert.ok(prompt.includes("Automations & Antigravity Capabilities (Automations)"));
  assert.ok(prompt.includes("automation_create"));
  assert.ok(prompt.includes("generative_ui_template"));
  assert.ok(!prompt.includes("sidecar://") && !prompt.includes("guide_sitemap"), "the prompt no longer promises tools that pretended");
  assert.ok(prompt.includes("customizations_create_skill"));
  assert.ok(prompt.includes("workflows_migrate"));
});
