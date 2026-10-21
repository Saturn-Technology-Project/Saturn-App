import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { PermissionLayer, PermissionRule, PermissionScope, Project } from "../domain/model";
import { patternHint } from "../domain/permissions";

const EFFECTS: { id: PermissionRule["effect"]; label: string; hint: string }[] = [
  { id: "allow", label: "Allow", hint: "runs without asking, in every approval mode" },
  { id: "ask", label: "Ask", hint: "always shows an approval card" },
  { id: "deny", label: "Deny", hint: "is refused; the agent is told why" },
];

/** The common tools, for the rule form; any other tool id can be typed. */
const TOOLS = ["code", "files", "web", "*"];

/**
 * One layer's rules, with a form to add one. Rules from the project's own files (`.saturn/settings.json`,
 * `.claude/settings.json`) are shown but edited in those files.
 */
export function RulesEditor(props: { layer: PermissionLayer; target: { projectId?: string; agentId?: string }; onChanged: (layers: PermissionLayer[]) => void; onError: (message: string) => void }) {
  const [tool, setTool] = useState("code");
  const [custom, setCustom] = useState("");
  const [pattern, setPattern] = useState("");
  const [effect, setEffect] = useState<PermissionRule["effect"]>("allow");
  const [busy, setBusy] = useState(false);
  const toolId = tool === "other" ? custom.trim() : tool;

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!toolId || !pattern.trim()) return;
    setBusy(true);
    try {
      props.onChanged(await desktop.admin.addPermissionRule(props.layer.scope, { tool: toolId, pattern: pattern.trim(), effect }, props.target));
      setPattern("");
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save the rule");
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: PermissionRule) {
    setBusy(true);
    try {
      props.onChanged(await desktop.admin.removePermissionRule(props.layer.scope, rule, props.target));
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not remove the rule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="permission-layer">
      {props.layer.rules.length ? (
        <ul className="permission-rules">
          {props.layer.rules.map((rule, index) => (
            <li key={`${rule.tool}:${rule.pattern}:${index}`} className={`permission-rule ${rule.effect}`}>
              <span className={`permission-effect ${rule.effect}`}>{rule.effect}</span>
              <code className="permission-tool">{rule.tool}</code>
              <code className="permission-pattern">{rule.pattern}</code>
              {props.layer.editable ? (
                <button type="button" className="btn ghost tiny danger" disabled={busy} onClick={() => void remove(rule)} aria-label={`Remove ${rule.tool} ${rule.pattern}`}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-row-desc">{props.layer.editable ? "No rules yet." : "No rules."}</p>
      )}
      {props.layer.editable ? (
        <form className="permission-form" onSubmit={(event) => void add(event)}>
          <select className="input tiny settings-select-fit" aria-label="Effect" value={effect} onChange={(event) => setEffect(event.target.value as PermissionRule["effect"])}>
            {EFFECTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <select className="input tiny settings-select-fit" aria-label="Tool" value={tool} onChange={(event) => setTool(event.target.value)}>
            {TOOLS.map((item) => <option key={item} value={item}>{item === "*" ? "any tool" : item}</option>)}
            <option value="other">other…</option>
          </select>
          {tool === "other" ? <input className="input tiny" aria-label="Tool id" placeholder="tool id, e.g. github_*" value={custom} onChange={(event) => setCustom(event.target.value)} /> : null}
          <input className="input tiny permission-pattern-input" aria-label="Pattern" placeholder={toolId === "files" ? "write src/**" : toolId === "code" ? "npm test *" : "*"} value={pattern} onChange={(event) => setPattern(event.target.value)} />
          <button type="submit" className="btn tiny" disabled={busy || !toolId || !pattern.trim()}>Add rule</button>
          <span className="permission-hint">{patternHint(toolId)} {EFFECTS.find((item) => item.id === effect)?.label} {EFFECTS.find((item) => item.id === effect)?.hint}.</span>
        </form>
      ) : (
        <p className="settings-row-desc">Read from <code>{props.layer.path}</code> in the project folder; edit that file to change them.</p>
      )}
    </div>
  );
}

/** Settings → Permissions: the user's rules, then a project's or an agent's. */
export function PermissionsPage(props: { projects: Project[]; agents: { id: string; name: string }[]; onError: (message: string) => void }) {
  const [target, setTarget] = useState<string>("user");
  const [layers, setLayers] = useState<PermissionLayer[]>([]);
  const [loading, setLoading] = useState(true);
  const selection = target.startsWith("project:") ? { projectId: target.slice(8) } : target.startsWith("agent:") ? { agentId: target.slice(6) } : {};

  useEffect(() => {
    let active = true;
    setLoading(true);
    desktop.admin.permissions(selection)
      .then((result) => { if (active) { setLayers(result); setLoading(false); } })
      .catch((reason) => { if (active) { props.onError(reason instanceof Error ? reason.message : "Could not load permissions"); setLoading(false); } });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const shown = layers.filter((layer) => (target === "user" ? layer.scope === "user" : layer.scope !== "user"));
  return (
    <div className="settings-section-list">
      <div className="settings-section">
        <div className="settings-section-title">How rules work</div>
        <div className="settings-card">
          <p className="settings-row-desc">
            A rule names a tool and a pattern. Before each tool call the rules are checked first: <strong>deny</strong> refuses the call, <strong>ask</strong> shows an approval card, <strong>allow</strong> runs it without asking in any approval mode. Deny beats ask beats allow. When no rule applies, the agent's approval mode decides, and sensitive commands (<code>rm -rf</code>, <code>sudo</code>, <code>git push --force</code>, deleting files, paths outside the project) always ask in the default mode.
            Rules in a project's <code>.saturn/settings.json</code> and the <code>permissions</code> of its <code>.claude/settings.json</code> apply too.
          </p>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">Rules for</div>
        <div className="settings-card">
          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Scope</span>
              <span className="settings-row-desc">Everywhere applies to every agent in every project; a project's or an agent's rules add to it.</span>
            </div>
            <select className="input tiny settings-select-fit" aria-label="Rules for" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="user">Everywhere</option>
              {props.projects.length ? <optgroup label="Projects">{props.projects.map((project) => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}</optgroup> : null}
              {props.agents.length ? <optgroup label="Agents">{props.agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}</optgroup> : null}
            </select>
          </div>
          {loading ? <p className="settings-row-desc">Loading…</p> : shown.map((layer) => (
            <div className="settings-card-row settings-card-stack" key={layer.scope}>
              <span className="settings-row-label">{layer.scope === "user" ? "Everywhere" : layer.label}</span>
              <RulesEditor layer={layer} target={selection} onChanged={setLayers} onError={props.onError} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The project settings tab's section: the project's rules and the ones read from its files. */
export function ProjectPermissions(props: { project: Project; onError: (message: string) => void }) {
  const [layers, setLayers] = useState<PermissionLayer[]>([]);
  useEffect(() => {
    let active = true;
    desktop.admin.permissions({ projectId: props.project.id })
      .then((result) => { if (active) setLayers(result); })
      .catch((reason) => { if (active) props.onError(reason instanceof Error ? reason.message : "Could not load permissions"); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.project.id]);
  return (
    <div className="settings-section">
      <div className="settings-section-title">Permissions</div>
      <div className="settings-card">
        {layers.filter((layer) => layer.scope !== "user").map((layer) => (
          <div className="settings-card-row settings-card-stack" key={layer.scope}>
            <span className="settings-row-label">{layer.scope === "project" ? "This project" : layer.label}</span>
            <RulesEditor layer={layer} target={{ projectId: props.project.id }} onChanged={setLayers} onError={props.onError} />
          </div>
        ))}
        {layers.length ? null : <p className="settings-row-desc">Loading…</p>}
      </div>
    </div>
  );
}

export const SCOPE_CHOICES: { id: PermissionScope; label: string }[] = [
  { id: "project", label: "this project" },
  { id: "agent", label: "this agent" },
  { id: "user", label: "everywhere" },
];
