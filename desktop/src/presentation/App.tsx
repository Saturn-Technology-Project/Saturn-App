import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import { Automations, ClockIcon } from "./Automations";
import { Customizations, PuzzleIcon } from "./Customizations";
import { Inspector } from "./Inspector";
import { RunSteps } from "./RunSteps";
import { FormattedOutput } from "./FormattedOutput";
import { AGENT_DRAG_TYPE, GroupChat, GroupsNav } from "./Groups";
import { RunChangesCard } from "./RunChanges";
import { Settings, type SettingsPage } from "./Settings";
import { AgentSettings } from "./AgentSettings";
import { GuardrailSelector } from "./GuardrailSelector";
import { ModelSelector } from "./ModelSelector";
import { AccessDialog, EditWorkspaceDialog, FolderIcon as WorkspaceFolderIcon, LockIcon, chooseFolder } from "./ProjectAccess";
import { ProjectsMenu, arrangeProjects, useProjectView } from "./ProjectsMenu";
import { Onboarding } from "./Onboarding";
import { RunImages } from "./RunImages";
import { ContextPicker } from "./ContextPicker";
import { SlashMenu } from "./SlashMenu";
import { PullRequestBar } from "./PullRequestBar";
import { activateOnKey } from "./keyboard";
import { BUILTIN_COMMANDS, hiddenContext, parseSlash, type SlashEntry } from "../domain/slash";
import { AgentsBoard } from "./AgentsBoard";
import { InteractivePlan } from "./InteractivePlan";
import {
  extractPlanSteps,
  countdown,
  isBusy,
  replaceRevised,
  upsertRun,
  visibleThread,
} from "../domain/conversation";
import type { Agent, ContextItem, Conversation, Group, Mcp, Model, PendingTask, Profile, Project, Rag, Run, RunMode, RunSummary, ContextUsage } from "../domain/model";
import { syncWindowControls } from "../infrastructure/window-controls";

const isElectron =
  typeof window !== "undefined" &&
  Boolean((window as unknown as { process?: { type?: string } }).process?.type || window.navigator.userAgent.includes("Electron"));
const isMac = typeof window !== "undefined" && navigator.userAgent.toLowerCase().includes("mac");
const isElectronMac = isElectron && isMac;
const isElectronWindows = isElectron && typeof window !== "undefined" && navigator.userAgent.includes("Windows");

const STARTER_PROMPTS: { title: string; badge: string; prompt: string }[] = [
  {
    title: "Explore Workspace",
    badge: "files",
    prompt: "List the files in the workspace and summarize what is inside.",
  },
  {
    title: "Draft Step-by-Step Plan",
    badge: "multi_step",
    prompt: "Create a structured multi_step plan for organizing notes in the workspace.",
  },
  {
    title: "Run Workspace Command",
    badge: "code",
    prompt: "Run a quick command in the workspace and report the output.",
  },
  {
    title: "Create & Patch File",
    badge: "files · patch",
    prompt: "Create a markdown summary file in the workspace and verify its contents.",
  },
];

const DEFAULT_NAV_WIDTH = 240;
const DEFAULT_INSPECTOR_WIDTH = 440;

function storedNavWidth(): number {
  if (typeof window === "undefined") return DEFAULT_NAV_WIDTH;
  const raw = localStorage.getItem("saturn-nav-width");
  const num = raw ? parseInt(raw, 10) : NaN;
  return !isNaN(num) && num >= 210 && num <= 600 ? num : DEFAULT_NAV_WIDTH;
}

