import type { Run, RunChanges } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";
import { userAction } from "../infrastructure/telemetry.js";

export class RunService {
  constructor(private readonly runtime: RuntimeClient) {}

  start(agentId: string, input: string, threadId?: string): Promise<Run> {
    return userAction("ui.send_message", { "gen_ai.agent.id": agentId }, async (span) => {
      const run = await this.runtime.request<Run>(`/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input, ...(threadId ? { threadId } : {}) }),
      });
      span.setAttribute("saturn.run.id", run.id);
      return run;
    });
  }

  get(id: string): Promise<Run> {
    return this.runtime.request<Run>(`/runs/${id}`);
  }

  stop(id: string): Promise<Run> {
    return userAction("ui.stop_run", { "saturn.run.id": id }, () =>
      this.runtime.request<Run>(`/runs/${id}/stop`, { method: "POST" }),
    );
  }

  /** Answers an approval card: lets a waiting tool call run, or denies it. */
  decide(runId: string, actionId: string, allow: boolean): Promise<{ ok: boolean }> {
    return userAction(allow ? "ui.approve_action" : "ui.deny_action", { "saturn.run.id": runId }, () =>
      this.runtime.request(`/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/decision`, {
        method: "POST",
        body: JSON.stringify({ allow }),
      }),
    );
  }

  /** Ends a computer_wait early so the run continues now. */
  wake(id: string): Promise<Run> {
    return userAction("ui.wake_run", { "saturn.run.id": id }, () =>
      this.runtime.request<Run>(`/runs/${id}/wake`, { method: "POST" }),
    );
  }

  /** The files a run changed in its project folder, with a diff each. */
  changes(id: string): Promise<RunChanges> {
    return this.runtime.request<RunChanges>(`/runs/${encodeURIComponent(id)}/changes`);
  }

  /** Restores one file, or every file the run changed, to how it was before the run. */
  revertChanges(id: string, path?: string): Promise<RunChanges> {
    return userAction("ui.revert_changes", { "saturn.run.id": id }, () =>
      this.runtime.request<RunChanges>(`/runs/${encodeURIComponent(id)}/changes/revert`, {
        method: "POST",
        body: JSON.stringify(path === undefined ? {} : { path }),
      }),
    );
  }

  keepChanges(id: string): Promise<RunChanges> {
    return userAction("ui.keep_changes", { "saturn.run.id": id }, () =>
      this.runtime.request<RunChanges>(`/runs/${encodeURIComponent(id)}/changes/keep`, { method: "POST" }),
    );
  }

  /** Restores the chat's files to before this turn: reverts it and every later turn in the chat. */
  restoreTo(id: string): Promise<{ reverted: string[]; files: string[] }> {
    return userAction("ui.restore_checkpoint", { "saturn.run.id": id }, () =>
      this.runtime.request(`/runs/${encodeURIComponent(id)}/restore`, { method: "POST" }),
    );
  }

  revise(id: string, input: string): Promise<{ run: Run; removed: string[] }> {
    return userAction("ui.edit_message", { "saturn.run.id": id }, () =>
      this.runtime.request(`/runs/${id}`, { method: "PATCH", body: JSON.stringify({ input }) }),
    );
  }
}
