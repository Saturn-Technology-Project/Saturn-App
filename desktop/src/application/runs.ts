import type { Run } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

export class RunService {
  constructor(private readonly runtime: RuntimeClient) {}

  start(agentId: string, input: string): Promise<Run> {
    return this.runtime.request<Run>(`/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
  }

  get(id: string): Promise<Run> {
    return this.runtime.request<Run>(`/runs/${id}`);
  }

  stop(id: string): Promise<Run> {
    return this.runtime.request<Run>(`/runs/${id}/stop`, { method: "POST" });
  }

  revise(id: string, input: string): Promise<{ run: Run; removed: string[] }> {
    return this.runtime.request(`/runs/${id}`, { method: "PATCH", body: JSON.stringify({ input }) });
  }
}
