import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop";
import type { Hook, HookEvent, HookSet, Project } from "../../domain/model";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Input } from "../ui/base/Input.js";
import { Choice } from "../ui/base/Field.js";
import { Explained } from "./Explained";
import { FormHint, RowDescription, RowLabel, RuleCode, RuleEffect, RuleForm, RuleItem, RuleList, SectionTitle, SettingsCard, SettingsRow } from "./Parts";

const EVENTS: { id: HookEvent; label: string; hint: string }[] = [
  { id: "pre_tool", label: "Before a tool", hint: "Exit 2 blocks the call (stderr goes to the agent). Print {\"decision\": \"allow\" | \"ask\" | \"deny\"} to skip the card, ask, or refuse." },
  { id: "post_tool", label: "After a tool", hint: "Exit 2 adds stderr to the result as feedback for the agent (a linter, a formatter's complaint)." },
  { id: "stop", label: "When a turn ends", hint: "Exit 2 sends stderr back to the agent as a follow-up, at most twice per message (insist on green tests)." },
];

function HookList(props: { hooks: Hook[]; onRemove?: (index: number) => void }) {
  if (!props.hooks.length) return <p className="text-xs text-muted-foreground">No hooks.</p>;
  return (
    <RuleList>
      {props.hooks.map((hook, index) => (
        <RuleItem key={`${hook.event}:${hook.command}:${index}`}>
          <RuleEffect kind="hook">{hook.event.replace("_", " ")}</RuleEffect>
          {hook.event !== "stop" ? <RuleCode>{hook.matcher || "any tool"}</RuleCode> : null}
          <RuleCode pattern title={hook.command}>{hook.command}</RuleCode>
          {props.onRemove ? (
            <Button type="button" variant="ghost" size="small" className="text-muted-foreground hover:bg-destructive/12 hover:text-destructive" onClick={() => props.onRemove!(index)} aria-label={`Remove ${hook.command}`}>Remove</Button>
          ) : null}
        </RuleItem>
      ))}
    </RuleList>
  );
}

/** Settings → Hooks: the user's own hooks, then each project's file hooks, which run only once allowed. */
export function HooksPage(props: { projects: Project[]; onError: (message: string) => void }) {
  const [userHooks, setUserHooks] = useState<Hook[]>([]);
  const [projectSets, setProjectSets] = useState<Record<string, HookSet[]>>({});
  const [event, setEvent] = useState<HookEvent>("pre_tool");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void desktop.admin.hooks().then((sets) => { if (active) setUserHooks(sets.find((set) => set.source === "user")?.hooks ?? []); }, (reason) => props.onError(reason instanceof Error ? reason.message : "Could not load hooks"));
    for (const project of props.projects) {
      void desktop.admin.hooks(project.id).then((sets) => { if (active) setProjectSets((prev) => ({ ...prev, [project.id]: sets.filter((set) => set.source === "project-file" || set.source === "claude-file") })); }, () => undefined);
    }
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projects.map((project) => project.id).join(",")]);

  async function save(next: Hook[]) {
    setBusy(true);
    try {
      const sets = await desktop.admin.setUserHooks(next);
      setUserHooks(sets.find((set) => set.source === "user")?.hooks ?? []);
      props.onError("");
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save hooks");
    } finally {
      setBusy(false);
    }
  }

  async function allow(projectId: string, set: HookSet, allowed: boolean) {
    try {
      const sets = allowed ? await desktop.admin.approveHooks(projectId, set.path!, set.fingerprint!) : await desktop.admin.revokeHooks(projectId, set.path!);
      setProjectSets((prev) => ({ ...prev, [projectId]: sets.filter((item) => item.source === "project-file" || item.source === "claude-file") }));
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not change the approval");
    }
  }

  const withFiles = props.projects.filter((project) => (projectSets[project.id] ?? []).length);
  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <Explained summary="A hook is a shell command that runs around an agent's tool calls, or when its turn ends.">
        <li>It runs in the chat's project folder, and gets the event as JSON on stdin: the tool, its arguments and result, and the turn's answer.</li>
        <li>Your hooks below run in every project.</li>
        <li>A project can bring its own in <code>.saturn/hooks.json</code>, and the hooks of its <code>.claude/settings.json</code> are read too (PreToolUse, PostToolUse and Stop). Those run only after you allow them here, and any change to the file asks again.</li>
      </Explained>

      <div>
        <SectionTitle>Your hooks</SectionTitle>
        <SettingsCard>
          <SettingsRow stacked>
            <HookList hooks={userHooks} onRemove={(index) => void save(userHooks.filter((_, at) => at !== index))} />
            <RuleForm
              onSubmit={(formEvent) => {
                formEvent.preventDefault();
                if (!command.trim()) return;
                void save([...userHooks, { event, ...(event !== "stop" && matcher.trim() ? { matcher: matcher.trim() } : {}), command: command.trim() }]).then(() => { setCommand(""); setMatcher(""); });
              }}
            >
              <Choice ariaLabel="Hook event" value={event} options={EVENTS.map((item) => ({ value: item.id, label: item.label }))} onChange={(next) => setEvent(next as HookEvent)} />
              {event !== "stop" ? <Input className="w-55 flex-none" aria-label="Tools" placeholder="tools: code, files, github_* (empty: all)" value={matcher} onChange={(changeEvent) => setMatcher(changeEvent.target.value)} /> : null}
              <Input className="w-55 flex-none font-mono" aria-label="Command" placeholder="./scripts/check.sh" value={command} onChange={(changeEvent) => setCommand(changeEvent.target.value)} />
              <Button type="submit" disabled={busy || !command.trim()}>Add hook</Button>
              <FormHint>{EVENTS.find((item) => item.id === event)?.hint}</FormHint>
            </RuleForm>
          </SettingsRow>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Project hooks</SectionTitle>
        <SettingsCard>
          {withFiles.length ? withFiles.map((project) => (projectSets[project.id] ?? []).map((set) => (
            <SettingsRow stacked key={`${project.id}:${set.path}`}>
              <div className="flex flex-wrap items-center gap-2">
                <RowLabel className="min-w-0 flex-1">{project.name} · <code>{set.path}</code></RowLabel>
                <Badge tone={set.approved ? "good" : "wait"}>{set.approved ? "Allowed" : "Not running: needs your approval"}</Badge>
                <Button type="button" variant={set.approved ? "outline" : "default"} size="small" onClick={() => void allow(project.id, set, !set.approved)}>
                  {set.approved ? "Stop allowing" : "Allow these hooks"}
                </Button>
              </div>
              <HookList hooks={set.hooks} />
              {!set.approved ? <RowDescription>These commands come with the folder and run with your permissions. Read them before allowing.</RowDescription> : null}
            </SettingsRow>
          ))) : <RowDescription>No project has a <code>.saturn/hooks.json</code> or hooks in <code>.claude/settings.json</code>.</RowDescription>}
        </SettingsCard>
      </div>
    </div>
  );
}
