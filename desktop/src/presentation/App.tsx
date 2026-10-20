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
import {
  extractPlanSteps,
  countdown,
  isBusy,
  modelLabel,
  replaceRevised,
  upsertRun,
  visibleThread,
} from "../domain/conversation";
import type { Agent, Autonomy, Conversation, Group, Mcp, Model, PendingTask, Profile, Project, Rag, Run } from "../domain/model";

const isElectron =
  typeof window !== "undefined" &&
  Boolean((window as unknown as { process?: { type?: string } }).process?.type || window.navigator.userAgent.includes("Electron"));
const isMac = typeof window !== "undefined" && navigator.userAgent.toLowerCase().includes("mac");
const isElectronMac = isElectron && isMac;

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
  const [accessRequest, setAccessRequest] = useState<{ path: string; name?: string; projectId?: string; then?: (project: Project) => void } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectView, patchProjectView, resetProjectView] = useProjectView();
  const [view, setView] = useState<"workspace" | "settings" | "automations" | "customizations" | "project" | "group">("workspace");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("settings");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [navWidth, setNavWidth] = useState<number>(storedNavWidth);
  const [inspectorWidth, setInspectorWidth] = useState<number>(storedInspectorWidth);
  const [isResizingNav, setIsResizingNav] = useState(false);
  const [isResizingInspector, setIsResizingInspector] = useState(false);
  const [, setProfile] = useState<Profile>({ name: "Saturn", environment: "production", logging: "info" });
  const [theme, setTheme] = useState<"light" | "dark">(storedTheme);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navHistory, setNavHistory] = useState<
    Array<{ view: "workspace" | "settings" | "automations" | "customizations" | "project" | "group"; agentId: string | null; settingsPage?: SettingsPage }>
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
      setAccessRequest({ path: folder, then: (project) => void newProjectChat(project) });
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
    request.then?.(project);
  }

  /** Runs `then` once the project's folder is accessible, asking the user first when it is not. */
  function withAccess(project: Project, then: (project: Project) => void) {
    if (project.access) then(project);
    else setAccessRequest({ path: project.path, name: project.name, projectId: project.id, then });
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
    const timer = window.setInterval(() => void sync(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (agents.length === 0) return;
    let stop = false;
    async function syncThreads() {
      try {
        const entries = await Promise.all(
          agents.map(async (a) => {
            const list = await desktop.catalog.listThreads(a.id);
            return [a.id, list] as const;
          })
        );
        if (!stop) {
          const map: Record<string, Conversation[]> = {};
          for (const [id, list] of entries) {
            map[id] = list;
          }
          setAgentThreads(map);
        }
      } catch {
        // ignore
      }
    }
    void syncThreads();
    const timer = window.setInterval(() => void syncThreads(), 3000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [agents]);

  useEffect(() => {
    if (!selected) return;
    setOpenFolders((prev) => (prev[selected] ? prev : { ...prev, [selected]: true }));
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
    const timer = window.setInterval(() => void pull(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [selected, selectedThreadId]);

  const agent = agents.find((item) => item.id === selected) ?? null;
  const currentThreadKey = selectedThreadId || (selected ? `agent_${selected}` : "");
  const thread = currentThreadKey ? threads[currentThreadKey] ?? [] : [];
  const { visible, editIndex } = visibleThread(thread, editing);
  const latest = thread.at(-1);
  const busy = isBusy(latest);

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

  async function send() {
    if (!agent || !task.trim() || busy || editing) return;
    const input = task.trim();
    isNearBottomRef.current = true;
    scrollToBottom(false);
    let started: Run;
    try {
      started = await desktop.runs.start(agent.id, input, selectedThreadId || undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Run failed");
      return;
    }
    setNotice("");
    setTask("");
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
    view: "workspace" | "settings" | "automations" | "customizations" | "project" | "group";
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

  function handleOpenArtifacts() {
    setInspectorOpen(true);
  }

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

  const layoutClass = [
    "app",
    !sidebarOpen ? "no-sidebar" : "",
    view === "automations" || view === "customizations" || view === "project" || view === "group"
      ? ""
      : inspectorOpen && agent
        ? "with-inspector"
        : "",
  ]
    .filter(Boolean)
    .join(" ");

  const renderNavControls = () => (
    <>
      <div className="titlebar-traffic-space">
        {!isElectronMac && (
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
              className="titlebar-btn"
              onClick={() => handleOpenIde()}
              title="Open Workspace in Saturn IDE"
              aria-label="Open Workspace in Saturn IDE"
            >
              <IdeWindowIcon />
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
        ) : view === "automations" ? (
          <Automations
            agents={agents}
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
                              <p>{run.input}</p>
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
                          {planSteps.length > 0 ? (
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

                          <RunChangesCard run={run} />

                          {run.status === "sleeping" && run.wake ? (
                            <WaitingLine wake={run.wake} onWake={() => void wakeRun(run)} onStop={() => void stopRun(run)} />
                          ) : null}

                          {run.output ? (
                            <div className="assistant-body">
                              <FormattedOutput text={run.output} />
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
                <textarea
                  ref={composerInputRef}
                  rows={2}
                  value={task}
                  disabled={!agent || busy || editing !== null}
                  placeholder={agent ? `Ask ${agent.name} to inspect files, run commands, or execute tools…` : "Create or choose an agent to get started…"}
                  onChange={(event) => setTask(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-bar">
                  <div className="composer-controls">
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
                    <GuardrailSelector
                      autonomy={agent?.autonomy}
                      disabled={!agent}
                      onChange={(mode) => void patchAgent({ autonomy: mode })}
                    />
                    <button
                      className={busy ? "send stop" : "send"}
                      type="submit"
                      disabled={!agent || editing !== null || (!busy && !task.trim())}
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
          <div className="command-palette" onClick={(e) => e.stopPropagation()}>
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
          agents={agents}
          agent={agent}
          models={models}
          mcp={mcp}
          rag={rag}
          projects={projects}
          onClose={() => setSettingsOpen(false)}
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

function SidebarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.2 2.8v10.4" stroke="currentColor" strokeWidth="1.3" />
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

function ArtifactDocumentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
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

function FolderIcon(props: { open?: boolean }) {
  if (props.open) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5V6H3.3l-1.5 6.5A1.5 1.5 0 0 1 1.5 11V4.5z" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3.3 6h11.2l-1.8 6.5a1.5 1.5 0 0 1-1.4 1H2.7a1.5 1.5 0 0 1-1.4-1.9L3.3 6z" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h3l1.5 1.5H12.5A1.5 1.5 0 0 1 14 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5V3.5z" stroke="currentColor" strokeWidth="1.3" />
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
