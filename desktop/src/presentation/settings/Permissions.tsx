import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop";
import type { PermissionLayer, PermissionRule, PermissionScope, Project } from "../../domain/model";
import { patternHint } from "../../domain/permissions";
import { Button } from "../ui/base/Button.js";
import { Choice } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Explained } from "./Explained";
import { FormHint, RowDescription, RowLabel, RowText, RuleCode, RuleEffect, RuleForm, RuleItem, RuleList, SectionTitle, SettingsCard, SettingsRow } from "./Parts";

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

  /** A project file's allow rules: allowed as the exact set shown (its fingerprint), or held again. */
  async function decideFile(allow: boolean) {
    const projectId = props.target.projectId;
    if (!projectId || !props.layer.path) return;
    setBusy(true);
    try {
      props.onChanged(allow
        ? await desktop.admin.approvePermissionFile(projectId, props.layer.path, props.layer.fingerprint ?? "")
        : await desktop.admin.revokePermissionFile(projectId, props.layer.path));
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not change the rules");
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
    <div className="flex w-full flex-col gap-2">
      {props.layer.rules.length ? (
        <RuleList>
          {props.layer.rules.map((rule, index) => (
            <RuleItem key={`${rule.tool}:${rule.pattern}:${index}`}>
              <RuleEffect kind={rule.effect}>{rule.effect}</RuleEffect>
              <RuleCode>{rule.tool}</RuleCode>
              <RuleCode pattern>{rule.pattern}</RuleCode>
              {props.layer.editable ? (
                <Button type="button" variant="ghost" size="small" className="text-muted-foreground hover:bg-destructive/12 hover:text-destructive" disabled={busy} onClick={() => void remove(rule)} aria-label={`Remove ${rule.tool} ${rule.pattern}`}>
                  Remove
                </Button>
              ) : null}
            </RuleItem>
          ))}
        </RuleList>
      ) : (
        <RowDescription>{props.layer.editable ? "No rules yet." : "No rules."}</RowDescription>
      )}
      {props.layer.editable ? (
        <RuleForm onSubmit={(event) => void add(event)}>
          <Choice ariaLabel="Effect" value={effect} options={EFFECTS.map((item) => ({ value: item.id, label: item.label }))} onChange={(next) => setEffect(next as PermissionRule["effect"])} />
          <Choice ariaLabel="Tool" value={tool} options={[...TOOLS.map((item) => ({ value: item, label: item === "*" ? "any tool" : item })), { value: "other", label: "other…" }]} onChange={setTool} />
          {tool === "other" ? <Input className="w-auto flex-none" aria-label="Tool id" placeholder="tool id, e.g. github_*" value={custom} onChange={(event) => setCustom(event.target.value)} /> : null}
          <Input className="w-55 flex-none font-mono" aria-label="Pattern" placeholder={toolId === "files" ? "write src/**" : toolId === "code" ? "npm test *" : "*"} value={pattern} onChange={(event) => setPattern(event.target.value)} />
          <Button type="submit" disabled={busy || !toolId || !pattern.trim()}>Add rule</Button>
          <FormHint>{patternHint(toolId)} {EFFECTS.find((item) => item.id === effect)?.label} {EFFECTS.find((item) => item.id === effect)?.hint}.</FormHint>
        </RuleForm>
      ) : (
        <>
          {props.layer.held?.length ? (
            <div className="my-1.5 flex flex-col items-start gap-2 rounded-lg border border-wait/30 bg-wait/10 px-3 py-2.5">
              <p className="m-0 text-xs text-muted-foreground">
                <strong>Waiting for you.</strong> These allow rules came with the folder, so they apply only after you allow them; until then these commands ask like any other. Allow them only if you trust whoever wrote <code>{props.layer.path}</code>.
              </p>
              <RuleList>
                {props.layer.held.map((rule, index) => (
                  <RuleItem key={`held:${rule.tool}:${rule.pattern}:${index}`}>
                    <RuleEffect kind="allow">allow</RuleEffect>
                    <RuleCode>{rule.tool}</RuleCode>
                    <RuleCode pattern>{rule.pattern}</RuleCode>
                  </RuleItem>
                ))}
              </RuleList>
              <Button type="button" size="small" disabled={busy || !props.target.projectId} onClick={() => void decideFile(true)}>Allow these rules</Button>
            </div>
          ) : null}
          {props.layer.approved ? (
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              You allowed this file's allow rules; a change to them asks again.{" "}
              <Button type="button" variant="outline" size="small" disabled={busy} onClick={() => void decideFile(false)}>Revoke</Button>
            </p>
          ) : null}
          {props.layer.refused?.length ? (
            <p className="m-0 text-xs text-muted-foreground">
              Never applied, since they would allow every call: {props.layer.refused.map((rule) => <code key={`${rule.tool}:${rule.pattern}`}>{rule.tool} {rule.pattern}</code>)}.
            </p>
          ) : null}
          <p className="m-0 text-xs text-muted-foreground">Read from <code>{props.layer.path}</code> in the project folder; edit that file to change them.</p>
        </>
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
    <div className="flex max-w-[760px] flex-col gap-5">
      <Explained summary="Rules decide which tool calls run, wait for you, or are refused, before any approval setting applies.">
        <li>A rule names a tool and a pattern. <strong>Deny</strong> refuses the call, <strong>ask</strong> shows an approval card, and <strong>allow</strong> runs it without asking. Deny beats ask, and ask beats allow.</li>
        <li>When no rule applies, the approval setting decides. Sensitive commands (<code>rm -rf</code>, <code>sudo</code>, <code>git push --force</code>, deleting files, paths outside the project) always ask in the default setting.</li>
        <li>Rules in a project's <code>.saturn/settings.json</code> and the <code>permissions</code> of its <code>.claude/settings.json</code> apply too. They come with the folder (a cloned repository, say), so their deny and ask rules apply at once, but their allow rules only after you allow them in the project's rules here.</li>
        <li>A rule that allows every command is never applied.</li>
      </Explained>
      <div>
        <SectionTitle>Rules for</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Scope</RowLabel>
              <RowDescription>Everywhere applies to every agent in every project; a project's or an agent's rules add to it.</RowDescription>
            </RowText>
            <Choice
              ariaLabel="Rules for"
              value={target}
              options={[
                { value: "user", label: "Everywhere" },
                ...props.projects.map((project) => ({ value: `project:${project.id}`, label: `Project · ${project.name}` })),
                ...props.agents.map((agent) => ({ value: `agent:${agent.id}`, label: `Agent · ${agent.name}` })),
              ]}
              onChange={setTarget}
            />
          </SettingsRow>
          {loading ? <RowDescription>Loading…</RowDescription> : shown.map((layer) => (
            <SettingsRow stacked key={layer.scope}>
              <RowLabel>{layer.scope === "user" ? "Everywhere" : layer.label}</RowLabel>
              <RulesEditor layer={layer} target={selection} onChanged={setLayers} onError={props.onError} />
            </SettingsRow>
          ))}
        </SettingsCard>
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
    <div>
      <SectionTitle>Permissions</SectionTitle>
      <SettingsCard>
        {layers.filter((layer) => layer.scope !== "user").map((layer) => (
          <SettingsRow stacked key={layer.scope}>
            <RowLabel>{layer.scope === "project" ? "This project" : layer.label}</RowLabel>
            <RulesEditor layer={layer} target={{ projectId: props.project.id }} onChanged={setLayers} onError={props.onError} />
          </SettingsRow>
        ))}
        {layers.length ? null : <RowDescription>Loading…</RowDescription>}
      </SettingsCard>
    </div>
  );
}

export const SCOPE_CHOICES: { id: PermissionScope; label: string }[] = [
  { id: "project", label: "this project" },
  { id: "agent", label: "this agent" },
  { id: "user", label: "everywhere" },
];
