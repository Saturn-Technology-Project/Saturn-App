import { SnapshotStorage } from "./SnapshotStorage";
import { OlderFeatures } from "./OlderFeatures";
import { ComputerPermissions } from "./ComputerPermissions";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { desktop } from "../../application/desktop";
import { PermissionsPage, ProjectPermissions } from "./Permissions";
import { HooksPage } from "./Hooks";
import { PluginsPage } from "./Plugins";
import { EFFORT_LABELS, removalQuestion, splitCommandLine, supportsEffort, type Agent, type AgentBrowser, type EmbeddingSource, type LlmProvider, type LogLine, type Mcp, type Model, type Profile, type Project, type Rag, type RuntimeInfo, type SandboxMode, type SandboxSettings, type CliStatus } from "../../domain/model";
import type { CodexStatus, ProgramStatus } from "../../application/admin";
import { UsageBilling } from "./UsageBilling";
import { Telemetry } from "./Telemetry";
import { ConfigureMcpModal } from "./ConfigureMcpModal";
import { About } from "./About";
import { askToConfirm } from "../../infrastructure/confirm";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { classes } from "../ui/base/classes.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/base/Dialog.js";
import { Choice, Field } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Notice } from "../ui/base/Notice.js";
import { Switch } from "../ui/base/Switch.js";
import { Tabs, TabsList, TabsTrigger } from "../ui/base/Tabs.js";
import { Textarea } from "../ui/base/Textarea.js";
import { CardRow, InlineForm, LinkButton, Pills, RowActions, RowDescription, RowError, RowLabel, RowText, SectionTitle, SettingsCard, SettingsRow, Status, SubTitle } from "./Parts";

export type SettingsPage =
  | "settings"
  | "usage"
  | "llm"
  | "mcp"
  | "telemetry"
  | "logs"
  | "information"
  | "memory"
  | "permissions"
  | "hooks"
  | "plugins"
  | "shortcuts"
  | "older";

const GROUPS: { title: string; items: [SettingsPage, string, string][] }[] = [
  {
    title: "Settings",
    items: [
      ["settings", "General", "Execution, appearance, and workspace"],
      ["llm", "Models", "LLM providers & models"],
      ["mcp", "MCP & Skills", "Tool servers & knowledge sources"],
      ["usage", "Usage & Billing", "Token spend & costs"],
      ["memory", "Memory", "What Saturn remembers across chats"],
      ["permissions", "Permissions", "What agents may do without asking"],
      ["hooks", "Hooks", "Commands around tool calls and turns"],
      ["plugins", "Plugins", "Bundles of skills, commands, hooks and MCP servers"],
    ],
  },
  {
    title: "System",
    items: [
      ["telemetry", "Telemetry", "OpenTelemetry traces & logs"],
      ["logs", "Logs", "Live runtime event stream"],
      ["information", "About", "What Saturn is and how it fits together"],
    ],
  },
];

