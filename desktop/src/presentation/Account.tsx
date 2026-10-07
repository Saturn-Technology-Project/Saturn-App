import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { Member, OrgProfile } from "../domain/model";

function roleLabel(role: string) {
  if (!role) return "Member";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function ProfilePage(props: { onClose: () => void; onSaved: (profile: OrgProfile) => void }) {
  const [profile, setProfile] = useState<OrgProfile | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void desktop.account.profile()
      .then((next) => {
        setProfile(next);
        setName(next.name);
        setTitle(next.title);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load profile"));
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const next = await desktop.account.updateProfile({ name, title });
      setProfile(next);
      props.onSaved(next);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not save profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings">
      <div className="settings-head">
        <h2>Profile</h2>
        <button className="btn ghost" type="button" onClick={props.onClose}>Back to chat</button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {profile ? (
        <div className="card">
          <label className="label" htmlFor="profile-name">Name</label>
          <input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} />
          <label className="label" htmlFor="profile-title">Title</label>
          <input id="profile-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <label className="label">Email</label>
          <p>{profile.email}</p>
          <label className="label">Role</label>
          <p>{roleLabel(profile.role)}</p>
          <div className="actions">
            <button className="btn ghost" type="button" onClick={props.onClose}>Cancel</button>
            <button className="btn" type="button" disabled={saving || !name.trim()} onClick={() => void save()}>Save</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function TeamPage(props: { canWrite: boolean; agents: { id: string; name: string }[]; onClose: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("operator");

  async function load() {
    setMembers(await desktop.account.members());
  }

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the team"));
  }, []);

  async function changeRole(member: Member, nextRole: string) {
    setError("");
    try {
      await desktop.account.updateMember(member.id, { role: nextRole });
      await load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not update this member");
    }
  }

  async function changeAccess(member: Member, agentIds: string[], editIds: string[]) {
    setError("");
    try {
      await desktop.account.updateMember(member.id, {
        agent_ids: agentIds,
        agent_edit_ids: editIds.filter((id) => agentIds.includes(id)),
      });
      await load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not update this member");
    }
  }

  async function invite() {
    setError("");
    try {
      await desktop.account.invite({ email, name, role });
      setInviting(false);
      setEmail("");
      setName("");
      setRole("operator");
      await load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not invite this person");
    }
  }

  return (
    <section className="settings">
      <div className="settings-head">
        <h2>Team</h2>
        <button className="btn ghost" type="button" onClick={props.onClose}>Back to chat</button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="team-list">
        {members.map((member) => (
          <article className="member" key={member.id}>
            <div className="member-id">
              <strong>{member.name}</strong>
              <small>{member.email}</small>
            </div>
            {props.canWrite ? (
              <select aria-label={`Role for ${member.name}`} value={member.role} onChange={(event) => void changeRole(member, event.target.value)}>
                <option value="admin">Admin</option>
                <option value="operator">Operator</option>
                <option value="viewer">Viewer</option>
                {member.role === "custom" ? <option value="custom">Custom</option> : null}
              </select>
            ) : (
              <span>{roleLabel(member.role)}</span>
            )}
            {props.canWrite && props.agents.length > 0 ? (
              <div className="access">
                <div className="access-head">
                  <span>Assigned</span>
                  <span>Can modify</span>
                </div>
                {props.agents.map((agent) => {
                  const assigned = new Set(member.agent_ids ?? []);
                  const edits = new Set(member.agent_edit_ids ?? (member.permissions?.agents === "write" ? member.agent_ids ?? [] : []));
                  return (
                    <div className="access-row" key={agent.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={assigned.has(agent.id)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...assigned, agent.id]
                              : [...assigned].filter((id) => id !== agent.id);
                            void changeAccess(member, next, [...edits].filter((id) => next.includes(id)));
                          }}
                        />
                        <span>{agent.name}</span>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`Can modify ${agent.name}`}
                          checked={assigned.has(agent.id) && edits.has(agent.id)}
                          disabled={!assigned.has(agent.id)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...edits, agent.id]
                              : [...edits].filter((id) => id !== agent.id);
                            void changeAccess(member, [...assigned], next);
                          }}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {props.canWrite ? (
        inviting ? (
          <div className="card">
            <label className="label" htmlFor="invite-name">Name</label>
            <input id="invite-name" value={name} onChange={(event) => setName(event.target.value)} />
            <label className="label" htmlFor="invite-email">Email</label>
            <input id="invite-email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <label className="label" htmlFor="invite-role">Role</label>
            <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="admin">Admin</option>
              <option value="operator">Operator</option>
              <option value="viewer">Viewer</option>
            </select>
            <div className="actions">
              <button className="btn ghost" type="button" onClick={() => { setInviting(false); setEmail(""); setName(""); setRole("operator"); }}>Cancel</button>
              <button className="btn" type="button" disabled={!email.trim() || !name.trim()} onClick={() => void invite()}>Save</button>
            </div>
          </div>
        ) : (
          <button className="btn" type="button" onClick={() => setInviting(true)}>Invite</button>
        )
      ) : null}
    </section>
  );
}
