import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { Agent, Mcp, Model, Project, Rag } from "../domain/model";
import { Settings, type SettingsPage } from "./Settings";

/**
 * Settings on its own, in a window of its own: what Saturn IDE's "Saturn Settings" opens, without the Agent App.
 * Changes go to the same runtime, so the Agent App and the IDE see them right away.
 */
export function SettingsWindow(props: { initialPage?: SettingsPage }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>([]);
  const [rag, setRag] = useState<Rag[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">(storedTheme);
  const [offline, setOffline] = useState(false);

  async function reload() {
    try {
      const next = await desktop.catalog.snapshot();
      setAgents(next.agents);
      setModels(next.models);
      setMcp(next.mcp);
      setRag(next.rag);
      setProjects(await desktop.projects.list().catch(() => []));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }

  useEffect(() => {
    void reload();
    // Another window (the Agent App) may change the theme.
    const onStorage = (event: StorageEvent) => {
      if (event.key === "saturn-theme" && (event.newValue === "light" || event.newValue === "dark")) setTheme(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("saturn-theme", theme);
  }, [theme]);

  return (
    <>
      {offline ? <p className="error settings-window-offline">Saturn Runtime is not running.</p> : null}
      <Settings
        standalone
        initialPage={props.initialPage}
        agents={agents}
        // No agent is selected here; per-agent tool switches live in each agent's settings.
        agent={null}
        models={models}
        mcp={mcp}
        rag={rag}
        projects={projects}
        onClose={() => window.close()}
        onChanged={reload}
        onPatchAgent={async () => undefined}
        onProfile={() => undefined}
        theme={theme}
        onSetTheme={setTheme}
      />
    </>
  );
}

function storedTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("saturn-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage blocked: follow the system.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