export function Settings(props: {
  initialPage?: SettingsPage;
  /** Opens on one project's page (the chat's rules chip). */
  initialProjectId?: string | null;
  agents: { id: string; name: string; status: string }[];
  agent: Agent | null;
  models: Model[];
  mcp: Mcp[];
  rag: Rag[];
  projects?: Project[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onPatchAgent: (patch: Partial<Agent>) => Promise<void>;
  onProfile: (profile: Profile) => void;
  theme?: "light" | "dark";
  onSetTheme?: (theme: "light" | "dark") => void;
  onToggleTheme?: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>(props.initialPage ?? "settings");
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (props.initialPage) {
      setPage(props.initialPage);
      setSelectedProjectId(props.initialProjectId ?? null);
    }
  }, [props.initialPage, props.initialProjectId]);

  // Each page starts at its top.
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [page, selectedProjectId]);

  async function load() {
    const next = await desktop.admin.console();
    setProfile(next.profile);
    props.onProfile(next.profile);
    setInfo(next.information);
    setLogs(next.logs);
  }

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load settings"));
  }, [props.models, props.agents]);

  const selectedProject = selectedProjectId ? props.projects?.find((p) => p.id === selectedProjectId) : null;
  const currentMeta = selectedProject
    ? ["project", selectedProject.name, `Project configuration & custom rules (${selectedProject.path})`]
    : page === "shortcuts"
      ? ["shortcuts", "Shortcuts", "Quick keyboard shortcuts for Saturn"]
      : page === "older"
        ? ["older", "Still running", "What the earlier interface set going"]
      : GROUPS.flatMap((group) => group.items).find(([id]) => id === page);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="h-[min(690px,88vh)] w-[min(980px,94vw)] max-w-[min(980px,94vw)] grid-cols-[210px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(980px,94vw)] max-[760px]:grid-cols-[168px_minmax(0,1fr)]">
        <Button
          variant="ghost"
          className="absolute top-3.5 right-4 z-20 size-7 px-0 text-muted-foreground"
          type="button"
          onClick={props.onClose}
          title="Close (Esc)"
          aria-label="Close settings"
        >
          <CloseIcon />
        </Button>

        <aside className="flex h-full flex-col justify-between overflow-hidden border-r border-border bg-muted/40 px-2.5 pt-4 pb-3">
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pr-0.5">
            {GROUPS.map((group) => (
              <div className="flex flex-col gap-0.5" key={group.title}>
                <div className={RAIL_GROUP}>{group.title}</div>
                {group.items.map(([id, label]) => (
                  <RailLink
                    key={id}
                    active={page === id && !selectedProjectId}
                    onClick={() => { setPage(id); setSelectedProjectId(null); setError(""); }}
                  >
                    <span>{label}</span>
                    {id === "llm" ? <small className="text-[11px] text-muted-foreground">{props.models.length}</small> : null}
                    {id === "mcp" ? <small className="text-[11px] text-muted-foreground">{props.mcp.length}</small> : null}
                  </RailLink>
                ))}
              </div>
            ))}

            {props.projects && props.projects.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                <div className={RAIL_GROUP}>Projects</div>
                {props.projects.map((proj) => (
                  <RailLink
                    key={proj.id}
                    active={selectedProjectId === proj.id}
                    onClick={() => { setSelectedProjectId(proj.id); setError(""); }}
                  >
                    <span>{proj.name}</span>
                  </RailLink>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-1.5 flex shrink-0 flex-col gap-1.5 border-t border-border pt-2.5">
            <RailLink
              active={page === "shortcuts" && !selectedProjectId}
              onClick={() => { setPage("shortcuts"); setSelectedProjectId(null); setError(""); }}
            >
              <span>Shortcuts</span>
            </RailLink>
            <RailLink
              active={page === "older" && !selectedProjectId}
              onClick={() => { setPage("older"); setSelectedProjectId(null); setError(""); }}
            >
              <span>Still running</span>
            </RailLink>
          </div>
        </aside>

        <div className="min-h-0 overflow-y-auto px-8.5 pb-12 max-[760px]:px-5 max-[760px]:pb-9" ref={paneRef}>
          <header className="sticky top-0 z-5 -mx-8.5 mb-5 flex items-start justify-between gap-4 border-b border-border bg-popover py-5.5 pr-16 pb-3.5 pl-8.5 max-[760px]:-mx-5 max-[760px]:mb-4 max-[760px]:pl-5">
            <div>
              <DialogTitle id="settings-dialog-title" className="text-xl font-semibold tracking-tight">{currentMeta?.[1] ?? "Settings"}</DialogTitle>
              {currentMeta?.[2] ? <DialogDescription className="mt-0.5 text-[12.5px]">{currentMeta[2]}</DialogDescription> : null}
            </div>
          </header>

          {error ? <Notice tone="bad" className="mb-3">{error}</Notice> : null}

          <div className={classes("flex flex-col gap-3", page === "telemetry" ? "max-w-[1180px]" : "max-w-[820px]")}>
            {selectedProject ? (
              <ProjectSettingsTab
                project={selectedProject}
                onError={setError}
              />
            ) : page === "shortcuts" ? (
              <ShortcutsTab />
            ) : (
              <>
                {page === "usage" ? <UsageBilling refreshOn={[props.models, props.agents]} /> : null}
                {page === "memory" ? <Memory projects={props.projects ?? []} /> : null}
                {page === "permissions" ? <PermissionsPage projects={props.projects ?? []} agents={props.agents} onError={setError} /> : null}
                {page === "hooks" ? <HooksPage projects={props.projects ?? []} onError={setError} /> : null}
                {page === "plugins" ? <PluginsPage onError={setError} /> : null}
                {page === "mcp" ? (
                  <McpPage
                    agent={props.agent}
                    mcp={props.mcp}
                    rag={props.rag}
                    onToggle={props.onPatchAgent}
                    onChanged={async () => { await props.onChanged(); await load(); }}
                    onError={setError}
                  />
                ) : null}
                {page === "llm" ? (
                  <LlmPage
                    models={props.models}
                    onChanged={async () => { await props.onChanged(); await load(); }}
                    onError={setError}
                  />
                ) : null}
                {page === "information" && info ? (
                  <About
                    info={info}
                    onRerunOnboarding={() => void desktop.admin.updateSettings({ onboardedAt: null }).then((next) => { props.onProfile(next); props.onClose(); })}
                  />
                ) : null}
                {page === "logs" ? <Logs lines={logs} onReload={() => void load()} /> : null}
                {page === "telemetry" ? <Telemetry /> : null}
                {page === "older" ? <OlderFeatures onError={setError} /> : null}
                {page === "settings" && profile ? (
                  <General
                    profile={profile}
                    models={props.models}
                    theme={props.theme}
                    onSetTheme={props.onSetTheme}
                    onToggleTheme={props.onToggleTheme}
                    onSaved={async (next) => { setProfile(next); props.onProfile(next); await load(); }}
                    onError={setError}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A group's name in the rail. */
const RAIL_GROUP = "px-2 pt-1 pb-0.5 text-[11px] font-semibold text-muted-foreground";

/** A page of settings in the rail. */
function RailLink(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={classes("w-full justify-between px-2.25 text-[13px] font-normal text-muted-foreground", props.active && "bg-card font-medium text-foreground")}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

/** Settings → General → Command line: install the `saturn` command, which runs this app's own CLI. */
/** What each of Saturn's own tool servers is for. */
const BUILT_IN_SUMMARIES: Record<string, string> = {
  "general-skills": "Files, commands, web and plans",
  "computer-use": "Mouse, keyboard and screen",
  origin: "GitHub repositories and pull requests",
  automations: "Schedules, rules, skills and plugins",
  browser: "A browser agents can drive",
  research: "Research records, runs and looking inside models",
};

function CommandLine(props: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void desktop.admin.cliStatus().then(setStatus, () => setStatus(null));
  }, []);
  async function install() {
    setBusy(true);
    try {
      setStatus(await desktop.admin.installCli());
      props.onError("");
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not install the command");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <SectionTitle>Command Line</SectionTitle>
      <SettingsCard>
        <SettingsRow>
          <RowText>
            <RowLabel>The saturn command</RowLabel>
            <RowDescription>
              Run agents from a terminal or a script while Saturn is open: <code>saturn run "fix the failing test" --agent Saturn --project .</code>, <code>saturn runs</code>, <code>saturn approve</code>. It uses this app's own runtime, so it never goes out of date.
              {status?.installed ? (status.current ? ` Installed at ${status.path}.` : ` Installed at ${status.path}, for another copy of Saturn: reinstall to point it here.`) : ""}
              {status?.installed && !status.onPath ? ` Add ${status.folder} to your PATH to type just "saturn".` : ""}
            </RowDescription>
          </RowText>
          <Button type="button" variant="default" size="small" disabled={busy || status?.current === true} onClick={() => void install()}>
            {status?.current ? "Installed" : status?.installed ? "Reinstall" : busy ? "Installing…" : "Install"}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

/** The box that shows a command or a code to copy. */
const COMMAND_BOX = "my-1.5 mb-1 flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-2";

/** Settings → Memory: the notes Saturn keeps, global and per project, as text the user can edit. */
function Memory(props: { projects: Project[] }) {
  const [scope, setScope] = useState("global");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    desktop.admin.memory(scope).then(
      (result) => {
        if (!current) return;
        setContent(result.content);
        setSaved(result.content);
        setError("");
      },
      (reason: unknown) => current && setError(reason instanceof Error ? reason.message : "Could not load memory"),
    );
    return () => {
      current = false;
    };
  }, [scope]);

  async function save() {
    try {
      const result = await desktop.admin.saveMemory(scope, content);
      setContent(result.content);
      setSaved(result.content);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  return (
    <div>
      <SectionTitle>Memory</SectionTitle>
      <SettingsCard>
        <SettingsRow>
          <RowText>
            <RowLabel>Notes</RowLabel>
            <RowDescription>One line per fact. Agents read these at the start of every chat (project notes in that project's chats, user notes everywhere). Delete a line to make Saturn forget it.</RowDescription>
          </RowText>
          <Choice className="w-45" ariaLabel="Memory scope" value={scope} options={[{ value: "global", label: "About you (every chat)" }, ...props.projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={setScope} />
        </SettingsRow>
        <SettingsRow stacked>
          <Textarea className="min-h-55 w-full resize-y font-mono text-[12.5px] leading-normal field-sizing-fixed" aria-label="Memory notes" value={content} rows={14} placeholder={scope === "global" ? "Nothing remembered yet. Notes appear after a few turns of chat, or write your own: \"- Prefers short answers\"." : "Nothing remembered about this project yet."} onChange={(event) => setContent(event.target.value)} />
          <RowActions>
            <Button type="button" variant="default" size="small" disabled={content === saved} onClick={() => void save()}>Save</Button>
            {content !== saved ? <Button type="button" variant="outline" size="small" onClick={() => setContent(saved)}>Discard</Button> : null}
          </RowActions>
        </SettingsRow>
        {error ? <RowError>{error}</RowError> : null}
      </SettingsCard>
    </div>
  );
}

function McpPage(props: {
  agent: Agent | null;
  mcp: Mcp[];
  rag: Rag[];
  onToggle: (patch: Partial<Agent>) => Promise<void>;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"url" | "command">("url");
  const [commandText, setCommandText] = useState("");
  const [commandName, setCommandName] = useState("");
  const [envText, setEnvText] = useState("");
  const [ragUrl, setRagUrl] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [configuringServer, setConfiguringServer] = useState<Mcp | null>(null);

  async function removeServer(id: string) {
    try {
      const users = (await desktop.catalog.listAgents()).filter((agent) => agent.mcpConnectionIds?.includes(id)).map((agent) => agent.name);
      const name = props.mcp.find((item) => item.id === id)?.name ?? "this server";
      if (users.length && !await askToConfirm(removalQuestion(name, users, "server", null))) return;
      await desktop.admin.deleteMcp(id, users.length > 0);
      setConfirming(null);
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not remove the MCP server");
    }
  }

  async function addMcp() {
    try {
      const created = await desktop.admin.createMcp(url);
      await desktop.admin.discoverMcp(created.id);
      setUrl("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not connect MCP");
    }
  }

  /** Adds a local server. Nothing runs yet: its card then shows the exact command for the user to allow. */
  async function addLocal() {
    try {
      const [program, ...args] = splitCommandLine(commandText);
      if (!program) throw new Error("Type the command that starts the server, for example npx -y @modelcontextprotocol/server-filesystem /path/to/folder");
      const env: Record<string, string> = {};
      for (const line of envText.split("\n").map((item) => item.trim()).filter(Boolean)) {
        const at = line.indexOf("=");
        if (at < 1) throw new Error(`"${line}" is not NAME=value`);
        env[line.slice(0, at).trim()] = line.slice(at + 1);
      }
      const created = await desktop.admin.createLocalMcp({ name: commandName.trim(), program, args, env });
      setCommandText("");
      setCommandName("");
      setEnvText("");
      setOpen((current) => ({ ...current, [created.id]: true }));
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not add the local MCP server");
    }
  }

  async function allow(item: Mcp) {
    try {
      await desktop.admin.approveMcp(item.id, item.commandFingerprint ?? "");
      await desktop.admin.discoverMcp(item.id);
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not start the MCP server");
      await props.onChanged();
    }
  }

  async function addRag() {
    try {
      await desktop.admin.createRag(ragUrl);
      setRagUrl("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not connect knowledge");
    }
  }

  const isBuiltin = (item: Mcp) =>
    item.url.startsWith("builtin:") ||
    ["general-skills", "computer-use", "origin", "automations", "cursor-computer-use", "cursor-origin", "antigravity-skills"].includes(item.id);

  const builtinServers = props.mcp.filter(isBuiltin);
  const installedServers = props.mcp.filter((item) => !isBuiltin(item));

  function renderMcpCard(item: Mcp) {
    const on = props.agent?.mcpConnectionIds.includes(item.id) ?? false;
    const builtin = isBuiltin(item);
    const removable = !builtin;
    const expanded = open[item.id] ?? false;
    return (
      <Card key={item.id}>
        <CardRow>
          <button
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-foreground"
            type="button"
            aria-expanded={expanded}
            onClick={() => setOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}
          >
            <Chevron open={expanded} />
            <span className="min-w-0">
              <strong className="block truncate">{item.name}</strong>
              <span className="block truncate text-[12.5px] text-muted-foreground">
                {item.command
                  ? `${item.approval === "approved" ? `${item.tools.length} tools · ` : ""}Local program · ${item.commandLine ?? item.command.program}`
                  : `${item.tools.length} tools · ${builtin ? (BUILT_IN_SUMMARIES[item.id] ?? "Built in") : item.url}`}
              </span>
            </span>
          </button>
          <RowActions>
            <Button
              variant="outline" size="small"
              type="button"
              onClick={() => setConfiguringServer(item)}
              title={`Configure ${item.name}`}
            >
              Configure
            </Button>
            {removable ? (
              confirming === item.id ? (
                <>
                  <Button variant="outline" size="small" type="button" onClick={() => setConfirming(null)}>Cancel</Button>
                  <Button variant="danger" size="small" type="button" onClick={() => void removeServer(item.id)}>Remove</Button>
                </>
              ) : (
                <Button variant="outline" size="small" type="button" onClick={() => setConfirming(item.id)}>Remove</Button>
              )
            ) : null}
            {!builtin ? (
              <Button
                variant={on ? "default" : "outline"} size="small"
                type="button"
                disabled={!props.agent}
                onClick={() =>
                  void props.onToggle({
                    mcpConnectionIds: on
                      ? props.agent!.mcpConnectionIds.filter((id) => id !== item.id)
                      : [...(props.agent?.mcpConnectionIds ?? []), item.id],
                  })
                }
              >
                {on ? "Enabled" : "Disabled"}
              </Button>
            ) : null}
          </RowActions>
        </CardRow>
        {item.command && item.approval !== "approved" ? (
          <Notice tone="wait" className="mt-2.5 grid gap-2 whitespace-normal">
            <p className="m-0 text-[12.5px] leading-snug">
              <strong>This server runs a program on your computer</strong>, with your user account&apos;s permissions. Allow it only if you
              trust it. It starts with only a minimal environment, not Saturn&apos;s keys.
            </p>
            <code className="block rounded-md bg-card px-2 py-1.5 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{item.commandLine}</code>
            {item.command.env?.length ? <p className="m-0 text-[12.5px] text-muted-foreground">Environment variables: {item.command.env.join(", ")} (values hidden)</p> : null}
            <RowActions className="gap-1.5">
              <Button variant="default" size="small" type="button" onClick={() => void allow(item)}>Allow and Start</Button>
              <Button variant="outline" size="small" type="button" onClick={() => void removeServer(item.id)}>Remove</Button>
            </RowActions>
          </Notice>
        ) : null}
        {expanded ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {item.tools.map((tool) => (
              <code className="rounded-md border border-border bg-muted px-2 py-0.5 text-[11.5px]" key={tool.toolId}>{tool.toolId}</code>
            ))}
          </div>
        ) : null}
      </Card>
    );
  }

  return (
    <>
      <SubTitle>Connect an MCP server</SubTitle>
      <Card>
        <Tabs value={kind} onValueChange={(next) => setKind(next as "url" | "command")} className="mt-2 mb-1">
          <TabsList aria-label="Kind of MCP server">
            <TabsTrigger value="url">URL</TabsTrigger>
            <TabsTrigger value="command">Local Program</TabsTrigger>
          </TabsList>
        </Tabs>
        {kind === "url" ? (
          <>
            <p className="text-[12.5px] text-muted-foreground">An MCP server reached over HTTP(S). Tools are discovered automatically.</p>
            <div className="flex gap-2">
              <Input value={url} placeholder="https://mcp.example.com/mcp" onChange={(event) => setUrl(event.target.value)} />
              <Button variant="default" type="button" disabled={!url.trim()} onClick={() => void addMcp()}>
                Connect MCP
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[12.5px] text-muted-foreground">
              A server Saturn starts on this computer and talks to over stdio. It runs only after you allow its exact command. No shell is
              used, so ~, $VARIABLES and pipes are not expanded: write full paths.
            </p>
            <div className="mt-2 grid gap-2">
              <Input value={commandName} placeholder="Name (optional)" onChange={(event) => setCommandName(event.target.value)} />
              <Input value={commandText} placeholder="npx -y @modelcontextprotocol/server-filesystem /Users/you/Documents" onChange={(event) => setCommandText(event.target.value)} />
              <Textarea className="resize-y font-mono text-xs field-sizing-fixed" value={envText} rows={2} placeholder={"Environment variables, one per line (optional)\nGITHUB_TOKEN=…"} onChange={(event) => setEnvText(event.target.value)} />
              <Button variant="default" className="justify-self-start" type="button" disabled={!commandText.trim()} onClick={() => void addLocal()}>
                Add Local Server
              </Button>
            </div>
          </>
        )}
      </Card>

      <SubTitle>Built in</SubTitle>
      {builtinServers.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No built-in skills available.</p>
      ) : (
        builtinServers.map(renderMcpCard)
      )}

      <SubTitle className="mt-6">Installed MCP Servers</SubTitle>
      {installedServers.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No external MCP servers installed yet.</p>
      ) : (
        installedServers.map(renderMcpCard)
      )}

      {configuringServer && (
        <ConfigureMcpModal
          server={configuringServer}
          onClose={() => setConfiguringServer(null)}
          onSave={async (disabledTools) => {
            try {
              await desktop.admin.updateMcp(configuringServer.id, { disabledTools });
              props.onError("");
              await props.onChanged();
            } catch (reason) {
              props.onError(reason instanceof Error ? reason.message : "Could not save tool configuration");
            }
          }}
          onReload={async () => {
            try {
              await desktop.admin.discoverMcp(configuringServer.id);
              props.onError("");
              await props.onChanged();
            } catch (reason) {
              props.onError(reason instanceof Error ? reason.message : "Could not reload tools");
            }
          }}
        />
      )}

      <SubTitle className="mt-6">Knowledge & RAG Endpoints</SubTitle>
      <Card>
        <div className="text-xs font-medium text-muted-foreground">Connect Knowledge URL</div>
        <div className="flex gap-2">
          <Input value={ragUrl} placeholder="http://127.0.0.1:4200/search" onChange={(event) => setRagUrl(event.target.value)} />
          <Button variant="default" type="button" disabled={!ragUrl.trim()} onClick={() => void addRag()}>
            Connect Knowledge
          </Button>
        </div>
      </Card>
      {props.rag.map((item) => {
        const on = props.agent?.ragConnectionIds.includes(item.id) ?? false;
        return (
          <Card key={item.id}>
            <CardRow>
              <div>
                <strong>{item.name}</strong>
                <div className="text-[12.5px] text-muted-foreground">{item.url}</div>
              </div>
              <Button
                variant={on ? "default" : "outline"} size="small"
                type="button"
                disabled={!props.agent}
                onClick={() =>
                  void props.onToggle({
                    ragConnectionIds: on
                      ? props.agent!.ragConnectionIds.filter((id) => id !== item.id)
                      : [...(props.agent?.ragConnectionIds ?? []), item.id],
                  })
                }
              >
                {on ? "Enabled" : "Disabled"}
              </Button>
            </CardRow>
          </Card>
        );
      })}
    </>
  );
}

export function LlmPage(props: {
  models: Model[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [providerId, setProviderId] = useState("openai");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:1234");
  const [secret, setSecret] = useState("");
  const [effort, setEffort] = useState("");
  const [studioModels, setStudioModels] = useState<{ id: string; label: string }[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];

  useEffect(() => {
    void desktop.admin.providers().then((next) => {
      setProviders(next);
      const first = next[0];
      if (!first) return;
      setProviderId(first.id);
      setModelId(first.models[0]?.id ?? "");
      setBaseUrl(first.baseUrl);
    }).catch((reason: unknown) => props.onError(reason instanceof Error ? reason.message : "Could not load models"));
  }, []);

  useEffect(() => {
    if (providerId !== "lmstudio") return;
    const url = baseUrl.trim();
    void desktop.admin.lmStudioModels(url)
      .then((next) => {
        setStudioModels(next);
        setModelId((current) => current || next[0]?.id || "");
      })
      .catch(() => setStudioModels([]));
  }, [providerId, baseUrl]);

  function chooseProvider(id: string) {
    const next = providers.find((item) => item.id === id);
    setProviderId(id);
    setModelId(next?.models[0]?.id ?? "");
    setBaseUrl(next?.baseUrl ?? "");
    setSecret("");
  }

  async function add() {
    try {
      await desktop.admin.createModel({
        provider: providerId,
        model: modelId,
        baseUrl: providerId === "lmstudio" ? baseUrl : undefined,
        secret: secret || undefined,
        effort: supportsEffort(providerId) && effort ? effort : undefined,
      });
      setSecret("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not connect the model");
    }
  }

  async function bindKey(id: string) {
    try {
      await desktop.admin.updateModelKey(id, keyDraft.trim());
      setEditingKey(null);
      setKeyDraft("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save the API key");
    }
  }

  const choices = providerId === "lmstudio" ? studioModels : provider?.models ?? [];
  const needsKey = provider?.needsKey ?? true;
  const savedKey = props.models.some((item) => item.provider === providerId && item.hasSecret);

  return (
    <>
      <SubTitle>Connected models</SubTitle>
      {props.models.length === 0 ? (
        <p className="mb-3.5 text-[12.5px] text-muted-foreground">No models connected yet. Add a cloud or local LM Studio model below.</p>
      ) : (
        props.models.map((item) => {
          return (
            <Card key={item.id}>
              <CardRow>
                <div>
                  <div className="flex items-center gap-2">
                    <strong>{item.name}</strong>
                  </div>
                  <div className="text-[12.5px] text-muted-foreground">{providerLabel(providers, item)}{item.model ? ` · ${item.model}` : ""}</div>
                </div>
                <div className="flex items-center gap-2">
                  {supportsEffort(item.provider) ? (
                    <div title={(item.provider && EFFORT_HINTS[item.provider]) || "How much the model reasons before answering"}>
                      <Choice
                        className="min-w-33"
                        ariaLabel={`Effort for ${item.name}`}
                        value={item.effort || DEFAULT_EFFORT}
                        options={[{ value: DEFAULT_EFFORT, label: "Default effort" }, ...Object.entries(EFFORT_LABELS).map(([value, label]) => ({ value, label: `${label} effort` }))]}
                        onChange={async (next) => {
                          try {
                            await desktop.admin.updateModelEffort(item.id, next === DEFAULT_EFFORT ? null : next);
                            await props.onChanged();
                          } catch (err) {
                            props.onError(err instanceof Error ? err.message : "Could not change the effort");
                          }
                        }}
                      />
                    </div>
                  ) : null}
                  <Status
                    ok={item.provider === "lmstudio" || item.provider === "claude-code" || item.provider === "codex" || item.hasSecret}
                    label={item.provider === "lmstudio" ? "Local Server" : item.provider === "claude-code" ? "Claude plan" : item.provider === "codex" ? "ChatGPT plan" : item.hasSecret ? "Key stored" : "No key"}
                  />
                  {item.provider !== "lmstudio" && item.provider !== "claude-code" && item.provider !== "codex" && editingKey !== item.id ? (
                    <Button
                      variant="outline" size="small"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingKey(item.id);
                        setKeyDraft("");
                      }}
                    >
                      {item.hasSecret ? "Replace Key" : "Add Key"}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost" size="small" className="text-muted-foreground hover:bg-destructive/12 hover:text-destructive"
                    type="button"
                    title="Remove model"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        const users = (await desktop.catalog.listAgents()).filter((agent) => agent.modelConnectionId === item.id).map((agent) => agent.name);
                        const replacement = props.models.find((model) => model.id !== item.id) ?? null;
                        if (!await askToConfirm(removalQuestion(item.name, users, "model", replacement?.name ?? null))) return;
                        await desktop.admin.deleteModel(item.id, users.length ? (replacement?.id ?? "none") : undefined);
                        await props.onChanged();
                      } catch (err) {
                        props.onError(err instanceof Error ? err.message : "Failed to remove model");
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </CardRow>
              {editingKey === item.id ? (
                <form
                  className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5"
                  onClick={(e) => e.stopPropagation()}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void bindKey(item.id);
                  }}
                >
                  <Input
                    type="password"
                    autoFocus
                    autoComplete="off"
                    aria-label={`API key for ${item.name}`}
                    placeholder={`Paste ${providerLabel(providers, item)} API key…`}
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingKey(null);
                    }}
                  />
                  <Button variant="outline" size="small" type="button" onClick={() => setEditingKey(null)}>Cancel</Button>
                  <Button variant="default" size="small" type="submit" disabled={!keyDraft.trim()}>Save Key</Button>
                </form>
              ) : null}
            </Card>
          );
        })
      )}

      <SubTitle className="mt-5">Connect a model</SubTitle>
      <Card className="gap-3.5">
        <div className="grid grid-cols-2 gap-3 max-[860px]:grid-cols-1">
          <Choice label="Provider" value={providerId} options={providers.map((item) => ({ value: item.id, label: item.label }))} onChange={chooseProvider} />
          {providerId === "lmstudio" && choices.length === 0 ? (
            <Field label="Model">
              <Input id="llm-model" value={modelId} placeholder="Model identifier in LM Studio" onChange={(event) => setModelId(event.target.value)} />
            </Field>
          ) : (
            <Choice label="Model" value={modelId} options={choices.map((item) => ({ value: item.id, label: item.label }))} onChange={setModelId} />
          )}
        </div>

        {supportsEffort(providerId) ? (
          <div className="flex flex-col gap-1.5">
            <Choice
              label="Effort"
              value={effort || DEFAULT_EFFORT}
              options={[{ value: DEFAULT_EFFORT, label: "Model default" }, ...Object.entries(EFFORT_LABELS).map(([value, label]) => ({ value, label }))]}
              onChange={(next) => setEffort(next === DEFAULT_EFFORT ? "" : next)}
            />
            <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
              {EFFORT_HINTS[providerId] ?? "How much the model reasons before answering. Higher is slower and costs more."}
              {providerId === "claude-code" ? " Runs through the official Claude Code program on your own Claude login (Settings → General → Claude Code). Saturn never sends API requests for it, takes no API key, and does not schedule it." : ""}
              {providerId === "codex" ? " Runs through the official Codex on your own ChatGPT login (Settings → General → Codex). No API key." : ""}
            </p>
          </div>
        ) : null}

        {providerId === "lmstudio" ? (
          <Field label="LM Studio Endpoint">
            <Input id="llm-host" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </Field>
        ) : null}

        {needsKey ? (
          <Field label="API Key">
            <Input
              id="llm-key"
              type="password"
              value={secret}
              placeholder={savedKey ? `Using your saved ${provider?.label ?? ""} key — paste to replace` : "Paste provider API key…"}
              autoComplete="off"
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            variant="default"
            type="button"
            disabled={!modelId.trim() || (needsKey && !savedKey && !secret.trim())}
            onClick={() => void add()}
          >
            Connect Model
          </Button>
        </div>
      </Card>
    </>
  );
}

/** The effort choice that stands for the model's own default, which is stored as no effort at all. */
const DEFAULT_EFFORT = "default";

/** What the effort setting does on each provider. */
const EFFORT_HINTS: Record<string, string> = {
  claude: "Claude's effort setting (output_config.effort). Models without effort support ignore it.",
  "claude-code": "Claude Code's effort level.",
  codex: "Codex reasoning effort.",
  openai: "OpenAI reasoning effort for o-series and GPT-5 models (Extra High and Max use High). Other models ignore it.",
  gemini: "Gemini thinking level (3.x and 4) or thinking budget (2.5).",
};

function providerLabel(providers: LlmProvider[], model: Model) {
  return providers.find((item) => item.id === model.provider)?.label ?? model.provider ?? "Model";
}

/** The log filters' choice for everything, since a choice cannot be empty. */
const ALL_LOGS = "all";

function Logs(props: { lines: LogLine[]; onReload: () => void }) {
  const [service, setService] = useState("");
  const [level, setLevel] = useState("");
  const services = [...new Set(props.lines.map((item) => item.service))].sort();
  const rank = { debug: 0, info: 1, warning: 2, error: 3 } as const;
  const shown = props.lines.filter((item) => {
    if (service && item.service !== service) return false;
    if (level && rank[item.level] < rank[level as keyof typeof rank]) return false;
    return true;
  });
  return (
    <>
      <div className="flex items-center gap-2">
        <Choice className="min-w-35" ariaLabel="Service" value={service || ALL_LOGS} options={[{ value: ALL_LOGS, label: "All services" }, ...services.map((name) => ({ value: name, label: name }))]} onChange={(next) => setService(next === ALL_LOGS ? "" : next)} />
        <Choice
          className="min-w-35"
          ariaLabel="Level"
          value={level || ALL_LOGS}
          options={[{ value: ALL_LOGS, label: "All levels" }, { value: "info", label: "info+" }, { value: "warning", label: "warning+" }, { value: "error", label: "error" }]}
          onChange={(next) => setLevel(next === ALL_LOGS ? "" : next)}
        />
        <Button variant="outline" type="button" onClick={props.onReload}>Refresh</Button>
      </div>
      <div className="h-[54vh] overflow-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-xs leading-normal">
        {shown.length === 0 ? <div className="text-[12.5px] text-muted-foreground">No log lines matching filter.</div> : shown.map((item) => (
          <div className={classes("grid grid-cols-[88px_72px_64px_1fr] gap-2.5 py-0.5", item.level === "debug" && "opacity-60", item.level === "warning" && "text-wait", item.level === "error" && "text-destructive")} key={item.seq}>
            <span className="text-muted-foreground">{item.ts.slice(11, 23)}</span>
            <span className="text-muted-foreground">{item.service}</span>
            <span>{item.level}</span>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** The background model choice for letting the agent's own model do the work, since a choice cannot be empty. */
const AUTOMATIC_MODEL = "automatic";

/** The models Saturn runs itself (runtime/src/infrastructure/embeddings.ts); the first ships with the app. */
const BUILTIN_EMBEDDING_MODELS = [
  { id: "multilingual-e5-small", label: "E5 multilingual (included)" },
  { id: "jina-embeddings-v2-base-code", label: "Jina code (162 MB)" },
];

function General(props: {
  profile: Profile;
  models: Model[];
  onSaved: (profile: Profile) => Promise<void>;
  onError: (message: string) => void;
  theme?: "light" | "dark";
  onSetTheme?: (theme: "light" | "dark") => void;
  onToggleTheme?: () => void;
}) {
  const [name, setName] = useState(props.profile.name);
  const [logging, setLogging] = useState(props.profile.logging);
  const [memory, setMemory] = useState(props.profile.memory !== false);
  const [notify, setNotify] = useState(localStorage.getItem("saturn-notify") !== "off");
  const [planApproval, setPlanApproval] = useState(props.profile.planApproval === true);
  const [claudeProjectSettings, setClaudeProjectSettings] = useState(props.profile.claudeProjectSettings === true);
  const [agentBrowser, setAgentBrowser] = useState<AgentBrowser>(props.profile.browser ?? "saturn");
  // Safari's automation (safaridriver) exists only on macOS.
  const isMac = /Mac/i.test(navigator.userAgent);

  async function chooseAgentBrowser(next: AgentBrowser) {
    if (next === agentBrowser) return;
    const previous = agentBrowser;
    setAgentBrowser(next);
    try {
      await props.onSaved(await desktop.admin.updateSettings({ browser: next }));
      props.onError("");
    } catch (reason) {
      setAgentBrowser(previous);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  async function chooseClaudeProjectSettings(next: boolean) {
    setClaudeProjectSettings(next);
    try {
      await props.onSaved(await desktop.admin.updateSettings({ claudeProjectSettings: next }));
      props.onError("");
    } catch (reason) {
      setClaudeProjectSettings(!next);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }
  const [sandbox, setSandbox] = useState<SandboxSettings>(props.profile.sandbox ?? { mode: "workspace-write", network: true });

  async function chooseSandbox(next: SandboxSettings) {
    const previous = sandbox;
    setSandbox(next);
    try {
      await props.onSaved(await desktop.admin.updateSettings({ sandbox: next }));
      props.onError("");
    } catch (reason) {
      setSandbox(previous);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }
  // Settings from before the source could be chosen (a model name only) meant LM Studio.
  const savedSource: EmbeddingSource = props.profile.embeddingSource ?? (props.profile.embeddingModel && !BUILTIN_EMBEDDING_MODELS.some((item) => item.id === props.profile.embeddingModel) ? "lmstudio" : "builtin");
  const [embeddingSource, setEmbeddingSource] = useState<EmbeddingSource>(savedSource);
  const [embeddingModel, setEmbeddingModel] = useState(props.profile.embeddingModel ?? "");
  const [embeddingConnectionId, setEmbeddingConnectionId] = useState(props.profile.embeddingConnectionId ?? "");
  const embeddingConnections = props.models.filter((item) => item.provider === "openai");

  async function chooseFlag(flag: "memory" | "planApproval", next: boolean) {
    const set = flag === "memory" ? setMemory : setPlanApproval;
    set(next);
    try {
      await props.onSaved(await desktop.admin.updateSettings({ [flag]: next }));
      props.onError("");
    } catch (reason) {
      set(!next);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  async function chooseEmbedding(patch: { embeddingSource?: EmbeddingSource; embeddingModel?: string; embeddingConnectionId?: string } = {}) {
    try {
      await props.onSaved(await desktop.admin.updateSettings({
        embeddingSource: patch.embeddingSource ?? embeddingSource,
        embeddingModel: patch.embeddingModel ?? embeddingModel.trim(),
        embeddingConnectionId: patch.embeddingConnectionId ?? embeddingConnectionId,
      }));
      props.onError("");
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }
  const [saved, setSaved] = useState(false);
  const [backgroundModelId, setBackgroundModelId] = useState(props.profile.completionModelId ?? "");
  // Claude Code and Codex models run an agent loop on the user's plan; background work needs a plain API call.
  const backgroundChoices = props.models.filter((item) => item.provider !== "claude-code" && item.provider !== "codex");

  async function chooseBackgroundModel(next: string) {
    const previous = backgroundModelId;
    setBackgroundModelId(next);
    try {
      await props.onSaved(await desktop.admin.updateSettings({ completionModelId: next || null }));
      props.onError("");
    } catch (reason) {
      setBackgroundModelId(previous);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  async function save() {
    try {
      const next = await desktop.admin.updateSettings({ name, logging });
      setSaved(true);
      props.onError("");
      await props.onSaved(next);
      setTimeout(() => setSaved(false), 2000);
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  const themeButtons = (
    <Pills
      label="Theme"
      value={props.theme}
      options={[["light", "Light", <SunIcon key="sun" />], ["dark", "Dark", <MoonIcon key="moon" />]] as const}
      onChoose={(value) => {
        if (props.onSetTheme) props.onSetTheme(value);
        else if (props.theme !== value) props.onToggleTheme?.();
      }}
    />
  );

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <div>
        <SectionTitle>General</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Agent browser</RowLabel>
              <RowDescription>
                {agentBrowser === "system"
                  ? "Agents browse in a visible window of your Chrome (or Edge, Brave), with Saturn's own profile: your logins and tabs stay out of it. You watch the cursor there."
                  : agentBrowser === "safari"
                    ? "Agents browse in a Safari automation window (striped address bar), clean of your logins; you cannot click into it while the agent works. Turn on Develop → Allow Remote Automation in Safari once. The Browser tab shows it about once a second."
                    : "Agents browse in Saturn's own browser, shown live in the chat's Browser tab with the agent's cursor."}
              </RowDescription>
            </RowText>
            <Pills
              label="Agent browser"
              value={agentBrowser}
              options={isMac ? ([["saturn", "Saturn"], ["system", "Chrome"], ["safari", "Safari"]] as const) : ([["saturn", "Saturn"], ["system", "Chrome"]] as const)}
              onChoose={(value) => void chooseAgentBrowser(value)}
            />
          </SettingsRow>
          <SettingsRow>
            <RowText>
              <RowLabel>Theme</RowLabel>
              <RowDescription>Light or dark appearance.</RowDescription>
            </RowText>
            {themeButtons}
          </SettingsRow>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Computer use</SectionTitle>
        <SettingsCard>
          <ComputerPermissions />
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Storage</SectionTitle>
        <SettingsCard>
          <SnapshotStorage onError={props.onError} />
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Claude Code</SectionTitle>
        <SettingsCard>
          <ProgramGate id="claude-code">
            <ClaudeCodeLogin />
          </ProgramGate>
          <SettingsRow>
            <RowText>
              <RowLabel>Use the project's Claude Code settings</RowLabel>
              <RowDescription>Claude Code loads the chat's project <code>.claude/settings.json</code>: its hooks, permission rules and settings, as it would in a terminal there. Your own Claude settings are never loaded. Off by default, since a project's hooks run commands.</RowDescription>
            </RowText>
            <Switch checked={claudeProjectSettings} aria-label="Use the project's Claude Code settings" onCheckedChange={(next) => void chooseClaudeProjectSettings(next)} />
          </SettingsRow>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Codex</SectionTitle>
        <SettingsCard>
          <ProgramGate id="codex">
            <CodexLogin />
          </ProgramGate>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Models</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Background Model</RowLabel>
              <RowDescription>
                Writes memory notes from your chats, and drafts automations when an agent's own model has no API. Chat content goes to this model. On Automatic, memory notes use the agent's model.
              </RowDescription>
            </RowText>
            <Choice
              className="w-45"
              ariaLabel="Background model"
              value={backgroundModelId || AUTOMATIC_MODEL}
              disabled={!backgroundChoices.length && !backgroundModelId}
              options={[{ value: AUTOMATIC_MODEL, label: "Automatic" }, ...backgroundChoices.map((item) => ({ value: item.id, label: item.name }))]}
              onChange={(next) => void chooseBackgroundModel(next === AUTOMATIC_MODEL ? "" : next)}
            />
          </SettingsRow>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Agents</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Memory</RowLabel>
              <RowDescription>Every few turns, Saturn notes durable facts from the chat (how you like to work, a project's conventions) and gives them to agents in later chats. Read and edit the notes under Memory.</RowDescription>
            </RowText>
            <Switch checked={memory} aria-label="Memory" onCheckedChange={(next) => void chooseFlag("memory", next)} />
          </SettingsRow>
          <SettingsRow>
            <RowText>
              <RowLabel>Notifications</RowLabel>
              <RowDescription>A system notification when an agent finishes, fails or needs your approval while you are not looking at its chat. Click it to open the chat.</RowDescription>
            </RowText>
            <Switch checked={notify} aria-label="Notifications" onCheckedChange={(next) => { setNotify(next); localStorage.setItem("saturn-notify", next ? "on" : "off"); }} />
          </SettingsRow>
          <SettingsRow>
            <RowText>
              <RowLabel>Plan approval</RowLabel>
              <RowDescription>Agents write a plan and wait for your go-ahead before changing files or running commands. Reply "go" to proceed, or say what to change.</RowDescription>
            </RowText>
            <Switch checked={planApproval} aria-label="Plan approval" onCheckedChange={(next) => void chooseFlag("planApproval", next)} />
          </SettingsRow>
          <SettingsRow>
            <RowText>
              <RowLabel>Embedding model</RowLabel>
              <RowDescription>Builds each project's code index, so agents find code by meaning. The built-in model runs on this Mac with nothing else to install; changing the model rebuilds the index.</RowDescription>
            </RowText>
            <div className="flex items-center gap-2">
              <Choice
                ariaLabel="Embedding source"
                value={embeddingSource}
                options={[{ value: "builtin", label: "Built in" }, { value: "lmstudio", label: "LM Studio" }, { value: "openai", label: "OpenAI-compatible" }]}
                onChange={(value) => {
                  const next = value as EmbeddingSource;
                  const model = next === "builtin" ? BUILTIN_EMBEDDING_MODELS[0]!.id : next === "lmstudio" ? "text-embedding-nomic-embed-text-v1.5" : "text-embedding-3-small";
                  const connection = next === "openai" ? embeddingConnectionId || embeddingConnections[0]?.id || "" : embeddingConnectionId;
                  setEmbeddingSource(next);
                  setEmbeddingModel(model);
                  setEmbeddingConnectionId(connection);
                  void chooseEmbedding({ embeddingSource: next, embeddingModel: model, embeddingConnectionId: connection });
                }}
              />
              {embeddingSource === "builtin" ? (
                <Choice
                  ariaLabel="Built-in embedding model"
                  value={BUILTIN_EMBEDDING_MODELS.some((item) => item.id === embeddingModel) ? embeddingModel : BUILTIN_EMBEDDING_MODELS[0]!.id}
                  options={BUILTIN_EMBEDDING_MODELS.map((item) => ({ value: item.id, label: item.label }))}
                  onChange={(next) => {
                    setEmbeddingModel(next);
                    void chooseEmbedding({ embeddingModel: next });
                  }}
                />
              ) : (
                <InlineForm onSubmit={(event) => { event.preventDefault(); void chooseEmbedding(); }}>
                  {embeddingSource === "openai" && (
                    <Choice className="min-w-45" ariaLabel="Embedding connection" value={embeddingConnectionId} placeholder={embeddingConnections.length === 0 ? "Add an OpenAI connection first" : undefined} options={embeddingConnections.map((item) => ({ value: item.id, label: item.name }))} onChange={setEmbeddingConnectionId} />
                  )}
                  <Input className="w-45" aria-label="Embedding model" value={embeddingModel} placeholder={embeddingSource === "lmstudio" ? "text-embedding-nomic-embed-text-v1.5" : "text-embedding-3-small"} onChange={(event) => setEmbeddingModel(event.target.value)} />
                  <Button type="submit" variant="default" size="small" disabled={(props.profile.embeddingModel ?? "") === embeddingModel.trim() && (props.profile.embeddingConnectionId ?? "") === embeddingConnectionId && props.profile.embeddingSource === embeddingSource}>Save</Button>
                </InlineForm>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </div>

      <CommandLine onError={props.onError} />

      <div>
        <SectionTitle>Sandbox</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Commands</RowLabel>
              <RowDescription>
                Where a shell command run by an agent may write. <strong>Workspace</strong> confines it to the project folder (plus temp and cache folders) with the operating system's sandbox, so a stray <code>rm</code> or a script cannot touch anything else; <strong>Read-only</strong> lets it write nowhere; <strong>Off</strong> runs it as you. An agent can ask to run one command outside the sandbox, which shows an approval card. macOS and Linux (with bubblewrap) sandbox; Windows cannot. A project can override this.
              </RowDescription>
            </RowText>
            <Choice ariaLabel="Sandbox mode" value={sandbox.mode} options={[{ value: "workspace-write", label: "Workspace" }, { value: "read-only", label: "Read-only" }, { value: "off", label: "Off" }]} onChange={(next) => void chooseSandbox({ ...sandbox, mode: next as SandboxMode })} />
          </SettingsRow>
          <SettingsRow>
            <RowText>
              <RowLabel>Network</RowLabel>
              <RowDescription>Whether sandboxed commands may use the network (package installs, git push, curl). Off blocks every connection except local sockets; the agent can still ask to run a command outside the sandbox.</RowDescription>
            </RowText>
            <Switch checked={sandbox.network} aria-label="Network for commands" onCheckedChange={(next) => void chooseSandbox({ ...sandbox, network: next })} />
          </SettingsRow>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Workspace</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Workspace Name</RowLabel>
              <RowDescription>Shown in the title bar and settings.</RowDescription>
            </RowText>
            <InlineForm
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                className="w-45"
                aria-label="Workspace name"
                value={name}
                onChange={(event) => { setName(event.target.value); setSaved(false); }}
              />
              <Button type="submit" variant="default" size="small" disabled={!name.trim() || name === props.profile.name}>
                {saved ? "Saved ✓" : "Save"}
              </Button>
            </InlineForm>
          </SettingsRow>

          <SettingsRow>
            <RowText>
              <RowLabel>Log Level</RowLabel>
              <RowDescription>How much the runtime writes to Logs.</RowDescription>
            </RowText>
            <Pills
              label="Log level"
              value={logging}
              options={[["debug", "Debug"], ["info", "Info"], ["warning", "Warning"], ["error", "Error"]] as const}
              onChoose={(level) => {
                const previous = logging;
                setLogging(level);
                desktop.admin.updateSettings({ logging: level }).then(props.onSaved, (reason: unknown) => {
                  setLogging(previous);
                  props.onError(reason instanceof Error ? reason.message : "Could not save");
                });
              }}
            />
          </SettingsRow>

          <SettingsRow>
            <RowText>
              <RowLabel>API Keys</RowLabel>
              <RowDescription>Kept on this Mac in a file only your user account can read.</RowDescription>
            </RowText>
            <code className="rounded-md bg-muted px-2 py-0.5 text-[11.5px] whitespace-nowrap text-muted-foreground">~/.saturn-app/secrets.json</code>
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  );
}

function ProjectSettingsTab(props: {
  project: Project;
  onError: (message: string) => void;
}) {
  const [rules, setRules] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [verifyCommand, setVerifyCommand] = useState(props.project.verifyCommand ?? "");
  const [verifySaved, setVerifySaved] = useState(false);
  const [sandbox, setSandbox] = useState<SandboxSettings | null>(props.project.sandbox ?? null);

  async function chooseSandbox(next: SandboxSettings | null) {
    const previous = sandbox;
    setSandbox(next);
    try {
      await desktop.projects.update(props.project.id, { sandbox: next });
    } catch (reason) {
      setSandbox(previous);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  async function saveVerify() {
    try {
      await desktop.projects.update(props.project.id, { verifyCommand: verifyCommand.trim() });
      setVerifySaved(true);
      setTimeout(() => setVerifySaved(false), 2000);
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    desktop.projects
      .getRules(props.project.id)
      .then((result) => {
        if (!active) return;
        setRules(result.content);
        setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.project.id]);

  async function saveRules() {
    setSaving(true);
    try {
      await desktop.projects.saveRules(props.project.id, rules);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Failed to save project rules");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <div>
        <SectionTitle>Project Details</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Project Name</RowLabel>
              <RowDescription>{props.project.name}</RowDescription>
            </RowText>
          </SettingsRow>
          <SettingsRow>
            <RowText>
              <RowLabel>Workspace Path</RowLabel>
              <RowDescription className="font-mono">{props.project.path}</RowDescription>
            </RowText>
          </SettingsRow>
          {props.project.gitBranch ? (
            <SettingsRow>
              <RowText>
                <RowLabel>Git Branch</RowLabel>
                <RowDescription className="font-mono">{props.project.gitBranch}</RowDescription>
              </RowText>
            </SettingsRow>
          ) : null}
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Check After Changes</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Verify command</RowLabel>
              <RowDescription>Run after an agent changes files here; a failure goes straight back to the agent to fix (at most twice per message). Use "auto" for package.json's typecheck or lint script, or leave empty to skip.</RowDescription>
            </RowText>
            <InlineForm onSubmit={(event) => { event.preventDefault(); void saveVerify(); }}>
              <Input className="w-45" aria-label="Verify command" value={verifyCommand} placeholder="auto, or e.g. npm test" onChange={(event) => setVerifyCommand(event.target.value)} />
              <Button type="submit" variant="default" size="small" disabled={(props.project.verifyCommand ?? "") === verifyCommand.trim()}>{verifySaved ? "Saved" : "Save"}</Button>
            </InlineForm>
          </SettingsRow>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Sandbox</SectionTitle>
        <SettingsCard>
          <SettingsRow>
            <RowText>
              <RowLabel>Commands in this project</RowLabel>
              <RowDescription>Overrides the sandbox under Settings → General for commands run here. Workspace confines writes to this folder; Read-only allows none; Off runs commands as you.</RowDescription>
            </RowText>
            <div className="flex items-center gap-2">
              <Choice
                ariaLabel="Sandbox for this project"
                value={sandbox?.mode ?? "inherit"}
                options={[{ value: "inherit", label: "Same as General" }, { value: "workspace-write", label: "Workspace" }, { value: "read-only", label: "Read-only" }, { value: "off", label: "Off" }]}
                onChange={(next) => void chooseSandbox(next === "inherit" ? null : { mode: next as SandboxMode, network: sandbox?.network ?? true })}
              />
              {sandbox ? <Switch checked={sandbox.network} aria-label="Network for commands" onCheckedChange={(next) => void chooseSandbox({ ...sandbox, network: next })} /> : null}
            </div>
          </SettingsRow>
        </SettingsCard>
      </div>

      <ProjectPermissions project={props.project} onError={props.onError} />

      <div>
        <SectionTitle>Project Rules & Custom Instructions</SectionTitle>
        <SettingsCard>
          <div className="flex flex-col gap-2.5">
            <RowDescription>Custom instructions for agents working in this project (.cursorrules / AGENTS.md).</RowDescription>
            <Textarea
              className="resize-y font-mono text-xs field-sizing-fixed"
              rows={7}
              value={rules}
              disabled={loading}
              placeholder={loading ? "Loading project rules…" : "Add custom instructions for this project…"}
              onChange={(event) => {
                setRules(event.target.value);
                setSaved(false);
              }}
            />
            <div className="flex justify-end">
              <Button type="button" variant="default" size="small" disabled={saving || loading} onClick={() => void saveRules()}>
                {saving ? "Saving…" : saved ? "Saved ✓" : "Save Rules"}
              </Button>
            </div>
          </div>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Actions</SectionTitle>
        <SettingsCard className="flex flex-wrap gap-2.5">
          <Button type="button" variant="outline" size="small" onClick={() => void desktop.projects.openInTerminal(props.project.id)}>
            Open in Terminal
          </Button>
          <Button type="button" variant="outline" size="small" onClick={() => void desktop.projects.openInFolder(props.project.id)}>
            Reveal in Finder
          </Button>
        </SettingsCard>
      </div>
    </div>
  );
}

function ShortcutsTab() {
  const shortcuts = [
    ["⌘ K", "Commands"],
    ["⌘ 1 to 7", "Go to a screen"],
    ["⌘ J", "Show or hide the research assistant"],
    ["⌘ S", "Save the open file"],
    ["⌘ ,", "Open Settings"],
    ["Enter", "Send a message"],
    ["Shift + Enter", "New line in a message"],
    ["Esc", "Close popups"],
  ];
  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <div>
        <SectionTitle>Keyboard Shortcuts</SectionTitle>
        <SettingsCard>
          {shortcuts.map(([keys, label]) => (
            <SettingsRow key={keys}>
              <RowText>
                <RowLabel>{label}</RowLabel>
              </RowText>
              <kbd className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs">
                {keys}
              </kbd>
            </SettingsRow>
          ))}
        </SettingsCard>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function Chevron(props: { open: boolean }) {
  return (
    <svg className={classes("size-4 shrink-0 text-muted-foreground transition-transform", props.open && "rotate-90")} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Claude Code and Codex are separate official programs that Saturn no longer ships in its installer. Until one is
 * found (Saturn's download, or the user's own install on the PATH), this offers the download; once it is, it shows
 * where it comes from and then the sign-in (children).
 */
export function ProgramGate(props: { id: ProgramStatus["id"]; children: ReactNode }) {
  const [status, setStatus] = useState<ProgramStatus | null>(null);
  const [error, setError] = useState("");
  const load = () => desktop.admin.program(props.id).then(setStatus, (reason) => setError(reason instanceof Error ? reason.message : "Could not reach the runtime"));

  useEffect(() => {
    void load();
  }, [props.id]);

  const busy = status?.install && ["downloading", "verifying", "unpacking"].includes(status.install.state);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 700);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function install() {
    setError("");
    try {
      setStatus(await desktop.admin.installProgram(props.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the download");
    }
  }

  async function remove() {
    if (!await askToConfirm(`Remove Saturn's copy of ${status?.label}? ${status?.label} models stop working until it is downloaded again or found on your system.`)) return;
    try {
      setStatus(await desktop.admin.removeProgram(props.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove it");
    }
  }

  const label = status?.label ?? (props.id === "codex" ? "Codex" : "Claude Code");
  const megabytes = status?.downloadSize ? `${Math.round(status.downloadSize / 1048576)} MB` : "";
  if (status === null) {
    return (
      <SettingsRow>
        <RowText>
          <RowLabel>Program</RowLabel>
          <RowDescription>{error || "Checking…"}</RowDescription>
        </RowText>
      </SettingsRow>
    );
  }
  if (!status.installed) {
    const progress = status.install;
    const percent = progress && progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
    return (
      <>
        <SettingsRow>
          <RowText>
            <RowLabel>{label} is not installed</RowLabel>
            <RowDescription>
              {busy
                ? progress!.state === "downloading"
                  ? `Downloading… ${Math.round(progress!.received / 1048576)} of ${Math.round(progress!.total / 1048576)} MB`
                  : progress!.state === "verifying" ? "Checking the download against its pinned checksum…" : "Unpacking…"
                : `Saturn downloads the official ${label} program${status.downloadVersion ? ` (${status.downloadVersion})` : ""} from the npm registry and checks it against a checksum pinned in Saturn, or uses one you have installed yourself.`}
            </RowDescription>
            {busy ? (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-[inherit] bg-primary transition-[width] duration-400" style={{ width: `${progress!.state === "downloading" ? percent : 100}%` }} />
              </div>
            ) : null}
          </RowText>
          <RowActions>
            <Status ok={false} label="Not installed" />
            <Button type="button" variant="default" size="small" disabled={Boolean(busy) || !status.downloadVersion} onClick={() => void install()}>
              {busy ? "Downloading…" : progress?.state === "failed" ? "Try Again" : megabytes ? `Download (${megabytes})` : "Download"}
            </Button>
          </RowActions>
        </SettingsRow>
        {error || progress?.state === "failed" ? <RowError>{error || progress?.error}</RowError> : null}
      </>
    );
  }
  const where =
    status.source === "saturn" ? `Saturn's copy${status.version ? ` · ${status.version}` : ""}`
    : status.source === "system" ? `Your installed ${label}${status.version ? ` · ${status.version}` : ""} · ${status.path}`
    : `Development copy${status.version ? ` · ${status.version}` : ""}`;
  return (
    <>
      <SettingsRow>
        <RowText>
          <RowLabel>Program</RowLabel>
          <RowDescription title={status.path ?? ""}>{where}</RowDescription>
        </RowText>
        <RowActions>
          <Status ok label="Installed" />
          {status.source === "saturn" ? (
            <Button type="button" variant="outline" size="small" onClick={() => void remove()}>Remove</Button>
          ) : null}
        </RowActions>
      </SettingsRow>
      {error ? <RowError>{error}</RowError> : null}
      {props.children}
    </>
  );
}

/**
 * Codex models run on the user's own ChatGPT login, made by the official `codex` program. The runtime starts
 * its `codex login` and relays what it prints: a one-time code to type at OpenAI (no localhost redirect), or
 * the sign-in page it opened in the browser. Saturn never handles the credential itself.
 */
export function CodexLogin() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "starting" | "signing_out" | null>("checking");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<CodexStatus>, failure: string) {
    setBusy(kind);
    setError("");
    try {
      setStatus(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void run("checking", () => desktop.admin.codexStatus(), "Could not reach the runtime");
  }, []);

  // While a sign-in waits, follow it until Codex reports signed in or the sign-in ends.
  const signIn = status && !status.loggedIn ? status.signIn : undefined;
  const waiting = signIn?.state === "starting" || signIn?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      void desktop.admin.codexStatus().then(setStatus, () => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [waiting]);

  async function signOut() {
    if (!await askToConfirm("Sign Saturn out of Codex? Codex models stop working until you sign in again. Your own Codex setup stays signed in.")) return;
    await run("signing_out", () => desktop.admin.codexLogout(), "Could not sign out");
  }

  async function openPage() {
    try {
      await desktop.admin.codexOpenPage();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open the page");
    }
  }

  async function copyCode() {
    if (!signIn?.code) return;
    try {
      await navigator.clipboard.writeText(signIn.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const method = status?.authMethod === "chatgpt" ? "ChatGPT plan" : status?.authMethod === "api-key" ? "API key" : "";
  return (
    <>
      <SettingsRow>
        <RowText>
          <RowLabel>Codex Sign-In</RowLabel>
          <RowDescription>
            {status === null
              ? busy ? "Checking…" : "Status unavailable."
              : status.loggedIn
                ? ["Signed in", method].filter(Boolean).join(" · ")
                : "Not signed in. You sign in to the official Codex program, which uses your ChatGPT plan; Saturn never sees your credentials."}
          </RowDescription>
        </RowText>
        <RowActions>
          {status ? <Status ok={status.loggedIn} label={status.loggedIn ? "Signed in" : "Signed out"} /> : null}
          {status?.loggedIn ? (
            <Button type="button" variant="default" size="small" disabled={busy !== null} onClick={() => void signOut()}>
              {busy === "signing_out" ? "Signing out…" : "Sign Out"}
            </Button>
          ) : waiting ? (
            <Button type="button" variant="outline" size="small" onClick={() => void run("checking", () => desktop.admin.codexCancelSignIn(), "Could not cancel")}>
              Cancel
            </Button>
          ) : (
            <Button type="button" variant="default" size="small" disabled={busy !== null || status === null} onClick={() => void run("starting", () => desktop.admin.codexSignIn("device"), "Could not start sign-in")}>
              {busy === "starting" ? "Starting…" : "Sign In to Codex"}
            </Button>
          )}
        </RowActions>
      </SettingsRow>
      {signIn && waiting ? (
        <SettingsRow stacked>
          {signIn.mode === "device" ? (
            <>
              <RowDescription>Codex shows this one-time code: open the OpenAI page, sign in, and enter it. It expires in 15 minutes; this card updates once you're done.</RowDescription>
              <div className={COMMAND_BOX}>
                <code className="min-w-0 flex-1 overflow-x-auto text-[15px] font-semibold tracking-widest whitespace-nowrap">{signIn.code ?? "Waiting for a code…"}</code>
                {signIn.code ? <Button type="button" variant="outline" size="small" onClick={() => void copyCode()}>{copied ? "Copied" : "Copy"}</Button> : null}
                {signIn.url ? (
                  <Button type="button" variant="default" size="small" onClick={() => void openPage()}>Open Page</Button>
                ) : null}
              </div>
              <RowDescription>
                Device codes must be allowed in your ChatGPT security settings. If they aren't,{" "}
                <LinkButton onClick={() => void run("starting", () => desktop.admin.codexSignIn("browser"), "Could not start sign-in")}>
                  sign in with the browser instead
                </LinkButton>.
              </RowDescription>
            </>
          ) : (
            <RowDescription>
              Finish signing in on the page that opened in your browser. Saturn keeps Codex listening for it until you're done.
              {signIn.url ? <> <LinkButton onClick={() => void openPage()}>Open it again</LinkButton>.</> : null}
            </RowDescription>
          )}
        </SettingsRow>
      ) : null}
      {error || status?.error || (signIn?.state === "failed" ? signIn.error : "") ? (
        <RowError>{error || status?.error || signIn?.error}</RowError>
      ) : null}
    </>
  );
}

/**
 * Claude Code models run on the user's own Claude login, made once with the official `claude` program in a
 * terminal. Saturn shows what that program reports, the command to run, and signing out through the same
 * program; it never handles the credential itself.
 */
export function ClaudeCodeLogin() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof desktop.admin.claudeCodeStatus>> | null>(null);
  const [busy, setBusy] = useState<"checking" | "signing_out" | null>("checking");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    setBusy("checking");
    setError("");
    try {
      setStatus(await desktop.admin.claudeCodeStatus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach the runtime");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void check();
  }, []);

  // While signed out, ask again every few seconds, so finishing the terminal sign-in shows up on its own.
  const signedOut = status !== null && !status.loggedIn && Boolean(status.loginCommand);
  useEffect(() => {
    if (!signedOut) return;
    const timer = window.setInterval(() => {
      void desktop.admin.claudeCodeStatus().then(setStatus, () => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [signedOut]);

  async function signOut() {
    if (!await askToConfirm("Sign Saturn out of Claude Code? Claude (via Claude Code) models stop working until you sign in again. Your other Claude apps stay signed in.")) return;
    setBusy("signing_out");
    setError("");
    try {
      setStatus(await desktop.admin.claudeCodeLogout());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign out");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!status?.loginCommand) return;
    try {
      await navigator.clipboard.writeText(status.loginCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const plan = status?.subscriptionType ? `${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)} plan` : "";
  return (
    <>
      <SettingsRow>
        <RowText>
          <RowLabel>Claude Account</RowLabel>
          <RowDescription>
            {status === null
              ? busy ? "Checking…" : "Status unavailable."
              : status.loggedIn
                ? [status.email ?? "Signed in", plan].filter(Boolean).join(" · ")
                : "Not signed in. Claude (via Claude Code) models run on your own Claude login; Saturn never sees your credentials."}
          </RowDescription>
        </RowText>
        <RowActions>
          {status ? <Status ok={status.loggedIn} label={status.loggedIn ? "Signed in" : "Signed out"} /> : null}
          {status?.loggedIn ? (
            <Button type="button" variant="default" size="small" disabled={busy !== null} onClick={() => void signOut()}>
              {busy === "signing_out" ? "Signing out…" : "Sign Out"}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="small" disabled={busy !== null} onClick={() => void check()}>
              {busy === "checking" ? "Checking…" : "Check Again"}
            </Button>
          )}
        </RowActions>
      </SettingsRow>
      {status && !status.loggedIn && status.loginCommand ? (
        <SettingsRow stacked>
          <RowDescription>
            To sign in, run this in Terminal and keep that window open until it says you're signed in. This card updates on its own.
            If the browser says it can't connect to localhost, that terminal sign-in had already ended: run the command again and use the new browser page.
          </RowDescription>
          <div className={COMMAND_BOX}>
            <code className="min-w-0 flex-1 overflow-x-auto text-[11.5px] whitespace-nowrap">{status.loginCommand}</code>
            <Button type="button" variant="outline" size="small" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </SettingsRow>
      ) : null}
      {error || status?.error ? <RowError>{error || status?.error}</RowError> : null}
    </>
  );
}
