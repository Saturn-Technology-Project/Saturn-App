import { useCallback, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { ASSISTANT_NAME } from "../../domain/assistant.js";
import type { Agent, Mcp, Model, Profile, Project, Rag } from "../../domain/model.js";
import { Settings } from "../settings/Settings.js";
import { messageOf } from "../ui/Parts.js";

/** Settings, given what they read. The agent they change is the assistant's. */
export function SettingsHost(props: {
  projects: Project[];
  theme: "light" | "dark";
  onSetTheme: (theme: "light" | "dark") => void;
  onClose: () => void;
  onProfile: (profile: Profile) => void;
  onProjectRemoved: () => void;
  notify: (message: string) => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>([]);
  const [rag, setRag] = useState<Rag[]>([]);
  const { notify } = props;

  const reload = useCallback(async () => {
    try {
      const [nextAgents, nextModels, nextMcp, nextRag] = await Promise.all([desktop.catalog.listAgents(), desktop.catalog.listModels(), desktop.catalog.listMcp(), desktop.catalog.listRag()]);
      setAgents(nextAgents);
      setModels(nextModels);
      setMcp(nextMcp);
      setRag(nextRag);
    } catch (error) {
      notify(messageOf(error));
    }
  }, [notify]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const assistant = agents.find((item) => item.name === ASSISTANT_NAME) ?? null;

  return (
    <Settings
      agents={agents}
      agent={assistant}
      models={models}
      mcp={mcp}
      rag={rag}
      projects={props.projects}
      onClose={props.onClose}
      onChanged={reload}
      onPatchAgent={async (patch) => {
        if (assistant) await desktop.catalog.updateAgent(assistant.id, patch);
        await reload();
      }}
      onProfile={props.onProfile}
      onProjectRemoved={props.onProjectRemoved}
      theme={props.theme}
      onSetTheme={props.onSetTheme}
    />
  );
}