function storedInspectorWidth(): number {
  if (typeof window === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  const raw = localStorage.getItem("saturn-inspector-width");
  const num = raw ? parseInt(raw, 10) : NaN;
  return !isNaN(num) && num >= 320 && num <= 1000 ? num : DEFAULT_INSPECTOR_WIDTH;
}

/** An agent's reply split at its "## Summary" heading (the working method asks for one after changes). */
function splitSummary(output: string): { body: string; summary: string } {
  const match = /\n#{2,3}\s*Summary\s*\n/i.exec(`\n${output}`);
  if (!match) return { body: output, summary: "" };
  const at = match.index;
  return { body: output.slice(0, Math.max(0, at - 1)).trimEnd(), summary: output.slice(at - 1 + match[0].length).trim() };
}

/** The user's own words: what they typed, without the attached-context block the chat sends along. */
function shownInput(input: string): string {
  const at = input.indexOf("\n\n<saturn_context");
  return at >= 0 ? input.slice(0, at) : input;
}

/** The "sources" a message's attached-context block names, for a small line under the bubble. */
function contextSources(input: string): string {
  const match = /<saturn_context sources="([^"]*)">/.exec(input);
  return match?.[1] ?? "";
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<PendingTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>([]);
  const [rag, setRag] = useState<Rag[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [agentThreads, setAgentThreads] = useState<Record<string, Conversation[]>>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [threads, setThreads] = useState<Record<string, Run[]>>({});
  const [task, setTask] = useState("");
  /** Images pasted or dropped into the composer, as data URLs (at most 4, 5 MB each; the runtime checks too). */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  /** Files, folders, git changes, pages… attached to the next message with "@" (project chats only). */
  const [pendingContext, setPendingContext] = useState<ContextItem[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  /** The rule files agents follow in the current chat's project (the "§ Rules" chip). */
  const [ruleSources, setRuleSources] = useState<{ path: string; chars: number }[]>([]);
  /** Whether the runtime's live event stream is up; polling then only backs it up, every 30 s. */
  const [liveConnected, setLiveConnected] = useState(false);
  useEffect(() => desktop.live.onStatus(setLiveConnected), []);
  /** The "/" menu: what it offers in this chat, and what follows the slash while it is open. */
  const [slashEntries, setSlashEntries] = useState<SlashEntry[]>(BUILTIN_COMMANDS);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const slashKeyRef = useRef<((event: React.KeyboardEvent) => boolean) | null>(null);
  /** How full the current chat's context is (the "Context · n%" chip). */
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [compacting, setCompacting] = useState(false);
  /** The pull-request form for the current chat's branch, while it is open. */
  const [prDraft, setPrDraft] = useState<{ threadId: string; title: string; body: string; busy: boolean; error: string } | null>(null);
  /** Files that conflicted when a chat's branch was merged, with the branch and base, until dealt with. */
  const [conflict, setConflict] = useState<{ threadId: string; branch: string; base: string; files: string[]; projectId: string } | null>(null);
  /** Opens Settings on one project's page (the rules chip). */
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  /** The Agents board and inbox: every run still going plus the latest finished, polled while the app is open. */
  const [boardRuns, setBoardRuns] = useState<RunSummary[]>([]);
  /** Runs that ended or started waiting since the user last looked at them. */
  const [unread, setUnread] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("saturn-unread") || "[]") as string[]));
  const [notifyEnabled] = useState(() => localStorage.getItem("saturn-notify") !== "off");
  const boardStatus = useRef<Map<string, string> | null>(null);
  /** What the next message may do; remembered across launches. */
  const [mode, setMode] = useState<RunMode>(() => (localStorage.getItem("saturn-mode") === "ask" || localStorage.getItem("saturn-mode") === "plan" ? (localStorage.getItem("saturn-mode") as RunMode) : "agent"));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [customizingAgent, setCustomizingAgent] = useState<Agent | null>(null);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  /** A folder waiting for the user's Allow: a new one from the picker, or an existing project without access. */
  const [accessRequest, setAccessRequest] = useState<{ path: string; name?: string; projectId?: string; onAllowed?: (project: Project) => void } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectView, patchProjectView, resetProjectView] = useProjectView();
  const [view, setView] = useState<"workspace" | "agents" | "settings" | "automations" | "customizations" | "project" | "group">("workspace");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("settings");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [navWidth, setNavWidth] = useState<number>(storedNavWidth);
  const [inspectorWidth, setInspectorWidth] = useState<number>(storedInspectorWidth);
  const [isResizingNav, setIsResizingNav] = useState(false);
  const [isResizingInspector, setIsResizingInspector] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(storedTheme);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navHistory, setNavHistory] = useState<
    Array<{ view: "workspace" | "agents" | "settings" | "automations" | "customizations" | "project" | "group"; agentId: string | null; settingsPage?: SettingsPage }>
  >([{ view: "workspace", agentId: null }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceName, setWorkspaceName] = useState("Saturn-App");
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    desktop.workspace
      .info()
      .then((info) => {
        if (info.cwd) {
          const folder = info.cwd.split(/[/\\]/).filter(Boolean).pop();
          if (folder && folder !== "workspace") {
            setWorkspaceName(folder);
          } else {
            setWorkspaceName("Saturn-App");
          }
        }
      })
      .catch(() => {
        setWorkspaceName("Saturn-App");
      });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        void handleCreateNewChat();
      } else if (e.key === "Escape") {
        if (settingsOpen) setSettingsOpen(false);
        if (searchOpen) setSearchOpen(false);
        if (menuOpen) setMenuOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen, menuOpen, settingsOpen]);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [searchOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("saturn-theme", theme);
  }, [theme]);

  async function syncProjects() {
    try {
      const list = await desktop.projects.list();
      setProjects(list);
      const active = await desktop.projects.getActive();
      if (active) {
        setActiveProjectId(active.id);
        setSelectedProject((prev) => (prev && prev.id === active.id ? active : prev ?? active));
        setWorkspaceName(active.name);
      }
    } catch {
      // Ignore if offline
    }
  }

  async function handleSelectProject(id: string) {
    try {
      const active = await desktop.projects.setActive(id);
      setActiveProjectId(active.id);
      setSelectedProject(active);
      setWorkspaceName(active.name);
      await syncProjects();
      await desktop.workspace.info();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to switch project");
    }
  }

  /** Chats in a project, newest first; they live with their agents but work in the project's folder. */
  function projectChats(projectId: string): Conversation[] {
    return Object.values(agentThreads)
      .flat()
      .filter((conv) => conv.projectId === projectId)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  /** "+" in Projects: pick a folder, ask for access, then open a new chat in it (like opening a folder in Cursor). */
  async function addProjectFolder() {
    try {
      const folder = await chooseFolder();
      if (!folder) return;
      setAccessRequest({ path: folder, onAllowed: (project) => void newProjectChat(project) });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open the folder picker");
    }
  }

  async function allowAccess(request: NonNullable<typeof accessRequest>) {
    const project = request.projectId
      ? await desktop.projects.setAccess(request.projectId, true)
      : await desktop.projects.create({ path: request.path, grant: true });
    await syncProjects();
    setOpenProjects((prev) => ({ ...prev, [project.id]: true }));
    request.onAllowed?.(project);
  }

  /** Runs `then` once the project's folder is accessible, asking the user first when it is not. */
  function withAccess(project: Project, then: (project: Project) => void) {
    if (project.access) then(project);
    else setAccessRequest({ path: project.path, name: project.name, projectId: project.id, onAllowed: then });
  }

  async function newProjectChat(project: Project) {
    const agentId = selected || agents[0]?.id;
    if (!agentId) {
      setNotice("Create an agent first, then start a chat in this project.");
      return;
    }
    try {
      const conv = await desktop.catalog.createThread(agentId, "New Chat", project.id);
      setAgentThreads((prev) => ({ ...prev, [agentId]: [conv, ...(prev[agentId] ?? []).filter((t) => t.id !== conv.id)] }));
      setThreads((prev) => ({ ...prev, [conv.id]: [] }));
      setOpenProjects((prev) => ({ ...prev, [project.id]: true }));
      openProjectChat(project, conv);
      window.setTimeout(() => composerInputRef.current?.focus(), 30);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start a chat");
    }
  }

  function openProjectChat(project: Project, conv: Conversation) {
    setSelected(conv.agentId);
    setSelectedThreadId(conv.id);
    setSelectedTask(null);
    setView("workspace");
    setTask("");
    setEditing(null);
    setDraft("");
    if (project.id !== activeProjectId) void handleSelectProject(project.id);
  }

  async function removeProject(project: Project) {
    const chats = projectChats(project.id).length;
    const what = chats ? ` and its ${chats} ${chats === 1 ? "chat" : "chats"}` : "";
    if (!window.confirm(`Remove “${project.name}”${what} from Saturn? The folder and its files stay on disk.`)) return;
    try {
      await handleDeleteProject(project.id);
      setAgentThreads((prev) =>
        Object.fromEntries(Object.entries(prev).map(([agentId, list]) => [agentId, list.filter((conv) => conv.projectId !== project.id)])),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove the project");
    }
  }

  async function handleUpdateProject(id: string, patch: Partial<Project>) {
    const updated = await desktop.projects.update(id, patch);
    setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
    if (selectedProject?.id === id) {
      setSelectedProject(updated);
    }
  }

  async function handleDeleteProject(id: string) {
    await desktop.projects.delete(id);
    await syncProjects();
  }

  async function handleOpenProjectEditor(id: string) {
    try {
      await desktop.projects.openInEditor(id);
      setIdeNotice("Opening in Saturn IDE…");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open Saturn IDE");
    }
  }

  async function handleOpenProjectTerminal(id: string) {
    try {
      await desktop.projects.openInTerminal(id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not open terminal");
    }
  }

  async function handleOpenProjectFolder(id: string) {
    try {
      await desktop.projects.openInFolder(id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not reveal folder");
    }
  }

  async function reload() {
    const next = await desktop.catalog.snapshot();
    setAgents(next.agents);
    setTasks(next.tasks);
    setModels(next.models);
    setMcp(next.mcp);
    setRag(next.rag);
    setProfile(next.profile);
    setSelected((current) => (next.agents.some((a) => a.id === current) ? current : next.agents[0]?.id ?? null));
    void syncProjects();
    void syncGroups();
  }

  async function syncGroups() {
    try {
      setGroups(await desktop.groups.list());
    } catch {
      // The runtime-offline notice already covers this.
    }
  }

  function openGroup(id: string) {
    setSelectedGroupId(id);
    setSelectedTask(null);
    setView("group");
    pushNav({ view: "group", agentId: selected });
  }

  async function createGroup(agentId?: string) {
    try {
      const group = await desktop.groups.create({ name: agentId ? `${agents.find((a) => a.id === agentId)?.name ?? "Agent"}'s group` : "New Group", agentIds: agentId ? [agentId] : [] });
      await syncGroups();
      openGroup(group.id);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not create the group");
    }
  }

  async function addAgentToGroup(groupId: string, agentId: string) {
    const group = groups.find((item) => item.id === groupId);
    if (!group || group.agentIds.includes(agentId)) return;
    try {
      await desktop.groups.update(groupId, { agentIds: [...group.agentIds, agentId] });
      await syncGroups();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not add the agent");
    }
  }

  useEffect(() => {
    let stop = false;
    async function sync() {
      try {
        await reload();
        if (!stop) {
          setNotice((current) => (current === "Runtime is not running" ? "" : current));
        }
      } catch {
        if (!stop) {
          setNotice("Runtime is not running");
        }
      }
    }
    void sync();
    const timer = window.setInterval(() => void sync(), liveConnected ? 30_000 : 2000);
    // Agents, models, projects and the like changed: reload them now.
    const unsubscribe = desktop.live.onChange((change) => {
      if (change.other) void sync();
    });
    return () => {
      stop = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [liveConnected]);

  useEffect(() => {
    if (agents.length === 0) return;
    let stop = false;
    /** The chat lists of `only` (those agents), or of every agent. */
    async function syncThreads(only?: Set<string>) {
      try {
        const entries = await Promise.all(
          agents.filter((a) => !only || only.has(a.id)).map(async (a) => {
            const list = await desktop.catalog.listThreads(a.id);
            return [a.id, list] as const;
          })
        );
        if (!stop) {
          setAgentThreads((current) => {
            const map: Record<string, Conversation[]> = only ? { ...current } : {};
            for (const [id, list] of entries) {
              map[id] = list;
            }
            return map;
          });
        }
      } catch {
        // ignore
      }
    }
    void syncThreads();
    const timer = window.setInterval(() => void syncThreads(), liveConnected ? 30_000 : 3000);
    // A chat was added, renamed or removed (everyone), or a run's status changed (that agent's chats only).
    const unsubscribe = desktop.live.onChange((change) => {
      if (change.other) {
        void syncThreads();
        return;
      }
      const touched = new Set(change.runs.filter((run) => !run.parentRunId).map((run) => run.agentId));
      if (touched.size) void syncThreads(touched);
    });
    return () => {
      stop = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [agents, liveConnected]);

  // Opening an agent shows its chats once; after that its folder stays as the user left it. (This used to run on
  // every 3-second thread refresh, so collapsing the selected agent was undone moments later.)
  useEffect(() => {
    if (!selected) return;
    setOpenFolders((prev) => (selected in prev ? prev : { ...prev, [selected]: true }));
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const convs = agentThreads[selected];
    if (convs && convs.length > 0 && (!selectedThreadId || !convs.some((c) => c.id === selectedThreadId))) {
      setSelectedThreadId(convs[0].id);
    }
  }, [selected, agentThreads]);

  useEffect(() => {
    if (!selected) return;
    const agentId = selected;
    const threadId = selectedThreadId;
    let stop = false;
    async function pull() {
      try {
        const list = await desktop.catalog.messages(agentId, threadId || undefined);
        const key = threadId || `agent_${agentId}`;
        if (!stop) setThreads((current) => ({ ...current, [key]: list }));
      } catch {
        // Keep current thread until the local runtime responds.
      }
    }
    void pull();
    const timer = window.setInterval(() => void pull(), liveConnected ? 30_000 : 2000);
    // A run of this chat (or of this agent, outside a chat) changed: pull the chat now.
    const unsubscribe = desktop.live.onChange((change) => {
      if (change.other || change.runs.some((run) => run.agentId === agentId && (!threadId || run.threadId === threadId))) void pull();
    });
    return () => {
      stop = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [selected, selectedThreadId, liveConnected]);

  const agent = agents.find((item) => item.id === selected) ?? null;
  const inspectorShown =
    inspectorOpen && Boolean(agent) && !["agents", "automations", "customizations", "project", "group"].includes(view);

  // The Windows window buttons sit over the top right: the Inspector's tab bar when it is open, else the stage's.
  useEffect(() => {
    syncWindowControls(inspectorShown ? "--panel" : "--stage");
  }, [theme, inspectorShown]);
  const currentThreadKey = selectedThreadId || (selected ? `agent_${selected}` : "");
  const thread = currentThreadKey ? threads[currentThreadKey] ?? [] : [];
  const { visible, editIndex } = visibleThread(thread, editing);
  const latest = thread.at(-1);
  const busy = isBusy(latest);
  // The agent started browsing in this turn: the Browser tab opens on its live page.
  const browsing = Boolean(latest?.actions?.some((action) => action.toolId.startsWith("browser_")));
  useEffect(() => {
    if (browsing) setInspectorOpen(true);
  }, [browsing, latest?.id]);

  function remember(run: Run, threadKey: string) {
    setThreads((current) => ({ ...current, [threadKey]: upsertRun(current[threadKey] ?? [], run) }));
  }

  async function createAgent() {
    try {
      const created = await desktop.catalog.createAgent({
        name: name.trim() || "New agent",
        modelConnectionId: models[0]?.id ?? null,
      });
      setSelected(created.id);
      setSelectedThreadId(null);
      setOpenFolders((prev) => ({ ...prev, [created.id]: true }));
      setName("");
      setCreating(false);
      setNotice("");
      setTask("");
      setView("workspace");
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not create the agent");
    }
  }

  function watch(runId: string, agentId: string, threadKey: string) {
    // The run's own stream while the runtime offers it: each change arrives as it happens. Polling otherwise.
    const streamed = new AbortController();
    let settledOnce = false;
    void desktop.live.watchRun(runId, (current) => {
      setThreads((existing) => {
        const list = existing[threadKey] ?? [];
        if (!list.some((item) => item.id === runId)) return existing;
        return { ...existing, [threadKey]: upsertRun(list, current) };
      });
      const settled = current.status === "completed" || current.status === "failed" || current.status === "cancelled";
      if ((settled || current.status === "waiting_approval" || current.status === "sleeping") && !settledOnce) {
        settledOnce = true;
        void desktop.catalog.listThreads(agentId).then((list) => setAgentThreads((prev) => ({ ...prev, [agentId]: list })));
      }
      if (settled) streamed.abort();
    }, streamed.signal).then(() => undefined, () => pollRun(runId, agentId, threadKey));
    // The stream ends by itself only with the run; the chat refresh covers anything later.
    window.setTimeout(() => streamed.abort(), 60 * 60 * 1000);
  }

  function pollRun(runId: string, agentId: string, threadKey: string) {
    const timer = window.setInterval(() => {
      void desktop.runs.get(runId)
        .then((current) => {
          setThreads((existing) => {
            const list = existing[threadKey] ?? [];
            if (!list.some((item) => item.id === runId)) return existing;
            return { ...existing, [threadKey]: upsertRun(list, current) };
          });
          if (
            current.status === "completed" ||
            current.status === "failed" ||
            current.status === "cancelled" ||
            current.status === "waiting_approval" ||
            // Up to an hour asleep: the 2 s thread refresh picks up the resume, so stop the fast poll.
            current.status === "sleeping"
          ) {
            window.clearInterval(timer);
            void desktop.catalog.listThreads(agentId).then((list) => {
              setAgentThreads((prev) => ({ ...prev, [agentId]: list }));
            });
          }
        })
        .catch((error: unknown) => {
          window.clearInterval(timer);
          if (!(error instanceof Error) || error.message !== "Run not found") return;
          setThreads((existing) => {
            const list = existing[threadKey] ?? [];
            if (!list.some((item) => item.id === runId)) return existing;
            return { ...existing, [threadKey]: list.filter((item) => item.id !== runId) };
          });
        });
    }, 350);
  }

  function handleThreadScroll() {
    if (!threadRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = threadRef.current;
    isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 120;
  }

  function scrollToBottom(smooth = false) {
    if (threadRef.current) {
      if (smooth) {
        threadRef.current.scrollTo({
          top: threadRef.current.scrollHeight,
          behavior: "smooth",
        });
      } else {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    } else if (threadEndRef.current) {
      threadEndRef.current.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
    }
  }

  // 1. Auto scroll to bottom when switching conversation / agent / view
  useEffect(() => {
    isNearBottomRef.current = true;
    scrollToBottom(false);
    const timer = window.setTimeout(() => scrollToBottom(false), 60);
    return () => window.clearTimeout(timer);
  }, [selected, selectedThreadId, view]);

  // 2. Track message list container height changes (streaming tokens, markdown, code blocks, plan steps)
  useEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        scrollToBottom(false);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [currentThreadKey]);

  // 3. Auto scroll to bottom on message updates or streaming output
  useEffect(() => {
    if (isNearBottomRef.current) {
      const raf = requestAnimationFrame(() => {
        scrollToBottom(false);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [thread.length, latest?.output, latest?.actions?.length, latest?.status, busy]);

  /** Opens one chat from the board, the bell or a notification. */
  async function openThread(agentId: string, threadId: string) {
    const list = await desktop.catalog.listThreads(agentId).catch(() => [] as Conversation[]);
    setAgentThreads((prev) => ({ ...prev, [agentId]: list }));
    const conv = list.find((item) => item.id === threadId);
    const project = conv?.projectId ? projects.find((item) => item.id === conv.projectId) : undefined;
    if (conv && project) openProjectChat(project, conv);
    else selectAgent(agentId, threadId);
    setView("workspace");
    setUnread((prev) => {
      const next = new Set(prev);
      for (const run of boardRuns) if (run.threadId === threadId) next.delete(run.id);
      return next;
    });
  }

  /** Starts a task in a new chat (on its own branch in a project) and stays where the user is. */
  async function dispatchInBackground(agentId: string, text: string, projectId: string | null) {
    const title = `⧉ ${text.split("\n")[0].slice(0, 40)}`;
    const conv = await desktop.catalog.createThread(agentId, title, projectId ?? undefined);
    if (projectId) await desktop.catalog.isolateThread(conv.id).catch(() => undefined);
    setAgentThreads((prev) => ({ ...prev, [agentId]: [conv, ...(prev[agentId] ?? [])] }));
    const started = await desktop.runs.start(agentId, text, conv.id);
    boardStatus.current?.set(started.id, started.status);
    setNotice("");
  }

  useEffect(() => {
    localStorage.setItem("saturn-unread", JSON.stringify([...unread]));
  }, [unread]);

  // Looking at a chat clears its unread marks.
  useEffect(() => {
    if (view !== "workspace" || !selectedThreadId) return;
    setUnread((prev) => {
      if (![...prev].some((id) => boardRuns.some((run) => run.id === id && run.threadId === selectedThreadId))) return prev;
      const next = new Set(prev);
      for (const run of boardRuns) if (run.threadId === selectedThreadId) next.delete(run.id);
      return next;
    });
  }, [view, selectedThreadId, boardRuns]);

  // The board's list every few seconds; a change of state since the last look becomes an unread mark and, when the
  // window is not in front (or the chat is not the open one), a system notification.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      let list: RunSummary[];
      try {
        list = await desktop.runs.recent(30);
      } catch {
        return;
      }
      if (stopped) return;
      setBoardRuns(list);
      const previous = boardStatus.current;
      const next = new Map(list.map((run) => [run.id, run.status]));
      if (previous) {
        for (const run of list) {
          const before = previous.get(run.id);
          if (!before || before === run.status) continue;
          const settled = run.status === "completed" || run.status === "failed" || run.status === "waiting_approval";
          if (!settled) continue;
          const focused = window.saturnDesktop?.isFocused?.() ?? document.hasFocus();
          const lookingAtIt = focused && view === "workspace" && selectedThreadId === run.threadId;
          if (lookingAtIt) continue;
          setUnread((prev) => new Set(prev).add(run.id));
          if (notifyEnabled && window.saturnDesktop?.notify) {
            const title = run.threadTitle.replace(/^⧉ /, "");
            window.saturnDesktop.notify({
              title: run.status === "completed" ? `${run.agentName} finished: ${title}` : run.status === "failed" ? `${run.agentName} failed: ${title}` : `${run.agentName} needs your approval`,
              body: run.status === "waiting_approval" ? title : run.changedFiles ? `${run.changedFiles} file${run.changedFiles === 1 ? "" : "s"} changed${run.branch ? ` on ${run.branch}` : ""}` : run.input,
              agentId: run.agentId,
              threadId: run.threadId,
            });
          }
        }
      }
      boardStatus.current = next;
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [view, selectedThreadId, notifyEnabled]);

  useEffect(() => {
    return window.saturnDesktop?.onOpenThread?.((payload) => {
      if (payload.agentId && payload.threadId) void openThread(payload.agentId, payload.threadId);
    });
  }, [projects, boardRuns]);

  /** Adds image files from a paste or drop to the next message; anything unusable is explained, not dropped silently. */
  function attachImages(files: File[]) {
    const images = files.filter((file) => IMAGE_TYPES.has(file.type));
    if (!images.length) return;
    for (const file of images) {
      if (file.size > MAX_IMAGE_BYTES) {
        setNotice(`${file.name || "That image"} is larger than 5 MB.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") return;
        setPendingImages((current) => {
          if (current.length >= MAX_IMAGES) {
            setNotice(`Attach at most ${MAX_IMAGES} images to one message.`);
            return current;
          }
          return [...current, reader.result as string];
        });
      };
      reader.readAsDataURL(file);
    }
  }

  function chooseMode(next: RunMode) {
    setMode(next);
    localStorage.setItem("saturn-mode", next);
  }

  /** Sends the composer's text, or `text` when given (a plan sent back, diff comments). */
  /** "/compact" and the context chip: fold the chat's earlier turns into its summary now. */
  async function compactNow() {
    if (!selectedThreadId || compacting) return;
    setCompacting(true);
    try {
      const result = await desktop.catalog.compactThread(selectedThreadId);
      setNotice(`Compacted: ${result.folded} earlier ${result.folded === 1 ? "turn" : "turns"} folded into the chat's summary.`);
      setContextUsage(await desktop.catalog.threadContext(selectedThreadId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not compact");
    } finally {
      setCompacting(false);
    }
  }

  async function send(text?: string) {
    const typed = (text ?? task).trim();
    if (!agent || (!typed && !pendingImages.length) || busy || editing) return;
    setSlashQuery(null);
    // "/" commands: Saturn's own, then the chat's skills and prompt commands; anything else is sent as typed.
    const slash = parseSlash(typed);
    let turnMode = mode;
    let extra = "";
    if (slash) {
      const entry = slashEntries.find((item) => item.name.toLowerCase() === slash.name.toLowerCase());
      const projectId = currentConversation?.projectId;
      if (entry?.kind === "builtin" && slash.name === "compact") {
        setTask("");
        await compactNow();
        return;
      }
      if (entry?.kind === "builtin" && slash.name === "new") {
        const project = projects.find((item) => item.id === projectId);
        setTask("");
        if (project) withAccess(project, (granted) => void newProjectChat(granted));
        return;
      }
      if (entry?.kind === "builtin" && (slash.name === "plan" || slash.name === "ask")) {
        if (!slash.rest) {
          setNotice(`Type what to ${slash.name === "plan" ? "plan" : "ask"} after /${slash.name}.`);
          return;
        }
        turnMode = slash.name;
      }
      try {
        if (entry?.kind === "skill") {
          const skill = await desktop.catalog.skill(entry.name, projectId);
          extra = hiddenContext(`skill: ${skill.name}`, `The user invoked the skill "${skill.name}" for this message. Follow it.${skill.files.length ? ` Its folder also has: ${skill.files.join(", ")}.` : ""}

${skill.instructions}`);
        } else if (entry?.kind === "command") {
          const expanded = await desktop.catalog.expandCommand(entry.name, slash.rest, projectId);
          extra = hiddenContext(`command: ${expanded.name}`, expanded.prompt);
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not load that command");
        return;
      }
    }
    let input = (turnMode !== mode && slash ? slash.rest : typed) || `Look at the attached image${pendingImages.length === 1 ? "" : "s"}.`;
    input += extra;
    const images = pendingImages;
    isNearBottomRef.current = true;
    scrollToBottom(false);
    let started: Run;
    try {
      // The "@" attachments go with the message, in a block the chat hides, as the IDE's chat does.
      if (pendingContext.length && currentConversation?.projectId) {
        const attached = await desktop.projects.expandContext(currentConversation.projectId, pendingContext);
        if (attached.text) input = `${input}\n\n<saturn_context sources="${attached.sources.join("; ").replace(/"/g, "'")}">\n<attached_context>\n${attached.text}\n</attached_context>\n</saturn_context>`;
      }
      started = await desktop.runs.start(agent.id, input, selectedThreadId || undefined, { images, mode: turnMode });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Run failed");
      return;
    }
    setNotice("");
    setTask("");
    setPendingImages([]);
    setPendingContext([]);
    const effectiveKey = started.threadId || selectedThreadId || `agent_${agent.id}`;
    if (!selectedThreadId && started.threadId) {
      setSelectedThreadId(started.threadId);
    }
    remember(started, effectiveKey);
    watch(started.id, agent.id, effectiveKey);
    void desktop.catalog.listThreads(agent.id).then((list) => {
      setAgentThreads((prev) => ({ ...prev, [agent.id]: list }));
    });
    window.setTimeout(() => scrollToBottom(true), 30);
  }

  async function stopRun(run: Run) {
    try {
      const stopped = await desktop.runs.stop(run.id);
      const threadKey = currentThreadKey;
      if (!threadKey) return;
      setThreads((current) => ({
        ...current,
        [threadKey]: (current[threadKey] ?? []).map((item) => (item.id === stopped.id ? stopped : item)),
      }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not stop the agent");
    }
  }

  async function wakeRun(run: Run) {
    try {
      const woken = await desktop.runs.wake(run.id);
      const threadKey = currentThreadKey;
      if (!threadKey) return;
      setThreads((current) => ({
        ...current,
        [threadKey]: (current[threadKey] ?? []).map((item) => (item.id === woken.id ? woken : item)),
      }));
      if (agent) watch(woken.id, agent.id, threadKey);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not wake the agent");
    }
  }

  async function revise(run: Run) {
    if (!agent || !draft.trim()) return;
    const input = draft.trim();
    isNearBottomRef.current = true;
    scrollToBottom(false);
    let revised: { run: Run; removed: string[] };
    try {
      revised = await desktop.runs.revise(run.id, input);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not edit the message");
      return;
    }
    setNotice("");
    setEditing(null);
    setDraft("");
    const threadKey = currentThreadKey;
    if (threadKey) {
      setThreads((current) => ({ ...current, [threadKey]: replaceRevised(current[threadKey] ?? [], revised.run, revised.removed) }));
      watch(revised.run.id, agent.id, threadKey);
    }
    window.setTimeout(() => scrollToBottom(true), 30);
  }

  async function handleDeleteThread(threadId: string, agentId: string) {
    try {
      await desktop.catalog.deleteThread(threadId);
      setAgentThreads((prev) => ({
        ...prev,
        [agentId]: (prev[agentId] ?? []).filter((t) => t.id !== threadId),
      }));
      setThreads((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
      if (selectedThreadId === threadId) {
        const remaining = (agentThreads[agentId] ?? []).filter((t) => t.id !== threadId);
        if (remaining.length > 0) {
          setSelectedThreadId(remaining[0].id);
        } else {
          void handleCreateNewChat(agentId);
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete conversation");
    }
  }

  const currentConversation = selected && selectedThreadId ? (agentThreads[selected] ?? []).find((conv) => conv.id === selectedThreadId) ?? null : null;
  const [worktreeBusy, setWorktreeBusy] = useState(false);

  const currentProjectId = currentConversation?.projectId ?? null;
  useEffect(() => {
    if (!currentProjectId) {
      setRuleSources([]);
      setPendingContext([]);
      return;
    }
    let stale = false;
    desktop.projects.ruleSources(currentProjectId).then((list) => { if (!stale) setRuleSources(list); }, () => setRuleSources([]));
    return () => {
      stale = true;
    };
  }, [currentProjectId, thread.length]);

  // The "/" menu's skills and prompt commands follow the chat's project.
  useEffect(() => {
    let stale = false;
    const projectId = currentConversation?.projectId;
    void Promise.all([desktop.catalog.skills(projectId).catch(() => []), desktop.catalog.commands(projectId).catch(() => [])]).then(([skills, commands]) => {
      if (stale) return;
      const builtins = BUILTIN_COMMANDS.filter((item) => item.name !== "new" || projectId);
      const taken = new Set(builtins.map((item) => item.name));
      setSlashEntries([
        ...builtins,
        ...skills.filter((item) => !taken.has(item.name)).map((item) => ({ name: item.name, description: item.description, kind: "skill" as const })),
        ...commands.filter((item) => !taken.has(item.name) && !skills.some((skill) => skill.name === item.name)).map((item) => ({ name: item.name, description: item.description, kind: "command" as const })),
      ]);
    });
    return () => {
      stale = true;
    };
  }, [currentConversation?.projectId, selectedThreadId]);

  // The context chip follows the chat: refreshed when the chat changes and after each turn finishes.
  useEffect(() => {
    if (!selectedThreadId || busy) {
      if (!selectedThreadId) setContextUsage(null);
      return;
    }
    let stale = false;
    desktop.catalog.threadContext(selectedThreadId).then((usage) => { if (!stale) setContextUsage(usage); }, () => { if (!stale) setContextUsage(null); });
    return () => {
      stale = true;
    };
  }, [selectedThreadId, thread.length, busy]);

  /** Gives the chat its own git worktree and branch; the agent's changes then stay off the project checkout. */
  async function isolateThread(threadId: string) {
    setWorktreeBusy(true);
    try {
      const status = await desktop.catalog.isolateThread(threadId);
      setNotice(`This chat now works on ${status.branch} in its own worktree.`);
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not create the worktree");
    } finally {
      setWorktreeBusy(false);
    }
  }

  async function finishWorktree(threadId: string, how: "merge" | "keep" | "discard") {
    const conv = currentConversation;
    const question = how === "merge"
      ? `Merge this chat's branch into ${conv?.worktree?.base ?? "the project"}? Uncommitted work on the branch is committed first.`
      : how === "keep"
        ? "Keep this chat's branch (for a pull request) and close its worktree?"
        : "Discard this chat's branch and everything the agent changed on it?";
    if (!window.confirm(question)) return;
    setWorktreeBusy(true);
    try {
      const result = await desktop.catalog.finishWorktree(threadId, how);
      if (how === "merge" && result.conflicts?.length && conv?.worktree && conv.projectId) {
        setConflict({ threadId, branch: result.branch, base: conv.worktree.base, files: result.conflicts, projectId: conv.projectId });
        setNotice("");
      } else {
        setNotice(how === "merge" ? `Merged ${result.branch}.` : how === "keep" ? `Kept ${result.branch}; open a pull request from it.` : `Discarded ${result.branch}.`);
      }
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not finish the worktree");
    } finally {
      setWorktreeBusy(false);
    }
  }

  async function handleCreateNewChat(agentId?: string) {
    const targetAgentId = agentId || selected || agents[0]?.id;
    if (!targetAgentId) return;

    // If current conversation is already an empty "New Chat", just reuse and focus it
    const currentConv = (agentThreads[targetAgentId] ?? []).find((t) => t.id === selectedThreadId);
    const currentRuns = selectedThreadId ? threads[selectedThreadId] ?? [] : [];
    if (
      selected === targetAgentId &&
      currentConv &&
      (currentConv.title === "New Chat" || currentConv.title === "New Conversation" || currentConv.title === "Untitled Chat") &&
      currentRuns.length === 0
    ) {
      setSelected(targetAgentId);
      setSelectedThreadId(currentConv.id);
      setSelectedTask(null);
      setView("workspace");
      setTask("");
      setEditing(null);
      setDraft("");
      window.setTimeout(() => composerInputRef.current?.focus(), 30);
      return;
    }

    try {
      const newConv = await desktop.catalog.createThread(targetAgentId, "New Chat");
      setAgentThreads((prev) => ({
        ...prev,
        [targetAgentId]: [newConv, ...(prev[targetAgentId] ?? []).filter((t) => t.id !== newConv.id)],
      }));
      setThreads((prev) => ({ ...prev, [newConv.id]: [] }));
      setOpenFolders((prev) => ({ ...prev, [targetAgentId]: true }));
      setSelected(targetAgentId);
      setSelectedThreadId(newConv.id);
      setSelectedTask(null);
      setView("workspace");
      setTask("");
      setEditing(null);
      setDraft("");
      window.setTimeout(() => composerInputRef.current?.focus(), 30);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create new chat");
    }
  }

  async function removeAgent(id: string) {
    try {
      await desktop.catalog.deleteAgent(id);
      setAgentThreads((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setThreads((current) => {
        const next = { ...current };
        delete next[id];
        delete next[`agent_${id}`];
        return next;
      });
      setSelected(null);
      setSelectedThreadId(null);
      setNotice("");
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not delete the agent");
    }
  }

  async function patchAgent(patch: Partial<Agent>) {
    if (!agent) return;
    await desktop.catalog.updateAgent(agent.id, patch);
    await reload();
  }

  // Effort belongs to the model connection, so it changes for every agent on that model.
  async function changeEffort(modelId: string, effort: string | null) {
    try {
      await desktop.admin.updateModelEffort(modelId, effort);
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not change the effort");
    }
  }

  function pushNav(next: {
    view: "workspace" | "agents" | "settings" | "automations" | "customizations" | "project" | "group";
    agentId: string | null;
    settingsPage?: SettingsPage;
  }) {
    setNavHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      const last = trimmed[trimmed.length - 1];
      if (
        last &&
        last.view === next.view &&
        last.agentId === next.agentId &&
        last.settingsPage === next.settingsPage
      ) {
        return prev;
      }
      return [...trimmed, next];
    });
    setHistoryIndex((prev) => prev + 1);
  }

  function navigateBack() {
    if (historyIndex > 0) {
      const targetIndex = historyIndex - 1;
      setHistoryIndex(targetIndex);
      const target = navHistory[targetIndex];
      if (target) {
        setView(target.view);
        setSelected(target.agentId);
        if (target.settingsPage) setSettingsPage(target.settingsPage);
      }
    }
  }

  function navigateForward() {
    if (historyIndex < navHistory.length - 1) {
      const targetIndex = historyIndex + 1;
      setHistoryIndex(targetIndex);
      const target = navHistory[targetIndex];
      if (target) {
        setView(target.view);
        setSelected(target.agentId);
        if (target.settingsPage) setSettingsPage(target.settingsPage);
      }
    }
  }

  function selectAgent(id: string, threadId?: string | null) {
    setSelected(id);
    setOpenFolders((prev) => ({ ...prev, [id]: true }));
    if (threadId !== undefined) {
      setSelectedThreadId(threadId);
    } else {
      const convs = agentThreads[id];
      if (convs && convs.length > 0) {
        setSelectedThreadId(convs[0].id);
      } else {
        setSelectedThreadId(null);
      }
    }
    setView("workspace");
    setTask("");
    setEditing(null);
    setDraft("");
    pushNav({ view: "workspace", agentId: id });
  }

  function openSettingsPage(target: SettingsPage) {
    setSettingsPage(target);
    setSettingsOpen(true);
  }

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  const [ideNotice, setIdeNotice] = useState<string | null>(null);

  /** Opens the active project in Saturn IDE (falling back to Cursor or VS Code when it is not installed). */
  function handleOpenIde() {
    void desktop.workspace.openNativeEditor()
      .then((res) => setIdeNotice(res.editor ? `Opening in ${res.editor}…` : "Opening IDE…"))
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not open the IDE"));
  }

  useEffect(() => {
    if (!ideNotice) return;
    const timer = setTimeout(() => setIdeNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [ideNotice]);

  function handleToggleInspector() {
    setInspectorOpen((prev) => !prev);
  }

  useEffect(() => {
    localStorage.setItem("saturn-nav-width", String(navWidth));
  }, [navWidth]);

  useEffect(() => {
    localStorage.setItem("saturn-inspector-width", String(inspectorWidth));
  }, [inspectorWidth]);

  function handleNavResizeStart(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsResizingNav(true);
    document.body.classList.add("is-resizing");

    const startX = e.clientX;
    const startW = navWidth;

    function onPointerMove(ev: PointerEvent) {
      const delta = ev.clientX - startX;
      const winWidth = window.innerWidth;
      const rightW = inspectorOpen && agent ? inspectorWidth : 0;
      const minW = 210;
      const maxW = Math.max(minW, Math.min(500, Math.floor(winWidth * 0.45), winWidth - rightW - 360));
      const nextW = Math.max(minW, Math.min(maxW, Math.round(startW + delta)));
      setNavWidth(nextW);
    }

    function onPointerUp() {
      setIsResizingNav(false);
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function handleNavResizeReset() {
    setNavWidth(DEFAULT_NAV_WIDTH);
  }

  function handleInspectorResizeStart(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsResizingInspector(true);
    document.body.classList.add("is-resizing");

    const startX = e.clientX;
    const startW = inspectorWidth;

    function onPointerMove(ev: PointerEvent) {
      const delta = startX - ev.clientX;
      const winWidth = window.innerWidth;
      const leftW = sidebarOpen ? navWidth : 0;
      const minW = 320;
      const maxW = Math.max(minW, Math.min(850, Math.floor(winWidth * 0.65), winWidth - leftW - 360));
      const nextW = Math.max(minW, Math.min(maxW, Math.round(startW + delta)));
      setInspectorWidth(nextW);
    }

    function onPointerUp() {
      setIsResizingInspector(false);
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function handleInspectorResizeReset() {
    setInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
  }

  useEffect(() => {
    function handleWindowResize() {
      const winWidth = window.innerWidth;
      setNavWidth((prevNav) => {
        const rightW = inspectorOpen && agent ? inspectorWidth : 0;
        const minW = 210;
        const maxW = Math.max(minW, Math.min(500, Math.floor(winWidth * 0.45), winWidth - rightW - 360));
        return Math.max(minW, Math.min(maxW, prevNav));
      });
      setInspectorWidth((prevInsp) => {
        const leftW = sidebarOpen ? navWidth : 0;
        const minW = 320;
        const maxW = Math.max(minW, Math.min(850, Math.floor(winWidth * 0.65), winWidth - leftW - 360));
        return Math.max(minW, Math.min(maxW, prevInsp));
      });
    }

    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [inspectorOpen, agent, sidebarOpen, navWidth, inspectorWidth]);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  const breadcrumbRoot = (() => {
    if (view === "settings") return "Settings";
    if (view === "agents") return "Agents";
    if (view === "automations") return "Automations";
    if (view === "customizations") return "Customizations";
    if (view === "project") return selectedProject?.name || "Project";
    if (view === "group") return "Groups";
    if (activeProject) return activeProject.name;
    if (agent) return agent.name;
    return workspaceName;
  })();

  const breadcrumbSub = (() => {
    if (view === "settings") {
      return settingsPage === "mcp"
        ? "Configure MCP Servers"
        : settingsPage === "llm"
          ? "Models & Providers"
          : "General";
    }
    if (view === "automations" || view === "customizations") {
      return null;
    }
    if (view === "group") return groups.find((item) => item.id === selectedGroupId)?.name ?? null;
    if (view === "project") {
      return selectedProject?.gitBranch ? `branch: ${selectedProject.gitBranch}` : selectedProject?.path ?? null;
    }
    if (agent) {
      if (selectedThreadId) {
        const currentConv = (agentThreads[agent.id] ?? []).find((t) => t.id === selectedThreadId);
        if (currentConv?.title) {
          return currentConv.title.length > 55 ? `${currentConv.title.slice(0, 52)}...` : currentConv.title;
        }
      }
      const activeTaskPrompt = latest?.input;
      if (activeTaskPrompt && activeTaskPrompt.trim()) {
        const firstLine = activeTaskPrompt.trim().split("\n")[0] || "";
        return firstLine.length > 55 ? `${firstLine.slice(0, 52)}...` : firstLine;
      }
      return null;
    }
    return null;
  })();

  const paletteItems = [
    {
      group: "Projects",
      id: "act-add-project",
      label: "Open Folder…",
      action: () => void addProjectFolder(),
    },
    ...projects.map((p) => ({
      group: "Projects",
      id: `proj-${p.id}`,
      label: `Switch to Project: ${p.name}`,
      action: () => void handleSelectProject(p.id),
    })),
    ...agents.map((a) => ({
      group: "Agents",
      id: `agent-${a.id}`,
      label: a.name,
      action: () => selectAgent(a.id),
    })),
    {
      group: "Navigation",
      id: "nav-new-agent",
      label: "New Agent",
      action: () => {
        setCreating(true);
        setName("");
        setView("workspace");
      },
    },
    {
      group: "Navigation",
      id: "nav-automations",
      label: "Open Automations",
      action: () => {
        setView("automations");
        pushNav({ view: "automations", agentId: selected });
      },
    },
    {
      group: "Navigation",
      id: "nav-customizations",
      label: "Open Customizations",
      action: () => {
        setView("customizations");
        pushNav({ view: "customizations", agentId: selected });
      },
    },
    {
      group: "Navigation",
      id: "nav-mcp",
      label: "Configure MCP Servers",
      action: () => openSettingsPage("mcp"),
    },
    {
      group: "Navigation",
      id: "nav-settings",
      label: "Open Settings",
      action: () => openSettingsPage("settings"),
    },
    {
      group: "Actions",
      id: "act-new-chat",
      label: "New Chat",
      action: () => void handleCreateNewChat(),
    },
    {
      group: "Actions",
      id: "act-open-ide",
      label: "Open Workspace in Saturn IDE",
      action: () => handleOpenIde(),
    },
    {
      group: "Actions",
      id: "act-toggle-sidebar",
      label: sidebarOpen ? "Hide Left Sidebar" : "Show Left Sidebar",
      action: () => setSidebarOpen((v) => !v),
    },
    {
      group: "Actions",
      id: "act-toggle-inspector",
      label: inspectorOpen ? "Hide Inspector" : "Show Inspector",
      action: () => setInspectorOpen((v) => !v),
    },
    {
      group: "Actions",
      id: "act-theme",
      label: `Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`,
      action: toggleTheme,
    },
  ];

  const filteredPaletteItems = paletteItems.filter((item) =>
    item.label.toLowerCase().includes(searchQuery.toLowerCase().trim()),
  );

  // The first launch: the onboarding takes the whole window until it is finished or skipped.
  if (profile && !profile.onboardedAt) {
    return (
      <Onboarding
        models={models}
        agents={agents}
        projects={projects}
        theme={theme}
        onSetTheme={setTheme}
        onChanged={reload}
        onCreateAgent={async (input) => {
          const created = await desktop.catalog.createAgent({ name: input.name, modelConnectionId: input.modelConnectionId });
          if (input.autonomy !== "default") await desktop.catalog.updateAgent(created.id, { autonomy: input.autonomy });
          setSelected(created.id);
          return created;
        }}
        onAddProject={async (path) => {
          const project = await desktop.projects.create({ path, grant: true });
          await syncProjects();
          setOpenProjects((prev) => ({ ...prev, [project.id]: true }));
          return project;
        }}
        onOpenIde={async (project) => {
          await desktop.projects.openInEditor(project.id);
        }}
        onFinish={async (first) => {
          const next = await desktop.admin.updateSettings({ onboardedAt: new Date().toISOString() });
          setProfile(next);
          if (!first) return;
          const target = agents.find((item) => item.id === first.agentId);
          if (!target) return;
          setSelected(target.id);
          let threadId: string | undefined;
          if (first.projectId) {
            const conv = await desktop.catalog.createThread(target.id, "New Chat", first.projectId);
            threadId = conv.id;
            setAgentThreads((prev) => ({ ...prev, [target.id]: [conv, ...(prev[target.id] ?? [])] }));
            setSelectedThreadId(conv.id);
          }
          const started = await desktop.runs.start(target.id, first.text, threadId);
          const key = started.threadId || threadId || `agent_${target.id}`;
          if (!threadId && started.threadId) setSelectedThreadId(started.threadId);
          remember(started, key);
          watch(started.id, target.id, key);
        }}
      />
    );
  }

  const layoutClass = [
    "app",
    !sidebarOpen ? "no-sidebar" : "",
    inspectorShown ? "with-inspector" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const renderNavControls = () => (
    <>
      {/* macOS draws its own traffic lights here, and Windows its own buttons at the top right. */}
      <div className={isElectronWindows ? "titlebar-traffic-space compact" : "titlebar-traffic-space"}>
        {!isElectronMac && !isElectronWindows && (
          <div className="traffic-lights-preview">
            <span className="traffic-dot close" />
            <span className="traffic-dot minimize" />
            <span className="traffic-dot zoom" />
          </div>
        )}
      </div>

      <button
        type="button"
        className={sidebarOpen ? "titlebar-btn active" : "titlebar-btn"}
        onClick={() => setSidebarOpen((v) => !v)}
        title={sidebarOpen ? "Collapse Left Sidebar" : "Expand Left Sidebar"}
        aria-label="Toggle Left Sidebar"
      >
        <LeftSidebarIcon />
      </button>

      <div className="titlebar-nav-group">
        <button
          type="button"
          className="titlebar-btn"
          disabled={historyIndex <= 0}
          onClick={navigateBack}
          title="Go Back"
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          disabled={historyIndex >= navHistory.length - 1}
          onClick={navigateForward}
          title="Go Forward"
          aria-label="Forward"
        >
          <ArrowRightIcon />
        </button>
      </div>

      <button
        type="button"
        className="titlebar-btn"
        onClick={() => {
          setSearchOpen(true);
          setSearchQuery("");
        }}
        title="Search or Jump to... (Cmd+K)"
        aria-label="Search"
      >
        <SearchIcon />
      </button>
    </>
  );

  return (
    <div className="window-shell">
      <div
        className={layoutClass}
        style={{
          "--nav-width": `${navWidth}px`,
          "--inspector-width": `${inspectorWidth}px`,
        } as React.CSSProperties}
      >
        {sidebarOpen ? (
          <aside className="nav">
            <div
              className={isResizingNav ? "resizer-handle resizer-handle-nav active" : "resizer-handle resizer-handle-nav"}
              onPointerDown={handleNavResizeStart}
              onDoubleClick={handleNavResizeReset}
              title="Drag to resize sidebar (Double-click to reset)"
            />
            <div className="nav-top">
              {renderNavControls()}
            </div>

            <div className="nav-body">
              <nav className="side-menu">
              <button
                type="button"
                className="side-new"
                onClick={() => { setCreating(true); setName(""); }}
              >
                <PlusIcon />
                <span>New Agent</span>
              </button>
              <button
                type="button"
                className={view === "agents" ? "side-link active" : "side-link"}
                onClick={() => {
                  setView("agents");
                  pushNav({ view: "agents", agentId: selected });
                }}
              >
                <EmployeeIcon />
                <span>Agents</span>
                {boardRuns.some((run) => run.status === "running" || run.status === "queued") ? <span className="count-pill">{boardRuns.filter((run) => run.status === "running" || run.status === "queued").length}</span> : null}
                {unread.size ? <span className="count-pill warn">{unread.size}</span> : null}
              </button>
              <button
                type="button"
                className={view === "automations" ? "side-link active" : "side-link"}
                onClick={() => {
                  setView("automations");
                  pushNav({ view: "automations", agentId: selected });
                }}
              >
                <ClockIcon />
                <span>Automations</span>
              </button>
              <button
                type="button"
                className={view === "customizations" ? "side-link active" : "side-link"}
                onClick={() => {
                  setView("customizations");
                  pushNav({ view: "customizations", agentId: selected });
                }}
              >
                <PuzzleIcon />
                <span>Customizations</span>
              </button>
            </nav>

        <div className="nav-scroll">
          {tasks.length > 0 ? (
            <section className="nav-group">
              <div className="nav-group-head">
                <h2>Inbox</h2>
                <span className="count-pill warn">{tasks.length}</span>
              </div>
              {tasks.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selectedTask && view === "workspace" ? "agent-item active" : "agent-item"}
                  onClick={() => {
                    setSelected(item.agentId);
                    setSelectedTask(item.id);
                    setView("workspace");
                    setTask("");
                    setEditing(null);
                    setDraft("");
                  }}
                >
                  <div className="agent-item-top">
                    <span className="dot wait" />
                    <strong>{item.input}</strong>
                  </div>
                  <small>{item.toolId ? `${item.agentName} · ${item.toolId}` : item.agentName}</small>
                </button>
              ))}
            </section>
          ) : null}

          <section className="nav-group">
            <div className="nav-group-head">
              <div className="nav-group-head-left">
                <h2>Projects</h2>
                <span className="count-pill">{projects.length}</span>
              </div>
              <div className="nav-group-head-actions">
                <ProjectsMenu view={projectView} total={projects.length} onChange={patchProjectView} onReset={resetProjectView} />
                <button
                  type="button"
                  className="agent-folder-action-btn"
                  title="Open Folder…"
                  aria-label="Open folder as project"
                  onClick={() => void addProjectFolder()}
                >
                  <PlusIcon />
                </button>
              </div>
            </div>
            <div className="projects-list">
              {(() => {
                const arranged = arrangeProjects(projects, projectView, activeProjectId);
                return (
                  <>
                    {projects.length === 0 ? (
                      <button type="button" className="agent-thread-new" onClick={() => void addProjectFolder()}>
                        <PlusIcon />
                        <span>Open a folder</span>
                      </button>
                    ) : null}
                    {arranged.groups.map((group) => (
                      <div className="project-group" key={group.key || "all"}>
                        {group.label ? <div className="project-group-label" title={group.label}>{group.label}</div> : null}
                        {group.projects.map((proj) => {
                          const isOpen = openProjects[proj.id] ?? proj.id === activeProjectId;
                          const chats = projectChats(proj.id);
                          const projectBusy = chats.some((conv) => isBusy((threads[conv.id] ?? []).at(-1)));
                          const openMenu = (x: number, y: number) => setProjectMenu({ project: proj, x, y });
                          const toggle = () => setOpenProjects((prev) => ({ ...prev, [proj.id]: !isOpen }));
                          return (
                            <div className="agent-folder" key={proj.id}>
                              <div
                                className={proj.id === activeProjectId ? "agent-folder-header project-header active" : "agent-folder-header project-header"}
                                role="button"
                                tabIndex={0}
                                aria-expanded={isOpen}
                                onClick={toggle}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggle();
                                  }
                                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                                    event.preventDefault();
                                    const box = event.currentTarget.getBoundingClientRect();
                                    openMenu(box.left + 24, box.bottom);
                                  }
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  openMenu(event.clientX, event.clientY);
                                }}
                                title={`${proj.name}\n${proj.path}${proj.gitBranch ? `\nBranch: ${proj.gitBranch}` : ""}${proj.access ? "" : "\nAccess not granted yet"}`}
                              >
                                <span className={isOpen ? "agent-folder-chevron open" : "agent-folder-chevron"}>
                                  <ChevronRightIcon />
                                </span>
                                <span className="agent-folder-icon">
                                  <WorkspaceFolderIcon />
                                </span>
                                <span className="project-header-text">
                                  <span className="agent-folder-title">{proj.name}</span>
                                  {projectView.showPath ? <span className="project-path">{proj.path.replace(/^\/Users\/[^/]+/, "~")}</span> : null}
                                </span>
                                {!proj.access ? (
                                  <span className="project-lock" title="Access not granted yet" aria-label="Access not granted yet">
                                    <LockIcon />
                                  </span>
                                ) : null}
                                {projectBusy ? <span className="dot wait pulse" /> : null}
                                <div className="agent-folder-actions" onClick={(e) => e.stopPropagation()}>
                                  <button
                                    type="button"
                                    className="agent-folder-action-btn"
                                    title="New chat in this project"
                                    aria-label={`New chat in ${proj.name}`}
                                    onClick={() => withAccess(proj, (granted) => void newProjectChat(granted))}
                                  >
                                    <PlusIcon />
                                  </button>
                                  <button
                                    type="button"
                                    className="agent-folder-action-btn"
                                    title="More"
                                    aria-label={`More actions for ${proj.name}`}
                                    aria-haspopup="menu"
                                    onClick={(event) => {
                                      const box = event.currentTarget.getBoundingClientRect();
                                      openMenu(box.right, box.bottom + 4);
                                    }}
                                  >
                                    <MoreIcon />
                                  </button>
                                </div>
                              </div>
                              {isOpen ? (
                                <div className="agent-folder-children">
                                  {chats.map((conv) => {
                                    const active = view === "workspace" && selectedThreadId === conv.id;
                                    const convBusy = isBusy((threads[conv.id] ?? []).at(-1));
                                    const agentName = agents.find((item) => item.id === conv.agentId)?.name;
                                    return (
                                      <div
                                        key={conv.id}
                                        className={active ? "agent-thread-item active" : "agent-thread-item"}
                                        role="button"
                                        tabIndex={0}
                                        aria-current={active ? "page" : undefined}
                                        onKeyDown={activateOnKey}
                                        onClick={() => openProjectChat(proj, conv)}
                                        title={agentName ? `${conv.title} · ${agentName}` : conv.title}
                                      >
                                        <span className="agent-thread-icon">
                                          {convBusy ? <span className="dot wait pulse" /> : <ChatBubbleIcon />}
                                        </span>
                                        <span className="agent-thread-title">{conv.title || "Untitled Chat"}</span>
                                        <button
                                          type="button"
                                          className="agent-thread-delete"
                                          title="Delete conversation"
                                          aria-label="Delete Conversation"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void handleDeleteThread(conv.id, conv.agentId);
                                          }}
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    );
                                  })}
                                  <button type="button" className="agent-thread-new" onClick={() => withAccess(proj, (granted) => void newProjectChat(granted))}>
                                    <PlusIcon />
                                    <span>New chat</span>
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    {arranged.hidden > 0 ? (
                      <button type="button" className="project-view-all" onClick={() => patchProjectView({ showAll: true })}>
                        View all ({projects.length})
                      </button>
                    ) : null}
                  </>
                );
              })()}
            </div>
          </section>

          <section className="nav-group">
            <div className="nav-group-head">
              <h2>Agents</h2>
              <span className="count-pill">{agents.length}</span>
            </div>
            <div className="agents">
              {agents.map((item) => {
                const isOpen = openFolders[item.id] ?? false;
                // Project chats are listed under their project.
                const convs = (agentThreads[item.id] ?? []).filter((conv) => !conv.projectId);
                const itemBusy = convs.some((c) => isBusy((threads[c.id] ?? []).at(-1)));
                const isAgentSelected = item.id === selected && selectedTask === null && view === "workspace";

                return (
                  <div key={item.id} className="agent-folder">
                    <div
                      className={isAgentSelected ? "agent-folder-header active" : "agent-folder-header"}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onKeyDown={activateOnKey}
                      draggable
                      title="Drag onto a group to add this agent"
                      onDragStart={(event) => {
                        event.dataTransfer.setData(AGENT_DRAG_TYPE, item.id);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => {
                        // Toggle folder without jumping to Chat
                        setOpenFolders((prev) => ({ ...prev, [item.id]: !isOpen }));
                      }}
                    >
                      <span
                        className={isOpen ? "agent-folder-chevron open" : "agent-folder-chevron"}
                        aria-hidden="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenFolders((prev) => ({ ...prev, [item.id]: !isOpen }));
                        }}
                      >
                        <ChevronRightIcon />
                      </span>
                      <span className="agent-folder-icon">
                        <EmployeeIcon />
                      </span>
                      <span className="agent-folder-title">
                        {item.name}
                      </span>
                      {itemBusy ? <span className="dot wait pulse" /> : null}

                      <div className="agent-folder-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="agent-folder-action-btn"
                          title="New conversation (⌘N)"
                          aria-label="New Conversation"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCreateNewChat(item.id);
                          }}
                        >
                          <PlusIcon />
                        </button>
                        <button
                          type="button"
                          className="agent-folder-action-btn"
                          title={`Customize ${item.name}`}
                          aria-label="Customize Agent"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCustomizingAgent(item);
                          }}
                        >
                          <GearIcon />
                        </button>
                      </div>
                    </div>

                    {isOpen ? (
                      <div className="agent-folder-children">
                        {convs.map((conv) => {
                          const isConvActive = isAgentSelected && selectedThreadId === conv.id;
                          const convRuns = threads[conv.id] ?? [];
                          const convBusy = isBusy(convRuns.at(-1));

                          return (
                            <div
                              key={conv.id}
                              className={isConvActive ? "agent-thread-item active" : "agent-thread-item"}
                              role="button"
                              tabIndex={0}
                              aria-current={isConvActive ? "page" : undefined}
                              onKeyDown={activateOnKey}
                              onClick={() => {
                                setSelected(item.id);
                                setSelectedThreadId(conv.id);
                                setSelectedTask(null);
                                setView("workspace");
                                setTask("");
                                setEditing(null);
                                setDraft("");
                              }}
                            >
                              <span className="agent-thread-icon">
                                {convBusy ? <span className="dot wait pulse" /> : <ChatBubbleIcon />}
                              </span>
                              <span className="agent-thread-title" title={conv.title}>
                                {conv.title || "Untitled Chat"}
                              </span>
                              <button
                                type="button"
                                className="agent-thread-delete"
                                title="Delete conversation"
                                aria-label="Delete Conversation"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDeleteThread(conv.id, item.id);
                                }}
                              >
                                ✕
                              </button>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          className="agent-thread-new"
                          onClick={() => {
                            void handleCreateNewChat(item.id);
                          }}
                        >
                          <PlusIcon />
                          <span>New chat</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <GroupsNav
            groups={groups}
            activeGroupId={view === "group" ? selectedGroupId : null}
            onOpen={openGroup}
            onCreate={(agentId) => void createGroup(agentId)}
            onAddAgent={(groupId, agentId) => void addAgentToGroup(groupId, agentId)}
          />
        </div>

        <div className="nav-foot">
          <button
            type="button"
            className={settingsOpen ? "side-link active" : "side-link"}
            onClick={() => {
              if (settingsOpen) {
                setSettingsOpen(false);
              } else {
                openSettingsPage("settings");
              }
            }}
          >
            <GearIcon />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </aside>
  ) : null}

      <main className="stage">
        <header className="stage-topbar">
          <div className="stage-topbar-left">
            {!sidebarOpen ? (
              <>
                {renderNavControls()}
                <div className="titlebar-separator" />
              </>
            ) : null}

            <div className="titlebar-breadcrumb">
              <span className="titlebar-workspace">{breadcrumbRoot}</span>
              {breadcrumbSub && (
                <>
                  <span className="titlebar-slash">/</span>
                  <span className="titlebar-task" title={breadcrumbSub}>
                    {breadcrumbSub}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="stage-topbar-right">
            <button
              type="button"
              className={unread.size ? "titlebar-btn bell active" : "titlebar-btn bell"}
              title={unread.size ? `${unread.size} agent${unread.size === 1 ? "" : "s"} finished or need you` : "Agents board"}
              aria-label="Agents board"
              onClick={() => {
                setView("agents");
                pushNav({ view: "agents", agentId: selected });
              }}
            >
              <BellIcon />
              {unread.size ? <span className="bell-count">{unread.size}</span> : null}
            </button>
            {currentConversation?.projectId ? (
              <button
                type="button"
                className="titlebar-pill-btn rules-chip"
                title={ruleSources.length ? `Agents follow: ${ruleSources.map((item) => item.path).join(", ")}. Click to edit.` : "No project rules yet. Click to add instructions every agent gets in this project."}
                onClick={() => {
                  setSettingsProjectId(currentConversation.projectId ?? null);
                  setSettingsOpen(true);
                }}
              >
                § Rules{ruleSources.length ? ` · ${ruleSources.length}` : ""}
              </button>
            ) : null}
            {currentConversation && contextUsage ? (
              <button
                type="button"
                className={`titlebar-pill-btn context-chip${contextUsage.percent >= 80 ? " high" : ""}`}
                disabled={compacting || busy}
                title={`About ${contextUsage.usedTokens.toLocaleString()} of the ${contextUsage.budgetTokens.toLocaleString()} tokens of earlier turns this model carries (window ${contextUsage.windowTokens.toLocaleString()}). ${contextUsage.summary ? `${contextUsage.summary.turns} earlier turns are in the summary. ` : ""}Click, or send /compact, to fold the earlier turns into a summary now.`}
                onClick={() => void compactNow()}
              >
                {compacting ? "Compacting…" : `Context · ${contextUsage.percent}%`}
              </button>
            ) : null}
            {currentConversation?.projectId ? (
              <WorktreeControl
                conversation={currentConversation}
                busy={worktreeBusy}
                onIsolate={() => void isolateThread(currentConversation.id)}
                onFinish={(how) => void finishWorktree(currentConversation.id, how)}
                onPullRequest={() => {
                  const last = thread.filter((run) => run.status === "completed" && run.output).at(-1);
                  setPrDraft({ threadId: currentConversation.id, title: currentConversation.title.replace(/^⧉\s*/, ""), body: last ? splitSummary(last.output).summary : "", busy: false, error: "" });
                }}
              />
            ) : null}
            <button
              type="button"
              className="titlebar-btn"
              title="New Chat (⌘N)"
              aria-label="New Chat"
              onClick={() => void handleCreateNewChat()}
            >
              <PlusIcon />
            </button>

            <div className="titlebar-menu-wrapper" ref={menuRef}>
              <button
                type="button"
                className={menuOpen ? "titlebar-btn active" : "titlebar-btn"}
                onClick={() => setMenuOpen((v) => !v)}
                title="More options"
                aria-label="More Options"
              >
                <DotsVerticalIcon />
              </button>

              {menuOpen && (
                <div className="titlebar-dropdown">
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      void handleCreateNewChat();
                    }}
                  >
                    <ChatBubbleIcon />
                    <span>New Chat (⌘N)</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setCreating(true);
                      setName("");
                    }}
                  >
                    <PlusIcon />
                    <span>New Agent</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setView("automations");
                      pushNav({ view: "automations", agentId: selected });
                    }}
                  >
                    <ClockIcon />
                    <span>Automations</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setView("customizations");
                      pushNav({ view: "customizations", agentId: selected });
                    }}
                  >
                    <PuzzleIcon />
                    <span>Customizations</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      openSettingsPage("mcp");
                    }}
                  >
                    <PlugIcon />
                    <span>Configure MCP Servers</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      openSettingsPage("settings");
                    }}
                  >
                    <GearIcon />
                    <span>Settings</span>
                  </button>

                  <div className="titlebar-dropdown-divider" />

                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setSidebarOpen((v) => !v);
                    }}
                  >
                    <LeftSidebarIcon />
                    <span>{sidebarOpen ? "Hide Left Sidebar" : "Show Left Sidebar"}</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      handleToggleInspector();
                    }}
                  >
                    <RightSidebarIcon />
                    <span>{inspectorOpen ? "Hide Inspector" : "Show Inspector"}</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      toggleTheme();
                    }}
                  >
                    <ThemeIcon theme={theme} />
                    <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
                  </button>

                  <div className="titlebar-dropdown-divider" />

                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      handleOpenIde();
                    }}
                  >
                    <span>Open IDE</span>
                  </button>
                  <button
                    type="button"
                    className="titlebar-dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      void reload();
                    }}
                  >
                    <span>Reload State</span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className="titlebar-open-ide"
              onClick={() => handleOpenIde()}
              title="Open this workspace in Saturn IDE"
            >
              <IdeWindowIcon />
              <span>Open IDE</span>
            </button>

            {!inspectorOpen ? (
              <button
                type="button"
                className="titlebar-btn"
                onClick={handleToggleInspector}
                title="Show Inspector"
                aria-label="Toggle Inspector"
              >
                <RightSidebarIcon />
              </button>
            ) : null}
          </div>
        </header>

        {view === "group" && selectedGroupId ? (
          <GroupChat
            groupId={selectedGroupId}
            agents={agents}
            onChanged={() => void syncGroups()}
            onDeleted={() => {
              setSelectedGroupId(null);
              setView("workspace");
              void syncGroups();
            }}
          />
        ) : view === "agents" ? (
          <AgentsBoard
            runs={boardRuns}
            agents={agents}
            projects={projects.map((item) => ({ id: item.id, name: item.name, access: Boolean(item.access) }))}
            projectNames={Object.fromEntries(projects.map((item) => [item.id, item.name]))}
            unread={unread}
            onOpen={(run) => void openThread(run.agentId, run.threadId)}
            onDispatch={dispatchInBackground}
          />
        ) : view === "automations" ? (
          <Automations
            agents={agents}
            models={models}
            onOpenAgent={(agentId) => {
              setSelected(agentId);
              setSelectedTask(null);
              setView("workspace");
            }}
          />
        ) : view === "customizations" ? (
          <Customizations
            agents={agents}
            mcp={mcp}
            onOpenMcp={() => openSettingsPage("mcp")}
            onOpenAgent={(agentId) => {
              setSelected(agentId);
              setSelectedTask(null);
              setView("workspace");
            }}
          />
        ) : (
          <>
            {currentConversation?.pullRequest ? (
              <PullRequestBar threadId={currentConversation.id} pr={currentConversation.pullRequest} busy={busy} onError={setNotice} />
            ) : null}
            <section className="thread" ref={threadRef} onScroll={handleThreadScroll}>
              <div ref={columnRef} className={thread.length ? "column" : "column empty"}>
                {thread.length === 0 ? (
                  <div className="mission-empty">
                    <div className="mission-hero">
                      <span className="mission-kicker">Saturn Local Agent</span>
                      <h2>{agent ? agent.name : "No Agent Selected"}</h2>
                      <p className="hint">
                        {agent?.description || (agents.length === 0 ? "No agents created yet. Create an agent to start working." : "Select an agent from the sidebar or create a new one.")}
                      </p>
                      {!agent ? (
                        <button className="btn primary-btn tiny" type="button" style={{ marginTop: 12 }} onClick={() => { setCreating(true); setName(""); }}>
                          + Create Agent
                        </button>
                      ) : null}
                    </div>

                    {agent && !agent.modelConnectionId ? (
                      <div className="callout-card">
                        <div>
                          <strong>No model connected to {agent.name}</strong>
                          <p className="hint">Connect OpenAI, Anthropic, Gemini, or a local LM Studio model to start running tasks.</p>
                        </div>
                        <button className="btn primary-btn tiny" type="button" onClick={() => openSettingsPage("llm")}>
                          Connect Model →
                        </button>
                      </div>
                    ) : null}

                    {agent ? (
                      <div className="starter-grid">
                        {STARTER_PROMPTS.map((item) => (
                          <button
                            key={item.title}
                            type="button"
                            className="starter-card"
                            onClick={() => {
                              setTask(item.prompt);
                              composerInputRef.current?.focus();
                            }}
                          >
                            <div className="starter-card-head">
                              <strong>{item.title}</strong>
                              <code>{item.badge}</code>
                            </div>
                            <p>{item.prompt}</p>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  visible.map((run) => {
                    const planSteps = extractPlanSteps(run.actions);
                    return (
                      <article className="turn" key={run.id}>
                        <div className="user">
                          {editing === run.id ? (
                            <form className="edit-bubble" onSubmit={(event) => { event.preventDefault(); void revise(run); }}>
                              <textarea
                                aria-label="Edit message"
                                rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                                value={draft}
                                autoFocus
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    setEditing(null);
                                  }
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    void revise(run);
                                  }
                                }}
                              />
                              <p className="hint">
                                {editIndex < thread.length - 1
                                  ? "Sending reruns from this turn and drops subsequent turns."
                                  : "Sending reruns this turn."}
                              </p>
                              <div className="edit-actions">
                                <button className="btn ghost tiny" type="button" onClick={() => setEditing(null)}>Cancel</button>
                                <button className="btn primary-btn tiny" type="submit" disabled={!draft.trim()}>Rerun</button>
                              </div>
                            </form>
                          ) : (
                            <div className="user-block">
                              {run.mode && run.mode !== "agent" ? <span className="user-mode">{run.mode === "ask" ? "Ask" : "Plan"}</span> : null}
                              {run.automatic ? <span className="user-mode">Sent by Saturn</span> : null}
                              <p>{shownInput(run.input)}</p>
                              {contextSources(run.input) ? <span className="user-context">Context · {contextSources(run.input)}</span> : null}
                              {run.inputImages?.length ? <RunImages runId={run.id} count={run.inputImages.length} /> : null}
                              {isBusy(run) ? null : (
                                <button
                                  className="edit"
                                  type="button"
                                  title="Edit and rerun from this turn"
                                  aria-label="Edit message"
                                  onClick={() => { setEditing(run.id); setDraft(run.input); }}
                                >
                                  <Pencil />
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="assistant-turn">
                          {planSteps.length > 0 && run.id === latest?.id ? (
                            <InteractivePlan
                              runId={run.id}
                              steps={planSteps}
                              busy={busy}
                              awaitingGo={/Reply 'go'/i.test(run.output)}
                              onSend={(text) => void send(text)}
                            />
                          ) : planSteps.length > 0 ? (
                            <div className="plan-card">
                              <div className="plan-card-head">
                                <span>Task Plan</span>
                                <small>
                                  {planSteps.filter((s) => s.status === "completed").length}/{planSteps.length} completed
                                </small>
                              </div>
                              <div className="plan-steps">
                                {planSteps.map((step, idx) => (
                                  <div className={`plan-step ${step.status}`} key={`${run.id}-plan-${idx}`}>
                                    <span className="plan-icon">
                                      {step.status === "completed" ? "✓" : step.status === "in_progress" ? "●" : "○"}
                                    </span>
                                    <span>{step.step}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <RunSteps run={run} busy={run.status === "running" || run.status === "queued"} />

                          <RunChangesCard run={run} onComment={(text) => void send(text)} />
                          {run.compacted ? (
                            <div className="verify-line" title="The oldest turns were summarized by the model before this turn, so the chat fits its context window.">
                              ⤵ {run.compacted.turns} earlier {run.compacted.turns === 1 ? "turn" : "turns"} folded into the chat's summary before this turn
                            </div>
                          ) : null}
                          {run.verification ? (
                            <div className={run.verification.ok ? "verify-line ok" : "verify-line failed"} title={run.verification.output.slice(0, 2000)}>
                              {run.verification.ok
                                ? `✓ ${run.verification.command} passed after these changes`
                                : `${run.verification.command} failed (exit ${run.verification.code ?? "?"})${run.automatic ? "" : " · Saturn asked the agent to fix it"}`}
                            </div>
                          ) : null}

                          {run.status === "sleeping" && run.wake ? (
                            <WaitingLine wake={run.wake} onWake={() => void wakeRun(run)} onStop={() => void stopRun(run)} />
                          ) : null}

                          {run.output ? (
                            <div className="assistant-body">
                              <FormattedOutput text={splitSummary(run.output).body} />
                              {splitSummary(run.output).summary ? (
                                <div className="summary-card">
                                  <div className="summary-card-head">
                                    <span>Summary</span>
                                    {run.checkpoint?.files.filter((file) => file.before !== file.after).length ? (
                                      <small>{run.checkpoint.files.filter((file) => file.before !== file.after).length} file{run.checkpoint.files.filter((file) => file.before !== file.after).length === 1 ? "" : "s"} changed</small>
                                    ) : null}
                                  </div>
                                  <FormattedOutput text={splitSummary(run.output).summary} />
                                </div>
                              ) : null}
                            </div>
                          ) : isBusy(run) ? null : (
                            <div className="assistant-body">
                              <div className={`run-state-line ${run.status}`}>
                                <span className={`dot ${run.status === "failed" ? "off" : ""}`} />
                                <span>{run.status === "cancelled" ? "Stopped" : run.error || run.status}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })
                )}
                <div ref={threadEndRef} className="thread-scroll-anchor" style={{ height: 1, minHeight: 1, pointerEvents: "none", visibility: "hidden" }} />
              </div>
            </section>

            <div className="dock">
              <form
                className="column composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy && latest) {
                    void stopRun(latest);
                    return;
                  }
                  void send();
                }}
              >
                {notice ? <p className="error composer-notice">{notice}</p> : null}
                {pendingContext.length ? (
                  <div className="composer-chips">
                    {pendingContext.map((item, index) => (
                      <span className="context-chip" key={`${item.kind}-${index}`} title={"path" in item ? item.path : "url" in item ? item.url : item.label}>
                        @{item.label}
                        <button type="button" title="Remove" aria-label={`Remove ${item.label}`} onClick={() => setPendingContext((current) => current.filter((_, at) => at !== index))}>✕</button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {pendingImages.length ? (
                  <div className="composer-images">
                    {pendingImages.map((url, index) => (
                      <span className="composer-image" key={`${index}-${url.length}`}>
                        <img src={url} alt={`Attached image ${index + 1}`} />
                        <button type="button" title="Remove image" aria-label="Remove image" onClick={() => setPendingImages((current) => current.filter((_, at) => at !== index))}>✕</button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <textarea
                  ref={composerInputRef}
                  rows={2}
                  value={task}
                  disabled={!agent || busy || editing !== null}
                  placeholder={agent ? `Ask ${agent.name} to inspect files, run commands, or execute tools… (paste a screenshot to include it)` : "Create or choose an agent to get started…"}
                  onChange={(event) => {
                    const value = event.target.value;
                    const caret = event.target.selectionStart ?? value.length;
                    // "@" at the start of a word opens the picker (the "@" itself is removed), in a project chat.
                    if (currentConversation?.projectId && value.charAt(caret - 1) === "@" && (caret === 1 || /\s/.test(value.charAt(caret - 2)))) {
                      setTask(value.slice(0, caret - 1) + value.slice(caret));
                      setContextOpen(true);
                      return;
                    }
                    // "/" at the start, until the first space, filters the command menu.
                    setSlashQuery(/^\/[A-Za-z0-9_-]*$/.test(value) ? value.slice(1) : null);
                    setTask(value);
                  }}
                  onPaste={(event) => {
                    const files = [...event.clipboardData.files];
                    if (files.some((file) => IMAGE_TYPES.has(file.type))) {
                      event.preventDefault();
                      attachImages(files);
                    }
                  }}
                  onDragOver={(event) => {
                    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const files = [...event.dataTransfer.files];
                    if (files.some((file) => IMAGE_TYPES.has(file.type))) {
                      event.preventDefault();
                      attachImages(files);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (slashQuery !== null && slashKeyRef.current?.(event)) {
                      event.preventDefault();
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                {slashQuery !== null ? (
                  <div className="slash-anchor">
                    <SlashMenu
                      entries={slashEntries}
                      query={slashQuery}
                      keyRef={slashKeyRef}
                      onPick={(entry) => {
                        setTask(`/${entry.name} `);
                        setSlashQuery(null);
                        composerInputRef.current?.focus();
                      }}
                      onClose={() => setSlashQuery(null)}
                    />
                  </div>
                ) : null}
                <div className="composer-bar">
                  <div className="composer-controls">
                    <div className="context-anchor">
                      <button
                        type="button"
                        className={pendingContext.length ? "composer-pill-btn on" : "composer-pill-btn"}
                  aria-label="Attach context"
                        title={currentConversation?.projectId ? "Attach files, a folder, git changes, the terminal or a web page (@)" : "Start a chat in a project to attach its files"}
                        disabled={!agent || !currentConversation?.projectId}
                        onClick={() => setContextOpen((open) => !open)}
                      >
                        @
                      </button>
                      {contextOpen && currentConversation?.projectId ? (
                        <ContextPicker
                          projectId={currentConversation.projectId}
                          onPick={(items) => setPendingContext((current) => [...current, ...items.filter((item) => !current.some((existing) => existing.kind === item.kind && ("path" in existing ? existing.path === ("path" in item ? item.path : "") : "url" in existing ? existing.url === ("url" in item ? item.url : "") : true)))])}
                          onClose={() => {
                            setContextOpen(false);
                            composerInputRef.current?.focus();
                          }}
                        />
                      ) : null}
                    </div>
                    {models.length > 0 ? (
                      <ModelSelector
                        models={models}
                        selectedModelId={agent?.modelConnectionId ?? null}
                        disabled={!agent}
                        onChange={(modelId) => void patchAgent({ modelConnectionId: modelId })}
                        onChangeEffort={(modelId, effort) => void changeEffort(modelId, effort)}
                        onOpenUsage={() => openSettingsPage("usage")}
                        onOpenSettings={(page) => openSettingsPage(page)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="composer-pill-btn warn"
                        onClick={() => openSettingsPage("llm")}
                      >
                        <span>+ Connect Model</span>
                      </button>
                    )}
                  </div>

                  <div className="composer-submit-group">
                    <select
                      className={`mode-select ${mode}`}
                      aria-label="Mode"
                      title="Agent: may change files and run commands. Ask: only reads and answers. Plan: only reads and writes a plan."
                      value={mode}
                      disabled={!agent}
                      onChange={(event) => chooseMode(event.target.value as RunMode)}
                    >
                      <option value="agent">Agent</option>
                      <option value="ask">Ask</option>
                      <option value="plan">Plan</option>
                    </select>
                    <GuardrailSelector
                      autonomy={agent?.autonomy}
                      disabled={!agent}
                      onChange={(mode) => void patchAgent({ autonomy: mode })}
                    />
                    <button
                      type="button"
                      className="composer-pill-btn"
                      aria-label="Run in the background"
                      title={agent ? "Run in the background: a new chat (on its own branch in a project) so you can keep working here; you are told when it finishes." : "Choose an agent first"}
                      disabled={!agent || editing !== null || !task.trim()}
                      onClick={() => {
                        if (!agent || !task.trim()) return;
                        const text = task.trim();
                        setTask("");
                        void dispatchInBackground(agent.id, text, currentConversation?.projectId ?? null).catch((error) => setNotice(error instanceof Error ? error.message : "Could not start the agent"));
                      }}
                    >
                      ⧉
                    </button>
                    <button
                      className={busy ? "send stop" : "send"}
                      type="submit"
                      disabled={!agent || editing !== null || (!busy && !task.trim() && !pendingImages.length)}
                      aria-label={busy ? "Stop" : "Send"}
                    >
                      {busy ? <Square /> : <Arrow />}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </>
        )}
      </main>

      {view === "workspace" && inspectorOpen && agent ? (
        <Inspector
          runs={thread}
          initialFeature={browsing ? "browser" : null}
          onClose={() => setInspectorOpen(false)}
          onResizeStart={handleInspectorResizeStart}
          onResizeReset={handleInspectorResizeReset}
          isResizing={isResizingInspector}
        />
      ) : null}

      {customizingAgent ? (
        <AgentSettings
          agent={customizingAgent}
          models={models}
          mcp={mcp}
          rag={rag}
          runs={customizingAgent ? (agentThreads[customizingAgent.id]?.flatMap((c) => threads[c.id] ?? []) ?? threads[`agent_${customizingAgent.id}`] ?? []) : []}
          onClose={() => setCustomizingAgent(null)}
          onOpenSettings={(page) => {
            setCustomizingAgent(null);
            openSettingsPage(page);
          }}
          onSave={async (patch) => {
            await desktop.catalog.updateAgent(customizingAgent.id, patch);
            await reload();
            setCustomizingAgent((prev) => (prev ? { ...prev, ...patch } : null));
          }}
          onDelete={async () => {
            const agentId = customizingAgent.id;
            setCustomizingAgent(null);
            await removeAgent(agentId);
          }}
        />
      ) : null}

      {creating ? (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCreating(false);
              setName("");
            }
          }}
        >
          <div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="create-agent-modal-title">
            <div className="modal-header">
              <h3 id="create-agent-modal-title">Create Agent</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  setCreating(false);
                  setName("");
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createAgent();
              }}
            >
              <div className="modal-body">
                <label className="label" htmlFor="new-agent-name-input">
                  Agent Name
                </label>
                <input
                  id="new-agent-name-input"
                  autoFocus
                  value={name}
                  placeholder="e.g. Researcher, Code Reviewer"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCreating(false);
                      setName("");
                    }
                  }}
                />
              </div>
              <div className="modal-actions">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setName("");
                  }}
                >
                  取消
                </button>
                <button
                  className="btn primary-btn"
                  type="submit"
                  disabled={!name.trim()}
                >
                  確定
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      </div>

      {/* ─── Antigravity Command / Search Palette ─── */}
      {searchOpen ? (
        <div className="command-palette-backdrop" onClick={() => setSearchOpen(false)}>
          <div className="command-palette" role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.stopPropagation()}>
            <div className="command-palette-head">
              <SearchIcon />
              <input
                ref={searchInputRef}
                type="text"
                className="command-palette-input"
                placeholder="Search agents, tasks, or actions... (Esc to close)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
            </div>
            <div className="command-palette-list">
              {filteredPaletteItems.length === 0 ? (
                <div style={{ padding: "16px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                  No matching results
                </div>
              ) : (
                filteredPaletteItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="command-palette-item"
                    onClick={() => {
                      setSearchOpen(false);
                      item.action();
                    }}
                  >
                    <div className="command-palette-item-left">
                      <span className="command-palette-item-label">{item.label}</span>
                    </div>
                    <span className="command-palette-item-shortcut">{item.group}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {ideNotice && (
        <div className="coming-soon-toast" role="status" aria-live="polite">
          <span className="coming-soon-dot">●</span>
          <span>{ideNotice}</span>
        </div>
      )}

      {prDraft ? (
        <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && !prDraft.busy && setPrDraft(null)}>
          <form
            className="modal-dialog pr-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Open a pull request"
            onSubmit={(event) => {
              event.preventDefault();
              const draft = prDraft;
              setPrDraft({ ...draft, busy: true, error: "" });
              void desktop.catalog.openPullRequest(draft.threadId, { title: draft.title, body: draft.body }).then((result) => {
                setPrDraft(null);
                setNotice(`Opened pull request #${result.number}: ${result.url}`);
                void reload();
              }, (error: unknown) => setPrDraft({ ...draft, busy: false, error: error instanceof Error ? error.message : "Could not open the pull request" }));
            }}
          >
            <div className="modal-header"><h3>Open a pull request</h3></div>
            <div className="modal-body">
              <p className="hint">Pending work on the branch is committed, the branch is pushed to origin, and the pull request is created with your GitHub token.</p>
              <label className="label" htmlFor="pr-title">Title</label>
              <input id="pr-title" value={prDraft.title} onChange={(event) => setPrDraft({ ...prDraft, title: event.target.value })} />
              <label className="label" htmlFor="pr-body">Description</label>
              <textarea id="pr-body" className="input" rows={8} value={prDraft.body} onChange={(event) => setPrDraft({ ...prDraft, body: event.target.value })} />
              {prDraft.error ? <p className="error">{prDraft.error}</p> : null}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" disabled={prDraft.busy} onClick={() => setPrDraft(null)}>Cancel</button>
              <button type="submit" className="btn primary-btn" disabled={prDraft.busy || !prDraft.title.trim()}>{prDraft.busy ? "Opening…" : "Push and open"}</button>
            </div>
          </form>
        </div>
      ) : null}
      {conflict ? (
        <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && setConflict(null)}>
          <div className="modal-dialog" role="dialog" aria-modal="true" aria-label="Merge conflicts">
            <div className="modal-header"><h3>Merge conflicts</h3></div>
            <div className="modal-body">
              <p className="hint">Merging {conflict.branch} into {conflict.base} conflicts in {conflict.files.length} file{conflict.files.length === 1 ? "" : "s"}; the merge was undone and the branch kept:</p>
              <ul className="conflict-list">{conflict.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => { void desktop.projects.openInEditor(conflict.projectId); setConflict(null); }}>Open in Saturn IDE</button>
              <button
                type="button"
                className="btn primary-btn"
                onClick={() => {
                  const files = conflict.files.map((file) => `- ${file}`).join("\n");
                  setConflict(null);
                  void send(`Merging this branch (${conflict.branch}) into ${conflict.base} conflicts in these files:\n${files}\n\nIn this worktree, run \`git merge ${conflict.base}\`, resolve each conflict keeping the intent of both sides, make sure the project still builds, then commit the merge. Do not force-push or discard either side's work.`);
                }}
              >
                Ask the agent to resolve
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {accessRequest ? (
        <AccessDialog
          path={accessRequest.path}
          name={accessRequest.name}
          onClose={() => setAccessRequest(null)}
          onAllow={() => allowAccess(accessRequest)}
        />
      ) : null}

      {projectMenu ? (
        <ProjectContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          onClose={() => setProjectMenu(null)}
          items={[
            { label: "New Chat", icon: <PlusIcon />, action: () => withAccess(projectMenu.project, (granted) => void newProjectChat(granted)) },
            "divider",
            { label: "Open in Saturn IDE", icon: <CodeIconSmall />, action: () => void handleOpenProjectEditor(projectMenu.project.id) },
            { label: "Open in Terminal", icon: <TerminalIconSmall />, action: () => void handleOpenProjectTerminal(projectMenu.project.id) },
            { label: "Reveal in Finder", icon: <WorkspaceFolderIcon />, action: () => void handleOpenProjectFolder(projectMenu.project.id) },
            "divider",
            {
              label: "Edit Workspace",
              icon: <PencilSmallIcon />,
              action: () => setEditingProject(projectMenu.project),
            },
            { label: "Remove from Sidebar", icon: <TrashSmallIcon />, action: () => void removeProject(projectMenu.project) },
          ]}
        />
      ) : null}

      {editingProject ? (
        <EditWorkspaceDialog
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSave={async (patch) => {
            await handleUpdateProject(editingProject.id, patch);
            await syncProjects();
          }}
        />
      ) : null}

      {settingsOpen ? (
        <Settings
          initialPage={settingsPage}
          initialProjectId={settingsProjectId}
          agents={agents}
          agent={agent}
          models={models}
          mcp={mcp}
          rag={rag}
          projects={projects}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsProjectId(null);
          }}
          onChanged={reload}
          onPatchAgent={patchAgent}
          onProfile={setProfile}
          theme={theme}
          onSetTheme={setTheme}
          onToggleTheme={toggleTheme}
        />
      ) : null}
    </div>
  );
}

function storedTheme(): "light" | "dark" {
  const saved = localStorage.getItem("saturn-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8L4 11z" />
      <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 1.8v3M10 1.8v3M4.2 4.8h7.6v2.4a3.8 3.8 0 0 1-7.6 0V4.8zM8 11v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ThemeIcon(props: { theme: "light" | "dark" }) {
  if (props.theme === "dark") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.2 2.2a4.8 4.8 0 1 0 4.6 6.2 3.8 3.8 0 0 1-4.6-6.2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Pencil() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.2 3.4l3.4 3.4M2.8 13.2l.6-3.2L11.4 2.6a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7L5.4 12.6l-3.2.6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 12.5V3.5M8 3.5L4 7.5M8 3.5L12 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Square() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  );
}

function LeftSidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M5.8 2.8v10.4" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function RightSidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10.2 2.8v10.4" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2L13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function DotsVerticalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="4" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="12" r="1.15" fill="currentColor" />
    </svg>
  );
}

/**
 * The chat's worktree state in the top bar: a button to start working on an own branch, or, once isolated, the
 * branch name with a menu to merge, keep or discard it.
 */
function WorktreeControl(props: { conversation: Conversation; busy: boolean; onIsolate: () => void; onFinish: (how: "merge" | "keep" | "discard") => void; onPullRequest: () => void }) {
  const [open, setOpen] = useState(false);
  const worktree = props.conversation.worktree;
  if (!worktree) {
    return (
      <button type="button" className="titlebar-btn" disabled={props.busy} title="Work on an own git branch: the agent's changes stay out of the project folder until you merge them" aria-label="Isolate in a worktree" onClick={props.onIsolate}>
        <BranchIcon />
      </button>
    );
  }
  return (
    <div className="titlebar-menu-wrapper">
      <button type="button" className={open ? "titlebar-worktree active" : "titlebar-worktree"} disabled={props.busy} title={`This chat works on ${worktree.branch} (from ${worktree.base}) in its own worktree`} onClick={() => setOpen((v) => !v)}>
        <BranchIcon />
        <span>{worktree.branch.replace(/^saturn\//, "")}</span>
      </button>
      {open ? (
        <div className="titlebar-dropdown" onMouseLeave={() => setOpen(false)}>
          <button type="button" className="titlebar-dropdown-item" onClick={() => { setOpen(false); props.onFinish("merge"); }}><span>Merge into {worktree.base}</span></button>
          <button type="button" className="titlebar-dropdown-item" onClick={() => { setOpen(false); props.onPullRequest(); }}><span>Open pull request…</span></button>
          <button type="button" className="titlebar-dropdown-item" onClick={() => { setOpen(false); props.onFinish("keep"); }}><span>Keep branch for a pull request</span></button>
          <button type="button" className="titlebar-dropdown-item" onClick={() => { setOpen(false); props.onFinish("discard"); }}><span>Discard branch</span></button>
        </div>
      ) : null}
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="5.5" r="1.6" />
      <path d="M4 5.1v5.8M12 7.1c0 2.4-2 3-4.2 3.3S4 11 4 10.9" />
    </svg>
  );
}

function IdeWindowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="5.8" y1="1.5" x2="5.8" y2="14.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="7.4" y1="4.3" x2="11.4" y2="4.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="8.6" y1="6.4" x2="12.6" y2="6.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="8.6" y1="8.5" x2="12.6" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="8.6" y1="10.6" x2="12.6" y2="10.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="7.4" y1="12.7" x2="11.4" y2="12.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function EmployeeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5" r="2.8" stroke="currentColor" strokeWidth="1.35" />
      <path d="M2.8 13.5c0-2.6 2.3-4.7 5.2-4.7s5.2 2.1 5.2 4.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v6A1.5 1.5 0 0 1 12 11.5H6L3 14v-2.5H2.5A1.5 1.5 0 0 1 2.5 10V4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CodeIconSmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TerminalIconSmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6.5l2 1.5-2 1.5M8.5 9.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** A run suspended on a long computer_wait: what it waits for, a live countdown, and a way to cut it short. */
function WaitingLine(props: { wake: NonNullable<Run["wake"]>; onWake: () => void; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = countdown(props.wake.at, now);
  return (
    <div className="assistant-body">
      <div className="run-state-line sleeping">
        <span className="dot wait" />
        <span>
          {left === "now" ? "Resuming…" : `Waiting · resumes in ${left}`}
          {props.wake.reason ? <span className="wait-reason"> · {props.wake.reason}</span> : null}
        </span>
        <button className="btn ghost tiny" type="button" onClick={props.onWake}>Wake now</button>
        <button className="btn ghost tiny" type="button" onClick={props.onStop}>Stop</button>
      </div>
    </div>
  );
}

type ContextMenuItem = { label: string; icon: React.ReactNode; action: () => void } | "divider";

/** A right-click menu at the pointer, kept inside the window; closes on choice, outside click, Escape or scroll. */
function ProjectContextMenu(props: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.x, top: props.y });
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) {
      setPosition({
        left: Math.max(8, Math.min(props.x, window.innerWidth - box.width - 8)),
        top: Math.max(8, Math.min(props.y, window.innerHeight - box.height - 8)),
      });
    }
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => {
      if (event instanceof MouseEvent && ref.current?.contains(event.target as Node)) return;
      props.onClose();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", keys);
    window.addEventListener("blur", props.onClose);
    window.addEventListener("resize", props.onClose);
    document.addEventListener("scroll", props.onClose, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", keys);
      window.removeEventListener("blur", props.onClose);
      window.removeEventListener("resize", props.onClose);
      document.removeEventListener("scroll", props.onClose, true);
    };
  }, [props.x, props.y, props.onClose]);
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: position.left, top: position.top }}>
      {props.items.map((item, index) =>
        item === "divider" ? (
          <div key={`divider-${index}`} className="context-menu-divider" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.label.startsWith("Remove") ? "context-menu-item danger" : "context-menu-item"}
            onClick={() => { props.onClose(); item.action(); }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

function MoreIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

function PencilSmallIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10.5 2.5l3 3L5.5 13.5H2.5v-3l8-8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function TrashSmallIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4h11M6 4V2.75h4V4M4 4l.7 9.25h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
