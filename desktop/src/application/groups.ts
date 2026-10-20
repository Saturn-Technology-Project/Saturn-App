import type { Group, GroupTranscript, GroupAutonomy } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";
import { userAction } from "../infrastructure/telemetry.js";

/** Group chats: the user and several agents, who each decide whether a message needs them. */
export class GroupService {
  constructor(private readonly runtime: RuntimeClient) {}

  list(): Promise<Group[]> {
    return this.runtime.request<Group[]>("/groups");
  }

  create(input: { name?: string; agentIds?: string[] }): Promise<Group> {
    return userAction("ui.create_group", {}, () =>
      this.runtime.request<Group>("/groups", { method: "POST", body: JSON.stringify(input) }),
    );
  }

  update(id: string, patch: { name?: string; agentIds?: string[]; autonomy?: GroupAutonomy | null }): Promise<Group> {
    return this.runtime.request<Group>(`/groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  remove(id: string): Promise<void> {
    return this.runtime.request(`/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  transcript(id: string): Promise<GroupTranscript> {
    return this.runtime.request<GroupTranscript>(`/groups/${encodeURIComponent(id)}/messages`);
  }

  post(id: string, text: string): Promise<GroupTranscript> {
    return userAction("ui.post_group_message", { "saturn.group.id": id }, () =>
      this.runtime.request<GroupTranscript>(`/groups/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
    );
  }
}
