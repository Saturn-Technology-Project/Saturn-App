import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { desktop } from "../../application/desktop.js";
import type { Model, Profile, Project } from "../../domain/model.js";
import { useRuntimeStatus } from "../../infrastructure/runtime-status.js";
import { syncWindowControls } from "../../infrastructure/window-controls.js";
import { AccessDialog, chooseFolder } from "../ProjectAccess.js";
import { AssistantIcon, BoxIcon, CodeIcon, FlaskIcon, GearIcon, HomeIcon, LineageIcon, SamplesIcon, ShieldIcon, TasksIcon } from "../ui/Icons.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.js";
import { rememberScreen, rememberedScreen, SCREENS, type Screen } from "./navigation.js";
import { RuntimeGate } from "./RuntimeGate.js";
import { ScreenSwitch } from "./ScreenSwitch.js";
import { SettingsHost } from "./SettingsHost.js";
import { Tour } from "./Tour.js";
import { useNotifications } from "./useNotifications.js";

const SCREEN_ICONS: Record<Screen, ReactNode> = {
  Home: <HomeIcon />,
  Workspace: <CodeIcon />,
  Lineage: <LineageIcon />,
  Experiments: <FlaskIcon />,
  Samples: <SamplesIcon />,
  Tasks: <TasksIcon />,
  Protection: <ShieldIcon />,
  Environment: <BoxIcon />,
};

function storedTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("saturn-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Falls back on the system's choice.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The workbench: one project at a time, its screens, and what every screen shares. */
export function ResearchApp() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>(rememberedScreen);
  const [theme, setTheme] = useState(storedTheme);
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [assistant, setAssistant] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The tour runs over the live interface on the first launch, and again whenever it is asked for.
  const [tour, setTour] = useState(false);
  const [accessRequest, setAccessRequest] = useState<{ path: string; name?: string; projectId?: string } | null>(null);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  useNotifications();
  const runtime = useRuntimeStatus();
  const runtimeReady = runtime.status.state === "ready";

  const project = projects.find((item) => item.id === projectId) ?? null;

  const syncProjects = useCallback(async () => {
    const list = await desktop.projects.list();
    setProjects(list);
    const active = await desktop.projects.getActive().catch(() => null);
    setProjectId((current) => current ?? active?.id ?? list[0]?.id ?? null);
    setProfile(await desktop.catalog.settings());
    setModels(await desktop.catalog.listModels());
  }, []);

  // Loads once the runtime answers, and again each time it comes back.
  useEffect(() => {
    if (!runtimeReady) return;
    syncProjects()
      .then(() => setNotice(null))
      .catch((error: unknown) => setNotice(`Saturn's runtime is not answering: ${messageOf(error)}`))
      .finally(() => setLoaded(true));
  }, [runtimeReady, syncProjects]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("saturn-theme", theme);
    } catch {
      // Only remembers the choice.
    }
    syncWindowControls("--stage");
  }, [theme]);

  useEffect(() => {
    if (/Mac/.test(navigator.platform)) document.documentElement.dataset.platform = "darwin";
  }, []);

  const go = useCallback((next: Screen) => {
    setScreen(next);
    rememberScreen(next);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      } else if (command && event.key === ",") {
        event.preventDefault();
        setSettings((open) => !open);
      } else if (command && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setAssistant((open) => !open);
      } else if (command && /^[1-8]$/.test(event.key)) {
        event.preventDefault();
        go(SCREENS[Number(event.key) - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // A notification about a task opens Tasks.
  useEffect(() => window.saturnDesktop?.onOpenThread?.(() => go("Tasks")), [go]);

  async function addProject() {
    try {
      const folder = await chooseFolder();
      if (folder) setAccessRequest({ path: folder });
    } catch (error) {
      setNotice(messageOf(error));
    }
  }

  async function allowAccess(request: { path: string; projectId?: string }) {
    const allowed = request.projectId ? await desktop.projects.setAccess(request.projectId, true) : await desktop.projects.create({ path: request.path, grant: true });
    await syncProjects();
    await chooseProject(allowed.id);
  }

  async function chooseProject(id: string) {
    setProjectId(id);
    try {
      await desktop.projects.setActive(id);
    } catch (error) {
      setNotice(messageOf(error));
    }
  }

  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...SCREENS.map((item, index) => ({ id: `go-${item}`, label: `Go to ${item}`, hint: `⌘${index + 1}`, run: () => go(item) })),
      ...projects.filter((item) => item.id !== projectId).map((item) => ({ id: `project-${item.id}`, label: `Switch to ${item.name}`, run: () => void chooseProject(item.id) })),
      { id: "add-project", label: "Add a project folder", run: () => void addProject() },
      { id: "assistant", label: assistant ? "Hide the research assistant" : "Show the research assistant", hint: "⌘J", run: () => setAssistant((open) => !open) },
      { id: "theme", label: theme === "dark" ? "Use the light theme" : "Use the dark theme", run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { id: "settings", label: "Open Settings", hint: "⌘,", run: () => setSettings(true) },
      { id: "tour", label: "Take the tour", run: () => setTour(true) },
      ...(runtime.restart ? [{ id: "restart-runtime", label: "Restart Saturn's runtime", run: () => void runtime.restart?.() }] : []),
    ],
    // The commands close over the latest state each time they are rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assistant, go, projectId, projects, runtime.restart, theme],
  );

  let body: ReactNode;
  if (!loaded) {
    body = null;
  } else if (!project) {
    body = (
      <Empty title="Choose a project" action={<button type="button" className="lab-button primary" onClick={() => void addProject()}>Add a project folder</button>}>
        Research records live in a project's own folder, as plain files you can keep.
      </Empty>
    );
  } else if (!project.access) {
    body = (
      <Empty title={`Allow access to ${project.name}`} action={<button type="button" className="lab-button primary" onClick={() => setAccessRequest({ path: project.path, name: project.name, projectId: project.id })}>Review access</button>}>
        Saturn reads and writes this folder only after you allow it.
      </Empty>
    );
  } else {
    body = <ScreenSwitch key={project.id} project={project} screen={screen} assistant={assistant} go={go} notify={setNotice} onOpenSettings={() => setSettings(true)} />;
  }

  const touring = loaded && (tour || Boolean(profile && !profile.onboardedAt));
  async function finishTour() {
    setTour(false);
    if (profile && !profile.onboardedAt) {
      try {
        setProfile(await desktop.admin.updateSettings({ onboardedAt: new Date().toISOString() }));
      } catch (error) {
        setNotice(messageOf(error));
      }
    }
  }

  return (
    <div className="lab-app">
      <nav className="lab-rail" aria-label="Screens" data-tour="rail">
        <div className="lab-rail-drag" />
        {SCREENS.map((item) => (
          <button type="button" key={item} className="lab-rail-item" data-tour={`rail-${item}`} aria-current={screen === item ? "page" : undefined} onClick={() => go(item)}>
            {SCREEN_ICONS[item]}
            <span>{item}</span>
          </button>
        ))}
        <div className="lab-rail-space" />
        <button type="button" className="lab-rail-item" onClick={() => setSettings(true)}>
          <GearIcon />
          <span>Settings</span>
        </button>
      </nav>
      <div className="lab-main">
        <header className="lab-bar">
          <select className="lab-bar-project" aria-label="Project" data-tour="project" value={projectId ?? ""} onChange={(event) => void (event.target.value === "+" ? addProject() : chooseProject(event.target.value))}>
            {projectId ? null : <option value="">No project</option>}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            <option value="+">Add a project folder…</option>
          </select>
          <div className="lab-bar-context">{screen}</div>
          <span className={runtimeReady ? "lab-runtime" : "lab-runtime off"} title={runtime.status.state === "ready" ? `Runtime ${runtime.status.version}` : "Runtime not answering"}>
            {runtimeReady ? "Runtime" : "Runtime off"}
          </span>
          <button type="button" className="lab-button quiet" onClick={() => setPalette(true)}>
            Commands <span className="lab-muted">⌘K</span>
          </button>
          <button type="button" className="lab-button quiet" data-tour="assistant" aria-pressed={assistant} onClick={() => setAssistant((open) => !open)}>
            <AssistantIcon /> Assistant
          </button>
        </header>
        {notice ? (
          <div className="lab-notice bad" role="alert">
            {notice}
            <button type="button" className="lab-link" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        <div className="lab-screen">{body}</div>
        <RuntimeGate status={runtime.status} restart={runtime.restart} />
      </div>
      {palette ? <CommandPalette commands={commands} onClose={() => setPalette(false)} /> : null}
      {accessRequest ? <AccessDialog path={accessRequest.path} name={accessRequest.name} onClose={() => setAccessRequest(null)} onAllow={() => allowAccess(accessRequest)} /> : null}
      {settings ? <SettingsHost projects={projects} theme={theme} onSetTheme={setTheme} onClose={() => setSettings(false)} onProfile={setProfile} notify={setNotice} /> : null}
      {touring && !settings && !accessRequest ? <Tour project={project?.access ? project : null} models={models} go={go} onAddProject={addProject} onOpenSettings={() => setSettings(true)} onFinish={finishTour} /> : null}
    </div>
  );
}
