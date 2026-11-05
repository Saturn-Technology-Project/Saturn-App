import { useState } from "react";
import type { Project } from "../../domain/model.js";
import type { SampleItem } from "../../domain/research.js";
import { AssistantPanel } from "../assistant/AssistantPanel.js";
import { Environment } from "../environment/Environment.js";
import { Experiments } from "../experiments/Experiments.js";
import { Home } from "../home/Home.js";
import { Lineage } from "../lineage/Lineage.js";
import { Protection } from "../protection/Protection.js";
import { Samples } from "../samples/Samples.js";
import { Tasks } from "../tasks/Tasks.js";
import { Split } from "../ui/Split.js";
import { Workspace, type WorkspaceFocus } from "../workspace/Workspace.js";
import type { Screen } from "./navigation.js";

/** What the shell gives every screen. */
export interface ScreenProps {
  project: Project;
  go: (screen: Screen) => void;
  notify: (message: string) => void;
}

/** The current screen, with the assistant beside it when open. The workspace stays mounted so its editor keeps undo history and unsaved text. */
export function ScreenSwitch(props: ScreenProps & { screen: Screen; assistant: boolean; onOpenSettings: () => void }) {
  const { screen, assistant, onOpenSettings, ...shared } = props;
  const [workspaceFocus, setWorkspaceFocus] = useState<WorkspaceFocus | null>(null);
  const [reviewed, setReviewed] = useState<SampleItem | null>(null);
  const focus: WorkspaceFocus | null = screen === "Samples" ? { file: null, selection: null, run: null, errorOutput: "", sample: reviewed } : screen === "Workspace" ? workspaceFocus : null;
  return (
    <Split id="assistant" side="right" size={340} minimum={260} open={assistant} label="Research assistant" pane={<AssistantPanel {...shared} screen={screen} focus={focus} onOpenSettings={onOpenSettings} />}>
      <div className="lab-screen" hidden={screen !== "Workspace"}>
        <Workspace {...shared} onFocus={setWorkspaceFocus} />
      </div>
      {screen === "Home" ? <Home {...shared} /> : null}
      {screen === "Lineage" ? <Lineage {...shared} /> : null}
      {screen === "Experiments" ? <Experiments {...shared} /> : null}
      {screen === "Samples" ? <Samples {...shared} onReview={setReviewed} /> : null}
      {screen === "Tasks" ? <Tasks {...shared} onOpenSettings={onOpenSettings} /> : null}
      {screen === "Protection" ? <Protection {...shared} /> : null}
      {screen === "Environment" ? <Environment {...shared} /> : null}
    </Split>
  );
}
