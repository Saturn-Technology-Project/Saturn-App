import { HttpError } from "../domain/errors.js";
import { runsOnPlan } from "../domain/llm/catalog.js";
import { newId } from "../domain/ids.js";
import type { Automation } from "../domain/model.js";
import { clip, textOf } from "../domain/policies.js";
import { localMinute, nextSlot, previousSlot, slotLabel, triggerOf, validTimeZone } from "../domain/schedule.js";
import { failSpan, instruments, traced } from "../infrastructure/telemetry.js";
import type { RuntimeKernel } from "./kernel.js";

export type AutomationView = Automation & { agentName: string; nextRun: string | null };

type AutomationInput = Partial<Pick<Automation, "name" | "agentId" | "prompt" | "trigger" | "timeZone" | "enabled">>;

/** Scheduled prompts that start agent runs on their own. */
export class AutomationService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly kernel: RuntimeKernel) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    const enabled = this.kernel.store.state.automations.filter((item) => item.enabled).length;
    this.kernel.log("automations", "info", `Scheduler started: ${enabled} enabled automations, checking every ${Math.round(intervalMs / 1000)}s`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(now = new Date()): AutomationView[] {
    return this.kernel.store.state.automations.map((item) => this.view(item, now));
  }

  /**
   * Automations run unattended on a schedule. Anthropic does not allow that on a Claude subscription (Consumer Terms
   * §3: no automated access except through an API key; Claude Code's plan limits assume ordinary individual use),
   * so an agent on Claude (via Claude Code) cannot be scheduled. Checked when saving and again before every run,
   * since the agent's model can change later.
   */
  private allowedAgent(agentId: string) {
    const agent = this.kernel.getAgent(agentId);
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    if (model?.provider === "claude-code") {
      throw new HttpError(409, `${agent.name} runs on Claude (via Claude Code), your Claude subscription. Running it on a schedule is a violation of Anthropic's policy; choose an agent on an API model (Claude with an API key, for example).`);
    }
    return agent;
  }

  async create(input: AutomationInput, now = new Date()): Promise<AutomationView> {
    const name = String(input.name ?? "").trim();
    const prompt = String(input.prompt ?? "").trim();
    if (!name) throw new HttpError(400, "Automation name is required");
    if (!prompt) throw new HttpError(400, "Automation prompt is required");
    const agent = this.allowedAgent(String(input.agentId ?? ""));
    const trigger = triggerOf(input.trigger);
    const timeZone = validTimeZone(input.timeZone);
    const automation: Automation = {
      id: newId("auto"),
      name,
      agentId: agent.id,
      prompt,
      trigger,
      timeZone,
      enabled: input.enabled ?? true,
      createdAt: now.toISOString(),
      lastSlot: previousSlot(trigger, localMinute(now, timeZone)),
    };
    await this.kernel.store.update((state) => {
      state.automations.push(automation);
    });
    this.kernel.log("automations", "info", `Created automation ${name}`);
    return this.view(automation, now);
  }

  async update(id: string, patch: AutomationInput, now = new Date()): Promise<AutomationView> {
    const current = this.get(id);
    const next: Automation = { ...current };
    if (patch.name !== undefined) {
      next.name = String(patch.name).trim();
      if (!next.name) throw new HttpError(400, "Automation name is required");
    }
    if (patch.prompt !== undefined) {
      next.prompt = String(patch.prompt).trim();
      if (!next.prompt) throw new HttpError(400, "Automation prompt is required");
    }
    if (patch.agentId !== undefined) next.agentId = this.allowedAgent(String(patch.agentId)).id;
    if (patch.trigger !== undefined) next.trigger = triggerOf(patch.trigger, current.trigger);
    if (patch.timeZone !== undefined) next.timeZone = validTimeZone(patch.timeZone);
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    const rescheduled =
      patch.trigger !== undefined || patch.timeZone !== undefined || (next.enabled && !current.enabled);
    if (rescheduled) next.lastSlot = previousSlot(next.trigger, localMinute(now, next.timeZone));
    await this.kernel.store.update((state) => {
      state.automations = state.automations.map((item) => (item.id === id ? next : item));
    });
    const view = this.view(next, now);
    if (next.enabled !== current.enabled) {
      this.kernel.log("automations", "info", next.enabled
        ? `Automation ${next.name} resumed; next run ${view.nextRun} ${next.timeZone}`
        : `Automation ${next.name} paused`, { "saturn.automation.id": id });
    }
    const fields = (["name", "prompt", "agentId", "trigger", "timeZone"] as const)
      .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
    if (fields.length) {
      const when = rescheduled && next.enabled ? `; next run ${view.nextRun} ${next.timeZone}` : "";
      this.kernel.log("automations", "info", `Automation ${next.name} updated: ${fields.join(", ")}${when}`, { "saturn.automation.id": id });
    }
    return view;
  }

  async remove(id: string): Promise<void> {
    const automation = this.get(id);
    await this.kernel.store.update((state) => {
      state.automations = state.automations.filter((item) => item.id !== id);
    });
    this.kernel.log("automations", "info", `Automation ${automation.name} deleted`, { "saturn.automation.id": id });
  }

  async runNow(id: string, now = new Date()): Promise<AutomationView> {
    const automation = this.get(id);
    await this.fire(automation, automation.lastSlot, now, "manual");
    return this.view(this.get(id), now);
  }

  /** Fires every enabled automation whose latest slot has not been handled yet. */
  async tick(now = new Date()): Promise<void> {
    for (const automation of this.kernel.store.state.automations) {
      if (!automation.enabled) continue;
      const slot = previousSlot(automation.trigger, localMinute(now, automation.timeZone));
      if (slot <= automation.lastSlot) continue;
      const late = localMinute(now, automation.timeZone) - slot;
      if (late > 2) {
        // Only the latest missed slot runs; earlier ones while the runtime was off are not replayed.
        this.kernel.log("automations", "info", `Automation ${automation.name} is running ${late} minutes late (scheduled ${slotLabel(slot)} ${automation.timeZone})`, {
          "saturn.automation.id": automation.id,
        });
      }
      await this.fire(automation, slot, now, "schedule");
    }
  }

  /** Turns a plain-language request into a draft the New Automation form can prefill. */
  async draft(input: { text?: string; agentId?: string; timeZone?: string }): Promise<{
    name: string;
    prompt: string;
    trigger: Automation["trigger"];
  }> {
    const text = String(input.text ?? "").trim();
    if (!text) throw new HttpError(400, "Describe the automation first");
    const agents = this.kernel.store.state.agents;
    const models = this.kernel.store.state.models;
    const agent = agents.find((item) => item.id === input.agentId) ?? agents.find((item) => item.modelConnectionId);
    // Drafting is a plain API call: it uses the agent's model only if that model has an API, else the completion
    // model or any API model. Subscription models (Claude Code, Codex) never receive API requests.
    const own = models.find((item) => item.id === agent?.modelConnectionId);
    const model = [own, models.find((item) => item.id === this.kernel.store.state.settings.completionModelId), ...models].find((item) => item && !runsOnPlan(item.provider));
    if (!agent || !model) throw new HttpError(409, "Drafting needs a model with an API key (Claude, OpenAI, Gemini, DeepSeek or LM Studio)");
    const body = await this.kernel.llm.complete(model, {
      context: { agentId: agent!.id, agentName: agent!.name, purpose: "automation_draft" },
      temperature: 0,
      maxOutput: 600,
      messages: [
        {
          role: "system",
          content: [
            "You turn a request into a scheduled automation for an AI agent.",
            "Reply with JSON only, no prose, shaped as:",
            '{"name": string, "prompt": string, "frequency": "hourly"|"daily"|"weekdays"|"weekly", "time": "HH:MM", "weekday": 0-6}',
            "name is a short title. prompt is the instruction the agent runs each time, written to the agent.",
            "time is 24-hour local time; for hourly only the minutes matter. weekday is 0 for Sunday and only matters for weekly.",
            "Default to daily at 09:00 when the request gives no schedule.",
          ].join("\n"),
        },
        { role: "user", content: text },
      ],
    });
    const raw = textOf(body);
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      this.kernel.log("automations", "warning", `${model.name} did not return usable JSON for an automation draft (${raw.length} characters)`);
      throw new HttpError(502, "The model did not return a usable automation");
    }
    return {
      name: String(parsed.name ?? "").trim() || clip(text, 40),
      prompt: String(parsed.prompt ?? "").trim() || text,
      trigger: triggerOf({ frequency: parsed.frequency, time: parsed.time, weekday: parsed.weekday }),
    };
  }

  /** One firing, as an "automation <name>" span (the agent run it starts is its child) plus saturn.automation.runs. */
  private async fire(automation: Automation, slot: number, now: Date, source: "schedule" | "manual"): Promise<void> {
    let runId: string | undefined;
    let error: string | undefined;
    const attributes = {
      "saturn.automation.trigger": source,
      "saturn.automation.frequency": automation.trigger.frequency,
    };
    await traced(`automation ${automation.name}`, {
      attributes: {
        ...attributes,
        "saturn.automation.id": automation.id,
        "saturn.automation.time_zone": automation.timeZone,
        "gen_ai.agent.id": automation.agentId,
      },
    }, async (span) => {
      try {
        this.allowedAgent(automation.agentId);
        const run = await this.kernel.runs.startRun(automation.agentId, automation.prompt);
        runId = run.id;
        span.setAttribute("saturn.run.id", run.id);
        this.kernel.log("automations", "info", `Ran automation ${automation.name}`);
      } catch (reason) {
        error = reason instanceof Error ? reason.message : "Could not start the run";
        failSpan(span, reason);
        this.kernel.log("automations", "warning", `Automation ${automation.name} failed: ${error}`);
      }
      instruments().automations.add(1, { ...attributes, "saturn.automation.outcome": error ? "failed" : "started" });
    });
    await this.kernel.store.update((state) => {
      const target = state.automations.find((item) => item.id === automation.id);
      if (!target) return;
      target.lastSlot = Math.max(target.lastSlot, slot);
      target.lastRunAt = now.toISOString();
      target.lastRunId = runId;
      target.lastError = error;
    });
  }

  private get(id: string): Automation {
    const automation = this.kernel.store.state.automations.find((item) => item.id === id);
    if (!automation) throw new HttpError(404, "Automation not found");
    return automation;
  }

  private view(automation: Automation, now: Date): AutomationView {
    const agentName = this.kernel.store.state.agents.find((item) => item.id === automation.agentId)?.name ?? "Agent";
    const nextRun = automation.enabled
      ? slotLabel(nextSlot(automation.trigger, localMinute(now, automation.timeZone)))
      : null;
    return { ...automation, agentName, nextRun };
  }
}
