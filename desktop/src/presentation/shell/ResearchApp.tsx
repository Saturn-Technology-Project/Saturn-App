import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { isWorkScreen, screenLabels, statusText, windowTitle } from "../../domain/workbench.js";
import type { Model, Profile, Project } from "../../domain/model.js";
import { useRuntimeStatus } from "../../infrastructure/runtime-status.js";
import { syncWindowControls } from "../../infrastructure/window-controls.js";
import { AccessDialog, chooseFolder } from "../ProjectAccess.js";
import { AssistantIcon, BoxIcon, CodeIcon, DataIcon, FlaskIcon, GearIcon, HomeIcon, InspectIcon, LineageIcon, SamplesIcon, ShieldIcon, TasksIcon } from "../ui/Icons.js";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Choice } from "../ui/base/Field.js";
import { Notice } from "../ui/base/Notice.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.js";
import { Guide } from "./Guide.js";
import { rememberScreen, rememberedScreen, SCREENS, type Screen } from "./navigation.js";
import { RuntimeGate } from "./RuntimeGate.js";
import { ScreenSwitch } from "./ScreenSwitch.js";
import { SettingsHost } from "./SettingsHost.js";
import { Tour } from "./Tour.js";
import { useNotifications } from "./useNotifications.js";

/** A screen's row in the rail. Its icon is the same color as its name; where you are is marked by a lighter row. */
const RAIL_ITEM = "flex h-[34px] w-full flex-none cursor-pointer appearance-none items-center gap-2.5 rounded-[7px] border-0 bg-transparent px-2.5 text-[12.5px] font-medium whitespace-nowrap text-foreground transition-colors hover:bg-muted aria-[current=page]:bg-(--selected) aria-[current=page]:font-semibold max-[1080px]:h-[38px] max-[1080px]:justify-center max-[1080px]:px-0 [&>svg]:flex-none";

const SCREEN_ICONS: Record<Screen, ReactNode> = {
  Home: <HomeIcon />,
  Workspace: <CodeIcon />,
  Lineage: <LineageIcon />,
  Experiments: <FlaskIcon />,
  Samples: <SamplesIcon />,
  Data: <DataIcon />,
  Inspect: <InspectIcon />,
  Tasks: <TasksIcon />,
  Protection: <ShieldIcon />,
  Environment: <BoxIcon />,
};

