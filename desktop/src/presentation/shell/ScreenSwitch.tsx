import { useState } from "react";
import type { Project } from "../../domain/model.js";
import { Experiments } from "../experiments/Experiments.js";
import { Home } from "../home/Home.js";
import { Lineage } from "../lineage/Lineage.js";
import { Protection } from "../protection/Protection.js";
import { Samples } from "../samples/Samples.js";
import { Empty } from "../ui/Parts.js";
import { Workspace, type WorkspaceFocus } from "../workspace/Workspace.js";
import type { Screen } from "./navigation.js";

/** What the shell gives every screen. */
export interface ScreenProps {
  project: Project;
  go: (screen: Screen) => void;
  notify: (message: string) => void;
}

/** The current screen. The workspace stays mounted so its editor keeps undo history and unsaved text. */
export function ScreenSwitch(props: ScreenProps & { screen: Screen; assistant: boolean }) {
  const { screen, assistant: _assistant, ...shared } = props;
  const [, setFocus] = useState<WorkspaceFocus | null>(null);
  return (
    <>
      <div className="lab-screen" hidden={screen !== "Workspace"}>
        <Workspace {...shared} onFocus={setFocus} />
      </div>
      {screen === "Home" ? <Home {...shared} /> : null}
      {screen === "Lineage" ? <Lineage {...shared} /> : null}
      {screen === "Experiments" ? <Experiments {...shared} /> : null}
      {screen === "Samples" ? <Samples {...shared} /> : null}
      {screen === "Tasks" ? <Empty title="Tasks">Being moved here.</Empty> : null}
      {screen === "Protection" ? <Protection {...shared} /> : null}
    </>
  );
}
