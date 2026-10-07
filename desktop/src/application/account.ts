import type { Member, OrgProfile } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

/** Profile and team. These calls go through the runtime to Saturn Cloud. */
export class AccountService {
  constructor(private readonly runtime: RuntimeClient) {}

  profile(): Promise<OrgProfile> {
    return this.runtime.request<OrgProfile>("/account");
  }

  updateProfile(input: { name: string; title: string }): Promise<OrgProfile> {
    return this.runtime.request<OrgProfile>("/account", { method: "PATCH", body: JSON.stringify(input) });
  }

  members(): Promise<Member[]> {
    return this.runtime.request<Member[]>("/team");
  }

  updateMember(id: string, patch: { role?: string; agent_ids?: string[]; agent_edit_ids?: string[] }): Promise<void> {
    return this.runtime.request(`/team/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  invite(input: { email: string; name: string; role: string }): Promise<void> {
    return this.runtime.request("/team/invites", { method: "POST", body: JSON.stringify(input) });
  }
}
