import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../domain/errors.js";
import type { Agent, Run } from "../domain/model.js";
import {
  describeRule,
  fromClaudeRule,
  isPermissionRule,
  resolvePermission,
  type PermissionDecision,
  type PermissionLayer,
  type PermissionRule,
  type PermissionScope,
} from "../domain/permissions.js";
import type { RuntimeKernel } from "./kernel.js";

/** The project's own rules, shared through version control. */
export const PROJECT_SETTINGS_FILE = ".saturn/settings.json";
/** Claude Code's project settings; its `permissions.allow/deny/ask` are read too, as far as they translate. */
export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";

export type PermissionLayerView = PermissionLayer & {
  /** Saturn saves rules in the user, project and agent layers; the two file layers are read from the project folder. */
  editable: boolean;
  label: string;
};

/**
 * Permission rules for tool calls, in layers: the user's own (every agent, every project), a project's, an
 * agent's, then the project's `.saturn/settings.json` and `.claude/settings.json`. `decide()` is what the run
 * loop asks before each tool call; the built-in sensitive-command check still applies when no rule speaks.
 */
export class PermissionService {
  constructor(private readonly kernel: RuntimeKernel) {}

  /** Every layer that applies to an agent working in a project, most specific last (order does not change the outcome). */
  async layers(input: { agentId?: string; projectId?: string }): Promise<PermissionLayerView[]> {
    const state = this.kernel.store.state;
    const layers: PermissionLayerView[] = [{ scope: "user", rules: state.settings.permissions ?? [], editable: true, label: "Everywhere" }];
    const project = input.projectId ? (state.projects ?? []).find((item) => item.id === input.projectId) : undefined;
    if (project) {
      layers.push({ scope: "project", rules: project.permissions ?? [], editable: true, label: project.name });
      const saturn = await readProjectRules(path.join(project.path, PROJECT_SETTINGS_FILE));
      if (saturn) layers.push({ scope: "project-file", rules: saturn, path: PROJECT_SETTINGS_FILE, editable: false, label: PROJECT_SETTINGS_FILE });
      const claude = await readClaudeRules(path.join(project.path, CLAUDE_SETTINGS_FILE));
      if (claude) layers.push({ scope: "claude-file", rules: claude, path: CLAUDE_SETTINGS_FILE, editable: false, label: CLAUDE_SETTINGS_FILE });
    }
    const agent = input.agentId ? state.agents.find((item) => item.id === input.agentId) : undefined;
    if (agent) layers.push({ scope: "agent", rules: agent.permissions ?? [], editable: true, label: agent.name });
    return layers;
  }

  /** What the rules say about one tool call of a run, or undefined when none applies. */
  async decide(agent: Agent, run: Pick<Run, "threadId">, toolId: string, args: Record<string, unknown>): Promise<PermissionDecision | undefined> {
    const thread = run.threadId ? (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    const layers = await this.layers({ agentId: agent.id, projectId: thread?.projectId });
    return resolvePermission(layers, toolId, args);
  }

  /** The reason shown on a card or a denied step: which rule, from where. */
  explain(decision: PermissionDecision): string {
    const where = decision.path ?? decision.scope;
    return `${decision.effect === "deny" ? "Denied" : decision.effect === "ask" ? "Asks" : "Allowed"} by a permission rule (${where}: ${describeRule(decision.rule)})`;
  }

  async addRule(scope: PermissionScope, rule: unknown, target: { projectId?: string; agentId?: string } = {}): Promise<PermissionLayerView[]> {
    const checked = checkRule(rule);
    await this.edit(scope, target, (rules) => {
      const same = rules.find((item) => item.tool === checked.tool && item.pattern === checked.pattern);
      if (same) same.effect = checked.effect;
      else rules.push(checked);
    });
    this.kernel.log("runtime", "info", `Permission rule added (${scope}): ${checked.effect} ${describeRule(checked)}`);
    return this.layers(target);
  }

  async removeRule(scope: PermissionScope, rule: unknown, target: { projectId?: string; agentId?: string } = {}): Promise<PermissionLayerView[]> {
    const checked = checkRule(rule);
    await this.edit(scope, target, (rules) => {
      const index = rules.findIndex((item) => item.tool === checked.tool && item.pattern === checked.pattern && item.effect === checked.effect);
      if (index >= 0) rules.splice(index, 1);
    });
    return this.layers(target);
  }

  private async edit(scope: PermissionScope, target: { projectId?: string; agentId?: string }, change: (rules: PermissionRule[]) => void): Promise<void> {
    if (scope === "project-file" || scope === "claude-file") throw new HttpError(400, `Rules in ${scope === "project-file" ? PROJECT_SETTINGS_FILE : CLAUDE_SETTINGS_FILE} are edited in that file.`);
    if (scope === "project" && !target.projectId) throw new HttpError(400, "A project rule needs projectId");
    if (scope === "agent" && !target.agentId) throw new HttpError(400, "An agent rule needs agentId");
    await this.kernel.store.update((state) => {
      if (scope === "user") {
        state.settings.permissions ??= [];
        change(state.settings.permissions);
      } else if (scope === "project") {
        const project = (state.projects ?? []).find((item) => item.id === target.projectId);
        if (!project) throw new HttpError(404, "Project not found");
        project.permissions ??= [];
        change(project.permissions);
      } else {
        const agent = state.agents.find((item) => item.id === target.agentId);
        if (!agent) throw new HttpError(404, "Agent not found");
        agent.permissions ??= [];
        change(agent.permissions);
      }
    });
  }
}

function checkRule(value: unknown): PermissionRule {
  if (!isPermissionRule(value)) throw new HttpError(400, "A rule needs a tool, a pattern, and an effect of allow, deny or ask");
  const pattern = value.pattern.trim();
  if (!pattern) throw new HttpError(400, "The rule's pattern is empty");
  if (value.tool === "code" && pattern === "*" && value.effect === "allow") throw new HttpError(400, "Allowing every shell command is not a rule; set the agent's approval mode instead.");
  return { tool: value.tool.trim(), pattern, effect: value.effect };
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `.saturn/settings.json`: `{ "permissions": { "rules": [{ tool, pattern, effect }] } }`. */
async function readProjectRules(file: string): Promise<PermissionRule[] | undefined> {
  const json = await readJson(file);
  const permissions = json?.permissions as { rules?: unknown } | undefined;
  if (!Array.isArray(permissions?.rules)) return undefined;
  return permissions.rules.filter(isPermissionRule).map((rule) => ({ tool: rule.tool, pattern: rule.pattern, effect: rule.effect }));
}

/** `.claude/settings.json`: `{ "permissions": { "allow": [...], "deny": [...], "ask": [...] } }`, translated where possible. */
async function readClaudeRules(file: string): Promise<PermissionRule[] | undefined> {
  const json = await readJson(file);
  const permissions = json?.permissions as Record<string, unknown> | undefined;
  if (!permissions) return undefined;
  const rules: PermissionRule[] = [];
  for (const effect of ["allow", "deny", "ask"] as const) {
    const list = permissions[effect];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== "string") continue;
      const rule = fromClaudeRule(item, effect);
      if (rule) rules.push(rule);
    }
  }
  return rules.length ? rules : undefined;
}