/** Each screen's name as shown. */
const SCREEN_LABELS = screenLabels(t);

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
  // Beside the screens where work is read and written unless closed; on the others, opened when wanted.
  const [assistantAtWork, setAssistantAtWork] = useState(true);
  const [assistantElsewhere, setAssistantElsewhere] = useState(false);
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
  const assistant = isWorkScreen(screen) ? assistantAtWork : assistantElsewhere;
  const toggleAssistant = useCallback(() => {
    (isWorkScreen(screen) ? setAssistantAtWork : setAssistantElsewhere)((open) => !open);
  }, [screen]);

  // The window's own title, which is what computer use and assistive technology find it by.
  const title = windowTitle(SCREEN_LABELS[screen], project?.name ?? null);
  useEffect(() => {
    document.title = title;
    void window.saturnDesktop?.setTitle?.(title);
  }, [title]);

  const syncProjects = useCallback(async () => {
    const list = await desktop.projects.list();
    setProjects(list);
    const active = await desktop.projects.getActive().catch(() => null);
    // A project that is gone, removed here or elsewhere, gives way to the runtime's active one.
    setProjectId((current) => (current && list.some((item) => item.id === current) ? current : (active?.id ?? list[0]?.id ?? null)));
    setProfile(await desktop.catalog.settings());
    setModels(await desktop.catalog.listModels());
  }, []);

  // Loads once the runtime answers, and again each time it comes back.
  useEffect(() => {
    if (!runtimeReady) return;
    syncProjects()
      .then(() => setNotice(null))
      .catch((error: unknown) => setNotice(t("Saturn's runtime is not answering: {reason}", { reason: messageOf(error) })))
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
        toggleAssistant();
      } else if (command && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        go(SCREENS[Number(event.key) - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, toggleAssistant]);

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
      ...SCREENS.map((item, index) => ({ id: `go-${item}`, label: t("Go to {screen}", { screen: SCREEN_LABELS[item] }), hint: index < 9 ? `⌘${index + 1}` : "", run: () => go(item) })),
      ...projects.filter((item) => item.id !== projectId).map((item) => ({ id: `project-${item.id}`, label: t("Switch to {project}", { project: item.name }), run: () => void chooseProject(item.id) })),
      { id: "add-project", label: t("Add a project folder"), run: () => void addProject() },
      { id: "assistant", label: assistant ? t("Hide the research assistant") : t("Show the research assistant"), hint: "⌘J", run: toggleAssistant },
      { id: "theme", label: theme === "dark" ? t("Use the light theme") : t("Use the dark theme"), run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { id: "settings", label: t("Open Settings"), hint: "⌘,", run: () => setSettings(true) },
      { id: "tour", label: t("Take the tour"), run: () => setTour(true) },
      ...(runtime.restart ? [{ id: "restart-runtime", label: t("Restart Saturn's runtime"), run: () => void runtime.restart?.() }] : []),
    ],
    // The commands close over the latest state each time they are rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assistant, go, projectId, projects, runtime.restart, theme, toggleAssistant],
  );

  let body: ReactNode;
  if (!loaded) {
    body = null;
  } else if (!project) {
    body = (
      <Empty title={t("Choose a project")} action={<Button onClick={() => void addProject()}>{t("Add a project folder")}</Button>}>
        {t("Research records live in a project's own folder, as plain files you can keep.")}
      </Empty>
    );
  } else if (!project.access) {
    body = (
      <Empty title={t("Allow access to {project}", { project: project.name })} action={<Button onClick={() => setAccessRequest({ path: project.path, name: project.name, projectId: project.id })}>{t("Review access")}</Button>}>
        {t("Saturn reads and writes this folder only after you allow it.")}
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
    <div className="fixed inset-0 flex min-w-0 overflow-hidden">
      <nav className="flex w-[148px] flex-none flex-col gap-0.5 border-r border-border bg-panel px-2 pt-1.5 pb-2 max-[1080px]:w-[72px]" aria-label={t("Screens")} data-tour="rail">
        <div className="h-[34px] flex-none [--app-region:drag]" />
        {SCREENS.map((item, index) => (
          <button type="button" key={item} className={RAIL_ITEM} title={SCREEN_LABELS[item]} data-tour={`rail-${item}`} aria-current={screen === item ? "page" : undefined} aria-keyshortcuts={index < 9 ? `Meta+${index + 1}` : undefined} onClick={() => go(item)}>
            {SCREEN_ICONS[item]}
            <span className="max-[1080px]:sr-only">{SCREEN_LABELS[item]}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button type="button" className={RAIL_ITEM} title={t("Settings")} data-tour="settings" aria-keyshortcuts="Meta+," onClick={() => setSettings(true)}>
          <GearIcon />
          <span className="max-[1080px]:sr-only">{t("Settings")}</span>
        </button>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-stage">
        <header className="flex min-h-(--bar-height) flex-none items-center gap-2.5 border-b border-border py-1 pr-[calc(12px+var(--window-buttons))] pl-3 [--app-region:drag] [&_button]:[--app-region:no-drag]">
          <div data-tour="project" className="w-52 flex-none">
            <Choice ariaLabel={t("Project")} placeholder={t("No project")} value={projectId ?? ""} triggerClassName="border-transparent bg-transparent font-semibold shadow-none hover:bg-muted" options={[...projects.map((item) => ({ value: item.id, label: item.name })), { value: "+", label: t("Add a project folder…") }]} onChange={(value) => void (value === "+" ? addProject() : chooseProject(value))} />
          </div>
          <span className="text-xs text-muted-foreground">{SCREEN_LABELS[screen]}</span>
          <div className="min-w-0 flex-1" />
          <Badge tone={runtimeReady ? "good" : "wait"} title={runtime.status.state === "ready" ? t("Runtime {version}", { version: runtime.status.version }) : t("Runtime not answering")}>
            <span className="size-1.5 rounded-full bg-current" />
            {runtimeReady ? t("Runtime") : t("Runtime off")}
          </Badge>
          <Button variant="ghost" data-tour="commands" aria-keyshortcuts="Meta+K" onClick={() => setPalette(true)}>
            {t("Commands")} <span className="text-xs text-muted-foreground">⌘K</span>
          </Button>
          <Button variant={assistant ? "soft" : "ghost"} data-tour="assistant" aria-pressed={assistant} aria-keyshortcuts="Meta+J" onClick={toggleAssistant}>
            <AssistantIcon /> {t("Assistant")}
          </Button>
        </header>
        {notice ? (
          <Notice tone="bad" className="m-2 flex items-start justify-between gap-3">
            {notice}
            <Button variant="ghost" size="small" onClick={() => setNotice(null)}>{t("Dismiss")}</Button>
          </Notice>
        ) : null}
        <div className="sr-only" role="status">{statusText({ screen, project: project?.name ?? null, runtime: runtimeReady ? "ready" : "not answering" }, t)}</div>
        <main className="flex min-h-0 flex-1 flex-col" aria-label={SCREEN_LABELS[screen]}>{body}</main>
        <RuntimeGate status={runtime.status} restart={runtime.restart} />
      </div>
      <Guide go={go} />
      {palette ? <CommandPalette commands={commands} onClose={() => setPalette(false)} /> : null}
      {accessRequest ? <AccessDialog path={accessRequest.path} name={accessRequest.name} onClose={() => setAccessRequest(null)} onAllow={() => allowAccess(accessRequest)} /> : null}
      {settings ? <SettingsHost projects={projects} theme={theme} onSetTheme={setTheme} onClose={() => setSettings(false)} onProfile={setProfile} onProjectRemoved={() => { setSettings(false); void syncProjects(); }} notify={setNotice} /> : null}
      {touring ? (
        // Out of sight, not gone, under what its last step opens: it picks up where it was when that closes.
        <div hidden={settings || Boolean(accessRequest)}>
          <Tour covered={settings || Boolean(accessRequest)} project={project?.access ? project : null} models={models} go={go} onAddProject={addProject} onOpenSettings={() => setSettings(true)} onFinish={finishTour} />
        </div>
      ) : null}
    </div>
  );
}
