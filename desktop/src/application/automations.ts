import type { Automation, AutomationDraft, AutomationInput } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";
import { userAction } from "../infrastructure/telemetry.js";

/** Scheduled prompts the runtime runs on an agent by itself. */
export class AutomationService {
  constructor(private readonly runtime: RuntimeClient) {}

  list(): Promise<Automation[]> {
    return this.runtime.request<Automation[]>("/automations");
  }

  create(input: AutomationInput): Promise<Automation> {
    const attributes = { "gen_ai.agent.id": input.agentId, "saturn.automation.frequency": input.trigger.frequency };
    return userAction("ui.create_automation", attributes, async (span) => {
      const created = await this.runtime.request<Automation>("/automations", { method: "POST", body: JSON.stringify(input) });
      span.setAttribute("saturn.automation.id", created.id);
      return created;
    });
  }

  update(id: string, patch: Partial<AutomationInput>): Promise<Automation> {
    return userAction("ui.update_automation", { "saturn.automation.id": id }, () =>
      this.runtime.request<Automation>(`/automations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    );
  }

  remove(id: string): Promise<void> {
    return this.runtime.request(`/automations/${id}`, { method: "DELETE" });
  }

  runNow(id: string): Promise<Automation> {
    return userAction("ui.run_automation", { "saturn.automation.id": id }, () =>
      this.runtime.request<Automation>(`/automations/${id}/run`, { method: "POST" }),
    );
  }

  draft(text: string, agentId?: string): Promise<AutomationDraft> {
    return userAction("ui.draft_automation", agentId ? { "gen_ai.agent.id": agentId } : {}, () =>
      this.runtime.request<AutomationDraft>("/automations/draft", {
        method: "POST",
        body: JSON.stringify({ text, agentId }),
      }),
    );
  }
}
